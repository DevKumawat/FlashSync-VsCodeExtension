import * as vscode from "vscode";
import * as http from "http";
import { WebSocketServer } from "ws";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";

let wss: WebSocketServer | null = null;
let httpServer: http.Server | null = null;
let activePort: number | null = null;

let toggleButton: vscode.StatusBarItem;
let currentRoot: string | undefined;
let listenersRegistered = false;

const debounceTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_MS = 140;

// State machine:
// "stopped" -> server not running
// "running_editing" -> server running, live editing ON (broadcasts)
// "running_paused" -> server running, live editing OFF (no broadcasts)
type ServerState = "stopped" | "running_editing" | "running_paused";
let serverState: ServerState = "stopped";

/* ---------------------------
   Utilities
----------------------------*/
function getFreePort(start = 9090): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(start, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
    s.on("error", () => resolve(getFreePort(start + 1)));
  });
}

function mimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const map: any = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}

/* ---------------------------
   Client script (injected)
----------------------------*/
const CLIENT_SCRIPT = String.raw`
(function () {
  console.log("⚡ FlashSync client loaded");

  function loadMorphdom(cb) {
    if (window.morphdom) return cb();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/morphdom@2.7.0/dist/morphdom-umd.min.js";
    s.onload = cb;
    document.head.appendChild(s);
  }

  function getSocketURL() {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      if (s.src.includes("flashsync.js")) {
        const u = new URL(s.src);
        return (u.protocol === "https:" ? "wss://" : "ws://") + u.host + "/socket";
      }
    }
    return "ws://127.0.0.1:9090/socket";
  }

  function safePatchHTML(html) {
    if (!window.morphdom) return;
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(html, "text/html");
    window.morphdom(document.documentElement, newDoc.documentElement, {
      onBeforeElUpdated: (fromEl, toEl) => {
        if (fromEl.tagName === "SCRIPT") return false;
        return true;
      }
    });
  }

  function applyCSS(cssText) {
    let style = document.querySelector("style[data-flashsync]");
    if (!style) {
      style = document.createElement("style");
      style.setAttribute("data-flashsync", "1");
      document.head.appendChild(style);
    }
    style.textContent = cssText;
  }

  function connect() {
    const ws = new WebSocket(getSocketURL());

    ws.onopen = () => console.log("⚡ FlashSync connected");

    ws.onmessage = async (evt) => {
      try {
        let text = typeof evt.data === "string" ? evt.data :
                   evt.data instanceof Blob ? await evt.data.text() : "";
        const d = JSON.parse(text || "{}");
        const file = (d.file || "").toLowerCase();

        if (file.endsWith(".css")) {
          applyCSS(d.content || "");
          console.log("🎨 CSS updated");
        } else if (file.endsWith(".html")) {
          safePatchHTML(d.content || "");
          console.log("🚀 HTML patched");
        }
      } catch (e) {
        console.error("FlashSync client error", e);
      }
    };

    ws.onclose = () => setTimeout(connect, 800);
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  loadMorphdom(connect);
})();
`;

/* ---------------------------
   Inject helper
----------------------------*/
function injectScript(html: string, port: number) {
  if (html.includes("flashsync.js")) return html;
  const tag = `\n<script src="http://127.0.0.1:${port}/flashsync.js" defer></script>\n`;
  if (html.includes("</head>")) return html.replace("</head>", tag + "</head>");
  if (html.includes("</body>")) return html.replace("</body>", tag + "</body>");
  return html + tag;
}

/* ---------------------------
   Start server
----------------------------*/
async function startServer(root: string): Promise<number | null> {
  if (httpServer) return activePort;

  currentRoot = root;
  activePort = await getFreePort(9090);

  httpServer = http.createServer((req, res) => {
    let reqPath = req.url || "/";
    if (reqPath === "/") reqPath = "/index.html";

    if (reqPath === "/flashsync.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-store",
      });
      res.end(CLIENT_SCRIPT);
      return;
    }

    const file = path.join(root, reqPath);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 - Not found");
      return;
    }

    const mime = mimeType(file);

    // Always read HTML as UTF-8 and inject script
    if (mime.startsWith("text/html")) {
      try {
        let html = fs.readFileSync(file, "utf8");
        html = injectScript(html, activePort!);
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      } catch (e) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }
    }

    // text files
    if (mime.includes("text")) {
      const text = fs.readFileSync(file, "utf8");
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      res.end(text);
      return;
    }

    // binary
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });

  httpServer.listen(activePort, "127.0.0.1", () => {
    vscode.window.showInformationMessage(
      `FlashSync running at http://127.0.0.1:${activePort}`
    );
    // default to editing ON after starting
    serverState = "running_editing";
    updateToggleButton();
  });

  wss = new WebSocketServer({ server: httpServer, path: "/socket" });

  // ensure listeners only registered once
  if (!listenersRegistered) {
    listenersRegistered = true;

    const broadcastIfAllowed = (doc: vscode.TextDocument) => {
      if (!wss) return;
      if (serverState !== "running_editing") return; // only broadcast when editing ON

      const ext = path.extname(doc.fileName).toLowerCase();
      if (![".html", ".htm", ".css"].includes(ext)) return;

      const payload = JSON.stringify({
        file: doc.fileName,
        content: doc.getText(),
      });
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(payload);
      });
    };

    vscode.workspace.onDidChangeTextDocument(
      (e: vscode.TextDocumentChangeEvent) => {
        const key = e.document.uri.toString();
        if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key)!);
        debounceTimers.set(
          key,
          setTimeout(() => {
            broadcastIfAllowed(e.document);
            debounceTimers.delete(key);
          }, DEBOUNCE_MS)
        );
      }
    );

    vscode.workspace.onDidSaveTextDocument((doc) => {
      broadcastIfAllowed(doc);
    });
  }

  return activePort;
}

/* ---------------------------
   Stop server
----------------------------*/
function stopServer() {
  try {
    wss?.close();
  } catch (_) {}
  try {
    httpServer?.close();
  } catch (_) {}

  wss = null;
  httpServer = null;
  activePort = null;
  serverState = "stopped";
  updateToggleButton();
  vscode.window.showInformationMessage("FlashSync stopped.");
}

/* ---------------------------
   UI: Single toggle button
----------------------------*/
function initToggleButton(context: vscode.ExtensionContext) {
  toggleButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    10000
  );
  toggleButton.command = "flashsync.toggle";
  toggleButton.tooltip = "Toggle FlashSync (start / pause / resume)";
  toggleButton.show();
  context.subscriptions.push(toggleButton);
  updateToggleButton();
}

function updateToggleButton() {
  if (!toggleButton) return;

  if (serverState === "stopped") {
    toggleButton.text = "⚡ Go Live";
    toggleButton.tooltip = "Start FlashSync Live Preview";
  } else if (serverState === "running_editing") {
    toggleButton.text = "⏸ Pause Live Edit";
    toggleButton.tooltip = "Pause Live Editing (server stays running)";
  } else if (serverState === "running_paused") {
    toggleButton.text = "▶ Resume Live Edit";
    toggleButton.tooltip = "Resume Live Editing";
  }
}

/* ---------------------------
   Helper: determine which file to open
----------------------------*/
function chooseOpenPath(root: string | undefined, uri?: vscode.Uri): string {
  if (!root) return "index.html";
  // If user right-clicked a file and it is HTML -> open that
  if (uri && uri.scheme === "file") {
    const fsPath = uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();
    if ([".html", ".htm"].includes(ext) && fsPath.startsWith(root)) {
      return path.relative(root, fsPath).replace(/\\/g, "/");
    }
  }

  // Prefer active HTML editor if present
  const active = vscode.window.activeTextEditor?.document.fileName;
  if (active && active.startsWith(root)) {
    const ext = path.extname(active).toLowerCase();
    if ([".html", ".htm"].includes(ext)) {
      return path.relative(root, active).replace(/\\/g, "/");
    }
  }

  // fallback
  return "index.html";
}

/* ---------------------------
   Activation
----------------------------*/
export function activate(context: vscode.ExtensionContext) {
  // create toggle button
  initToggleButton(context);

  // Toggle command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flashsync.toggle",
      async (uri?: vscode.Uri) => {
        if (serverState === "stopped") {
          // start server and open browser
          let root =
            currentRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root) {
            // If multi-root, ask user
            if (
              vscode.workspace.workspaceFolders &&
              vscode.workspace.workspaceFolders.length > 1
            ) {
              const pick = await vscode.window.showQuickPick(
                vscode.workspace.workspaceFolders.map((f) => f.name),
                { placeHolder: "Select workspace folder to serve" }
              );
              if (!pick) return;
              const chosen = vscode.workspace.workspaceFolders.find(
                (f) => f.name === pick
              );
              if (!chosen) return;
              root = chosen.uri.fsPath;
            } else {
              vscode.window.showErrorMessage("FlashSync: open a folder first.");
              return;
            }
          }

          const port = await startServer(root);
          if (!port) return;

          const rel = chooseOpenPath(root, uri);
          vscode.env.openExternal(
            vscode.Uri.parse(`http://127.0.0.1:${port}/${rel}`)
          );
          // serverState set inside startServer (running_editing)
          updateToggleButton();
          return;
        }

        // If running & editing -> pause editing
        if (serverState === "running_editing") {
          serverState = "running_paused";
          updateToggleButton();
          vscode.window.showInformationMessage(
            "FlashSync: Live editing paused (server still running)."
          );
          return;
        }

        // If running & paused -> resume editing
        if (serverState === "running_paused") {
          serverState = "running_editing";
          updateToggleButton();
          vscode.window.showInformationMessage(
            "FlashSync: Live editing resumed."
          );
          return;
        }
      }
    )
  );

  // Stop command (explicit stop)
  context.subscriptions.push(
    vscode.commands.registerCommand("flashsync.stop", () => {
      stopServer();
    })
  );

  // Explorer context: open file with FlashSync
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flashsync.openFile",
      async (uri: vscode.Uri) => {
        // Ensure server running (starts if needed) then open that file
        let root =
          currentRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (
          !root &&
          vscode.workspace.workspaceFolders &&
          vscode.workspace.workspaceFolders.length > 1
        ) {
          const pick = await vscode.window.showQuickPick(
            vscode.workspace.workspaceFolders.map((f) => f.name),
            { placeHolder: "Select workspace folder to serve" }
          );
          if (!pick) return;
          const chosen = vscode.workspace.workspaceFolders.find(
            (f) => f.name === pick
          );
          if (!chosen) return;
          root = chosen.uri.fsPath;
        }
        if (!root) {
          vscode.window.showErrorMessage("FlashSync: open a folder first.");
          return;
        }
        const port = await startServer(root);
        if (!port) return;
        const rel = chooseOpenPath(root, uri);
        vscode.env.openExternal(
          vscode.Uri.parse(`http://127.0.0.1:${port}/${rel}`)
        );
      }
    )
  );
}

/* ---------------------------
   Deactivate
----------------------------*/
export function deactivate() {
  try {
    wss?.close();
  } catch (_) {}
  try {
    httpServer?.close();
  } catch (_) {}
  debounceTimers.forEach((t) => clearTimeout(t));
  debounceTimers.clear();
}
