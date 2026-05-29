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
        description: "Opens your browser - then paste the token here",
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
  // The local glvis server backing this panel (lazily started, killed on dispose).
  private serverPromise: Promise<string> | undefined;
  private serverProc: import("child_process").ChildProcess | undefined;

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
      this.serverProc?.kill();
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
            this.resolveDownstreamPipelines(result, msg.payload).catch(() => {});
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
            this.resolveDownstreamPipelines(result, msg.payload).catch(() => {});
          }
          break;
        }
      }
    });
  }

  // Resolves include: directives by asking the local glvis server (which calls
  // the GitLab CI lint API). All GitLab logic lives in Go now.
  private async resolveWithGitlab(payload: {
    yaml: string;
    variables: Record<string, string>;
  }): Promise<{ resolvedYaml?: string; error?: string }> {
    try {
      const base = await this.getServer();
      const res = await fetch(`${base}/api/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        return { error: await res.text() };
      }
      const data = (await res.json()) as { resolved_yaml?: string };
      return { resolvedYaml: data.resolved_yaml || payload.yaml };
    } catch (err) {
      return { error: `Failed to resolve via GitLab: ${String(err)}` };
    }
  }

  // Analyzes a pipeline by POSTing to the local glvis server.
  private async runAnalysis(payload: {
    yaml: string;
    variables: Record<string, string>;
  }): Promise<Record<string, unknown>> {
    const fail = (error: string) => ({ error, stages: [], jobs: [], edges: [] });
    try {
      const base = await this.getServer();
      const res = await fetch(`${base}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        return fail(await res.text());
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      return fail(`Failed to run analyzer: ${String(err)}`);
    }
  }

  // Resolves downstream trigger pipelines via the server's /api/downstream,
  // which returns each one already analyzed.
  private async resolveDownstreamPipelines(
    analysisResult: Record<string, unknown>,
    payload: { yaml: string; variables: Record<string, string> }
  ): Promise<void> {
    const jobs = analysisResult["jobs"] as Array<Record<string, unknown>> | undefined;
    if (!jobs?.length) return;

    const triggerJobs = jobs.filter((j) => j["trigger"] && j["enabled"]);
    if (!triggerJobs.length) return;

    const base = await this.getServer();

    await Promise.all(triggerJobs.map(async (j) => {
      const jobName = j["name"] as string;
      const trigger = j["trigger"];
      try {
        const res = await fetch(`${base}/api/downstream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trigger, variables: payload.variables }),
        });
        if (!res.ok) return;
        const pipeline = (await res.json()) as Record<string, unknown>;
        if ("error" in pipeline && pipeline["error"]) return;

        this.panel.webview.postMessage({
          type: "downstream-pipeline",
          jobName,
          pipeline,
        });
      } catch {
        // Silently skip unresolvable downstream pipelines
      }
    }));
  }

  // getServer lazily starts a `glvis` server process (once per panel) and
  // returns its base URL. The process is killed when the panel is disposed.
  private getServer(): Promise<string> {
    if (!this.serverPromise) {
      this.serverPromise = this.startServer();
    }
    return this.serverPromise;
  }

  private async startServer(): Promise<string> {
    const bin = this.resolveBinary();
    if (!bin) {
      throw new Error("glvis binary not found. Run 'npm run build-go' in the vscode directory.");
    }
    const config = await getGitlabConfig(this.context);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GLVIS_NO_BROWSER: "1",
        GLVIS_GITLAB_URL: config.url,
      };
      if (config.token) env.GLVIS_GITLAB_TOKEN = config.token;

      const proc = spawn(bin, ["--no-browser", "--addr=127.0.0.1:0"], { cwd: root, env });
      this.serverProc = proc;

      let buf = "";
      let settled = false;
      const scan = (d: Buffer) => {
        if (settled) return;
        buf += d.toString();
        // The server logs "listening on http://127.0.0.1:PORT".
        const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) {
          settled = true;
          resolve(m[0]);
        }
      };
      proc.stdout.on("data", scan);
      proc.stderr.on("data", scan);
      proc.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      proc.on("exit", (code) => {
        if (!settled) { settled = true; reject(new Error(`glvis exited before starting (code ${code})`)); }
      });
    });
  }

  private resolveBinary(): string | undefined {
    const platform = process.platform;
    const arch = process.arch;

    const key = `${platform}-${arch}`;
    const nameMap: Record<string, string> = {
      "linux-x64":    "glvis-linux-amd64",
      "linux-arm64":  "glvis-linux-arm64",
      "darwin-x64":   "glvis-darwin-amd64",
      "darwin-arm64": "glvis-darwin-arm64",
      "win32-x64":    "glvis-windows-amd64.exe",
    };

    const name = nameMap[key] ?? "glvis-linux-amd64";
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
