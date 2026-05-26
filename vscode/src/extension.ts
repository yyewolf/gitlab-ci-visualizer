import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, execSync } from "child_process";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitlab-ci-visualizer.preview", () => {
      PreviewPanel.createOrShow(context, "local");
    }),
    vscode.commands.registerCommand("gitlab-ci-visualizer.previewWithGitlab", () => {
      PreviewPanel.createOrShow(context, "gitlab");
    }),
    vscode.commands.registerCommand("gitlab-ci-visualizer.configureGitlab", async () => {
      await configureGitlabAuth(context);
    })
  );

  promptAuthIfNeeded(context);
}

async function promptAuthIfNeeded(context: vscode.ExtensionContext) {
  const token = await context.secrets.get("gitlabToken");
  if (token) return;

  const action = await vscode.window.showInformationMessage(
    "GitLab CI Visualizer: configure your GitLab token to enable pipeline resolution with includes.",
    "Configure Now",
    "Later"
  );
  if (action === "Configure Now") {
    await configureGitlabAuth(context);
  }
}

export function deactivate() {}

// ---- helpers ----

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

function detectGitlabProject(workspaceRoot?: string): string | undefined {
  if (!workspaceRoot) return undefined;
  try {
    const remote = execSync("git remote get-url origin", { cwd: workspaceRoot, timeout: 3000 })
      .toString().trim();
    // SSH: git@gitlab.com:group/project.git
    const sshMatch = remote.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    // HTTPS: https://gitlab.com/group/project.git
    const url = new URL(remote);
    const p = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return p || undefined;
  } catch {
    return undefined;
  }
}

async function getGitlabConfig(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("gitlab-ci-visualizer");
  const token = (await context.secrets.get("gitlabToken")) ?? "";
  return {
    url: (cfg.get<string>("gitlabUrl") || "https://gitlab.com").replace(/\/$/, ""),
    token,
  };
}

async function configureGitlabAuth(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("gitlab-ci-visualizer");

  // Step 1: instance URL
  const url = await vscode.window.showInputBox({
    title: "GitLab CI: Configure Authentication (1/2)",
    prompt: "GitLab instance URL",
    value: cfg.get<string>("gitlabUrl") || "https://gitlab.com",
    placeHolder: "https://gitlab.com",
  });
  if (url === undefined) return;

  const baseUrl = (url || "https://gitlab.com").replace(/\/$/, "");

  // Step 2: let the user choose how to get their token
  const action = await vscode.window.showQuickPick(
    [
      {
        label: "$(key) Enter my token",
        description: "I already have a Personal Access Token",
        openBrowser: false,
      },
      {
        label: "$(link-external) Create a token on GitLab",
        description: "Opens your browser — then paste the token here",
        openBrowser: true,
      },
    ],
    {
      title: "GitLab CI: Configure Authentication (2/2)",
      placeHolder: "How would you like to provide your Personal Access Token?",
    }
  );
  if (!action) return;

  if (action.openBrowser) {
    const tokenPageUrl = `${baseUrl}/-/user_settings/personal_access_tokens` +
      `?name=GitLab+CI+Visualizer&scopes=api`;
    await vscode.env.openExternal(vscode.Uri.parse(tokenPageUrl));
  }

  const token = await vscode.window.showInputBox({
    title: "GitLab CI: Configure Authentication (2/2)",
    prompt: 'Paste your Personal Access Token (needs "api" scope; Developer role required for pipeline resolution)',
    password: true,
    placeHolder: "glpat-xxxxxxxxxxxxxxxxxxxx",
  });
  if (token === undefined) return;

  await cfg.update("gitlabUrl", baseUrl, vscode.ConfigurationTarget.Global);
  if (token) {
    await context.secrets.store("gitlabToken", token);
  }

  vscode.window.showInformationMessage("GitLab CI Visualizer: authentication configured.");
}

// ---- webview panel ----

type AnalyzeMode = "local" | "gitlab";

class PreviewPanel {
  static currentPanel: PreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  // YAML captured at command-invocation time, before the webview steals focus.
  private pendingYaml: string | undefined;
  private watchedUri: vscode.Uri | undefined;
  private fileWatcher: vscode.Disposable | undefined;
  private mode: AnalyzeMode;

  static createOrShow(context: vscode.ExtensionContext, mode: AnalyzeMode = "local") {
    // Capture NOW - activeTextEditor becomes undefined once the webview takes focus.
    const editor = vscode.window.activeTextEditor;
    const yaml = editor?.document.getText();
    const uri = editor?.document.uri;
    const column = editor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel.mode = mode;
      PreviewPanel.currentPanel.panel.reveal(column);
      if (yaml && uri) {
        PreviewPanel.currentPanel.watchedUri = uri;
        PreviewPanel.currentPanel.panel.webview.postMessage({
          type: "yaml",
          data: yaml,
          branch: getCurrentBranch(),
          useGitlab: mode === "gitlab",
        });
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

    PreviewPanel.currentPanel = new PreviewPanel(panel, context, yaml, uri, mode);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    initialYaml: string | undefined,
    initialUri: vscode.Uri | undefined,
    mode: AnalyzeMode
  ) {
    this.panel = panel;
    this.context = context;
    this.pendingYaml = initialYaml;
    this.watchedUri = initialUri;
    this.mode = mode;

    this.update();

    this.panel.onDidDispose(() => {
      PreviewPanel.currentPanel = undefined;
      this.fileWatcher?.dispose();
    });

    this.fileWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.watchedUri && doc.uri.toString() === this.watchedUri.toString()) {
        // Preserve user's branch/tag/variable params, but re-use last mode.
        this.panel.webview.postMessage({
          type: "yaml",
          data: doc.getText(),
          useGitlab: this.mode === "gitlab",
        });
      }
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          if (this.pendingYaml) {
            this.panel.webview.postMessage({
              type: "yaml",
              data: this.pendingYaml,
              branch: getCurrentBranch(),
              useGitlab: this.mode === "gitlab",
            });
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

        case "analyze-with-gitlab": {
          const resolved = await this.resolveWithGitlab(msg.payload);
          if (resolved.error) {
            this.panel.webview.postMessage({ type: "error", data: resolved.error });
            break;
          }
          const result = await this.runAnalysis({ ...msg.payload, yaml: resolved.resolvedYaml! });
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

  private async resolveWithGitlab(payload: {
    yaml: string;
    variables: Record<string, string>;
  }): Promise<{ resolvedYaml?: string; error?: string }> {
    const config = await getGitlabConfig(this.context);

    if (!config.token) {
      return {
        error:
          "No GitLab token configured.\n\nRun the command \"GitLab CI: Configure Authentication\" (Ctrl+Shift+P) to set your Personal Access Token.",
      };
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const project = detectGitlabProject(root);
    const ref = payload.variables["CI_COMMIT_BRANCH"] || "main";
    const baseUrl = config.url;

    let apiUrl: string;
    let requestBody: Record<string, unknown>;

    if (project) {
      apiUrl = `${baseUrl}/api/v4/projects/${encodeURIComponent(project)}/ci/lint`;
      requestBody = { content: payload.yaml, dry_run: true, ref };
    } else {
      // No project: fall back to global lint (validates syntax but won't resolve includes)
      apiUrl = `${baseUrl}/api/v4/ci/lint`;
      requestBody = { content: payload.yaml };
    }

    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": config.token,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      return { error: `Failed to reach GitLab at ${baseUrl}: ${String(err)}` };
    }

    if (response.status === 401) {
      return {
        error:
          "Unauthorized (HTTP 401): your GitLab Personal Access Token is invalid or expired.\n\nRun \"GitLab CI: Configure Authentication\" to update it.",
      };
    }
    if (response.status === 403) {
      return {
        error:
          "Forbidden (HTTP 403): you need at least Developer access on the GitLab project to resolve the pipeline.\n\nCheck your role on the project or use the plain \"Preview\" button for local-only analysis.",
      };
    }
    if (response.status === 404) {
      return {
        error: `Project not found (HTTP 404): "${project}".\n\nCheck the gitlab-ci-visualizer.gitlabProject setting, or ensure the git remote points to the correct GitLab project.`,
      };
    }
    if (!response.ok) {
      const text = await response.text();
      return { error: `GitLab API error (HTTP ${response.status}):\n${text}` };
    }

    const data = (await response.json()) as {
      valid: boolean;
      errors?: string[];
      warnings?: string[];
      merged_yaml?: string;
    };

    if (!data.valid && data.errors?.length) {
      return { error: `GitLab validation errors:\n${data.errors.join("\n")}` };
    }

    return { resolvedYaml: data.merged_yaml || payload.yaml };
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
    const bundled = path.join(this.context.extensionUri.fsPath, "bin", name);
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
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const indexPath = path.join(this.context.extensionUri.fsPath, "media", "index.html");

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
