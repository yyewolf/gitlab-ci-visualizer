"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand("gitlab-ci-visualizer.preview", () => {
        PreviewPanel.createOrShow(context);
    }));
}
function deactivate() { }
function getCurrentBranch() {
    const root = vscode.window.activeTextEditor
        ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root)
        return undefined;
    try {
        return (0, child_process_1.execSync)("git rev-parse --abbrev-ref HEAD", { cwd: root, timeout: 3000 }).toString().trim();
    }
    catch {
        return undefined;
    }
}
// ---- webview panel ----
class PreviewPanel {
    static createOrShow(context) {
        // Capture NOW - activeTextEditor becomes undefined once the webview takes focus.
        const yaml = vscode.window.activeTextEditor?.document.getText();
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;
        if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel.panel.reveal(column);
            if (yaml) {
                PreviewPanel.currentPanel.panel.webview.postMessage({ type: "yaml", data: yaml, branch: getCurrentBranch() });
            }
            return;
        }
        const panel = vscode.window.createWebviewPanel("gitlabCiVisualizer", "GitLab CI Preview", column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "media"),
            ],
        });
        PreviewPanel.currentPanel = new PreviewPanel(panel, context.extensionUri, yaml);
    }
    constructor(panel, extensionUri, initialYaml) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.pendingYaml = initialYaml;
        this.update();
        this.panel.onDidDispose(() => {
            PreviewPanel.currentPanel = undefined;
        });
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "ready":
                    if (this.pendingYaml) {
                        this.panel.webview.postMessage({ type: "yaml", data: this.pendingYaml, branch: getCurrentBranch() });
                        this.pendingYaml = undefined;
                    }
                    break;
                case "analyze": {
                    const result = await this.runAnalysis(msg.payload);
                    if ("error" in result && result.error) {
                        this.panel.webview.postMessage({ type: "error", data: result.error });
                    }
                    else {
                        this.panel.webview.postMessage({ type: "pipeline", data: result });
                    }
                    break;
                }
            }
        });
    }
    async runAnalysis(payload) {
        return new Promise((resolve) => {
            const bin = this.resolveBinary();
            if (!bin) {
                resolve({
                    error: "GitLab CI analyzer binary not found. Run 'npm run build-go' in the vscode directory.",
                    stages: [],
                    jobs: [],
                    edges: [],
                });
                return;
            }
            const proc = (0, child_process_1.spawn)(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            proc.stdout.on("data", (d) => { stdout += d.toString(); });
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
            proc.on("error", (err) => {
                resolve({
                    error: `Failed to start analyzer: ${err.message}`,
                    stages: [],
                    jobs: [],
                    edges: [],
                });
            });
            proc.on("close", (code) => {
                if (code !== 0) {
                    resolve({
                        error: stderr || `Analyzer exited with code ${code}`,
                        stages: [],
                        jobs: [],
                        edges: [],
                    });
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                }
                catch {
                    resolve({
                        error: "Failed to parse analyzer output",
                        stages: [],
                        jobs: [],
                        edges: [],
                    });
                }
            });
            proc.stdin.write(JSON.stringify(payload));
            proc.stdin.end();
        });
    }
    resolveBinary() {
        const platform = process.platform;
        const arch = process.arch;
        const key = `${platform}-${arch}`;
        const nameMap = {
            "linux-x64": "gitlab-ci-analyzer-linux-amd64",
            "linux-arm64": "gitlab-ci-analyzer-linux-arm64",
            "darwin-x64": "gitlab-ci-analyzer-darwin-amd64",
            "darwin-arm64": "gitlab-ci-analyzer-darwin-arm64",
            "win32-x64": "gitlab-ci-analyzer-windows-amd64.exe",
        };
        const name = nameMap[key] ?? "gitlab-ci-analyzer-linux-amd64";
        const bundled = path.join(this.extensionUri.fsPath, "bin", name);
        if (fs.existsSync(bundled)) {
            return bundled;
        }
        return undefined;
    }
    update() {
        this.panel.webview.html = this.buildHtml();
    }
    buildHtml() {
        const webview = this.panel.webview;
        const mediaDir = vscode.Uri.joinPath(this.extensionUri, "media");
        const indexPath = path.join(this.extensionUri.fsPath, "media", "index.html");
        if (!fs.existsSync(indexPath)) {
            return `<!DOCTYPE html><html><body style="background:#09090b;color:#a1a1aa;font-family:sans-serif;padding:2rem">
        <p>Web assets not found.</p>
        <p>Run <code>npm run build</code> in the <code>vscode/</code> directory first.</p>
      </body></html>`;
        }
        let html = fs.readFileSync(indexPath, "utf-8");
        // Rewrite asset src/href to webview URIs. Vite with base './' produces './assets/...'
        html = html.replace(/(src|href)="(\.\/[^"]+)"/g, (_, attr, relPath) => {
            const uri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, relPath.replace(/^\.\//, "")));
            return `${attr}="${uri}"`;
        });
        // Inject Content-Security-Policy
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data: blob:`,
            `font-src ${webview.cspSource}`,
        ].join("; ");
        html = html.replace(/(<head[^>]*>)/i, `$1\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
        return html;
    }
}
//# sourceMappingURL=extension.js.map