import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, execSync } from "child_process";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitlab-ci-visualizer.preview", () => {
      PreviewPanel.createOrShow(context);
    })
  );
}

export function deactivate() {}

function getCurrentBranch(): string | undefined {
  const root =
    vscode.window.activeTextEditor
      ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, timeout: 3000 }).toString().trim();
  } catch {
    return undefined;
  }
}

// ---- webview panel ----

class PreviewPanel {
  static currentPanel: PreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  // YAML captured at command-invocation time, before the webview steals focus.
  private pendingYaml: string | undefined;
  private watchedUri: vscode.Uri | undefined;
  private fileWatcher: vscode.Disposable | undefined;

  static createOrShow(context: vscode.ExtensionContext) {
    // Capture NOW - activeTextEditor becomes undefined once the webview takes focus.
    const editor = vscode.window.activeTextEditor;
    const yaml = editor?.document.getText();
    const uri = editor?.document.uri;
    const column = editor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel.panel.reveal(column);
      if (yaml && uri) {
        PreviewPanel.currentPanel.watchedUri = uri;
        PreviewPanel.currentPanel.panel.webview.postMessage({ type: "yaml", data: yaml, branch: getCurrentBranch() });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "gitlabCiVisualizer",
      "GitLab CI Preview",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      }
    );

    PreviewPanel.currentPanel = new PreviewPanel(panel, context.extensionUri, yaml, uri);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    initialYaml: string | undefined,
    initialUri: vscode.Uri | undefined
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.pendingYaml = initialYaml;
    this.watchedUri = initialUri;

    this.update();

    this.panel.onDidDispose(() => {
      PreviewPanel.currentPanel = undefined;
      this.fileWatcher?.dispose();
    });

    this.fileWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.watchedUri && doc.uri.toString() === this.watchedUri.toString()) {
        // No branch field: keeps the user's existing branch/tag/variable params.
        this.panel.webview.postMessage({ type: "yaml", data: doc.getText() });
      }
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
          } else {
            this.panel.webview.postMessage({ type: "pipeline", data: result });
          }
          break;
        }
      }
    });
  }

  private async runAnalysis(payload: {
    yaml: string;
    variables: Record<string, string>;
  }): Promise<Record<string, unknown>> {
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

      const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

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
        } catch {
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

  private resolveBinary(): string | undefined {
    const platform = process.platform;
    const arch = process.arch;

    const key = `${platform}-${arch}`;
    const nameMap: Record<string, string> = {
      "linux-x64":    "gitlab-ci-analyzer-linux-amd64",
      "linux-arm64":  "gitlab-ci-analyzer-linux-arm64",
      "darwin-x64":   "gitlab-ci-analyzer-darwin-amd64",
      "darwin-arm64": "gitlab-ci-analyzer-darwin-arm64",
      "win32-x64":    "gitlab-ci-analyzer-windows-amd64.exe",
    };

    const name = nameMap[key] ?? "gitlab-ci-analyzer-linux-amd64";
    const bundled = path.join(this.extensionUri.fsPath, "bin", name);
    if (fs.existsSync(bundled)) {
      return bundled;
    }

    return undefined;
  }

  private update() {
    this.panel.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
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
      const uri = webview.asWebviewUri(
        vscode.Uri.joinPath(mediaDir, relPath.replace(/^\.\//, ""))
      );
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

    html = html.replace(
      /(<head[^>]*>)/i,
      `$1\n<meta http-equiv="Content-Security-Policy" content="${csp}">`
    );

    return html;
  }
}
