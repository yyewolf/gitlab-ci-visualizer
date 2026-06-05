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


// getWorkspaceRoot returns the filesystem path for the active editor’s workspace
// folder, or the first open workspace folder.
function getWorkspaceRoot(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// detectInstanceFromWorkspace reads `git remote get-url origin` and parses the
// GitLab instance base URL, mirroring the Go-side DetectInstanceFromDir logic.
function detectInstanceFromWorkspace(): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  try {
    const remote = execSync("git remote get-url origin", { cwd: root, timeout: 3000 }).toString().trim();
    if (!remote) return undefined;

    // git@host:group/project(.git) → https://host
    const sshRe = /^git@[^:]+:(.+?)(?:\.git)?$/;
    if (sshRe.test(remote)) {
      const at = remote.indexOf("@");
      const colon = remote.indexOf(":");
      if (at >= 0 && colon > at) {
        return "https://" + remote.slice(at + 1, colon);
      }
      return undefined;
    }

    // ssh://git@host:path or ssh://host:path → https://host (strip SSH port,
    // API is always on HTTPS port 443).
    const sshProtoRe = /^ssh:\/\//i;
    if (sshProtoRe.test(remote)) {
      try {
        const u = new URL(remote);
        if (u.hostname) {
          return "https://" + u.hostname;
        }
      } catch {
        // malformed ssh:// URL — fall through to generic parser
      }
    }

    // https://host/group/project(.git) or https://token@host/group/project(.git)
    let urlStr = remote;
    try {
      const u = new URL(remote);
      // Strip userinfo if present (e.g. token in URL)
      urlStr = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      // Not a valid URL, try the raw string best-effort
    }
    try {
      const u = new URL(urlStr);
      if (!u.host) return undefined;
      let path = u.pathname;
      if (path === "/") path = "";
      // The instance URL is scheme://host (no path)
      return `${u.protocol}//${u.host}`;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

// getInstanceUrl returns the effective GitLab instance URL for the current
// context (workspace remote beats global setting).
function getInstanceUrl(): string {
  const detected = detectInstanceFromWorkspace();
  if (detected) return detected;
  const cfg = vscode.workspace.getConfiguration("gitlab-ci-visualizer");
  return (cfg.get<string>("gitlabUrl") || "https://gitlab.com").replace(/\/$/, "");
}

// getEffectiveCredentials tries VSCode SecretStorage first (most reliable in
// sandboxed contexts like VSCode on macOS). Only falls back to the OS
// keychain when no fallback is present.
async function getEffectiveCredentials(context: vscode.ExtensionContext): Promise<{ url: string; token: string } | null> {
  const url = getInstanceUrl();

  // 1. VSCode SecretStorage is the most reliable source in sandboxed contexts.
  const token = await context.secrets.get(`glvis:token:${url}`);
  if (token) {
    return { url, token };
  }

  // 2. Fallback: let the server read from the shared keychain natively.
  try {
    const res = await runGlvis(context, ["auth", "status", "--instance", url]);
    if (res.code === 0) {
      return null; // Keychain works; server will read it natively.
    }
  } catch {
    // glvis binary not found
  }

  return null;
}

async function promptAuthIfNeeded(context: vscode.ExtensionContext) {
  const url = getInstanceUrl();

  // 1. Check VSCode SecretStorage first (most reliable in sandboxed contexts).
  const secretFallback = await context.secrets.get(`glvis:token:${url}`);
  if (secretFallback) return; // fallback present, server will inject it later

  // 2. Check the OS keychain as secondary source.
  try {
    const res = await runGlvis(context, ["auth", "status", "--instance", url]);
    if (res.code === 0) return; // already configured for this instance
  } catch {
    return; // binary missing - don't nag
  }

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

// resolveBinary returns the path to the bundled glvis binary for this platform.
function resolveBinary(context: vscode.ExtensionContext): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const nameMap: Record<string, string> = {
    "linux-x64":    "glvis-linux-amd64",
    "linux-arm64":  "glvis-linux-arm64",
    "darwin-x64":   "glvis-darwin-amd64",
    "darwin-arm64": "glvis-darwin-arm64",
    "win32-x64":    "glvis-windows-amd64.exe",
  };
  const name = nameMap[key] ?? "glvis-linux-amd64";
  const bundled = path.join(context.extensionUri.fsPath, "bin", name);
  return fs.existsSync(bundled) ? bundled : undefined;
}

interface GlvisResult {
  code: number;
  stdout: string;
  stderr: string;
}

// runGlvis runs the bundled glvis CLI to completion, optionally piping stdin.
// Used for credential management (login / auth status) so the CLI owns the
// token store — keychain with file fallback, keyed by instance.
function runGlvis(
  context: vscode.ExtensionContext,
  args: string[],
  stdinData?: string
): Promise<GlvisResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveBinary(context);
    if (!bin) {
      reject(new Error("glvis binary not found. Run 'npm run build-go' in the vscode directory."));
      return;
    }
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code: number | null) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdinData !== undefined) proc.stdin.write(stdinData);
    proc.stdin.end();
  });
}

async function configureGitlabAuth(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("gitlab-ci-visualizer");

  // Default to the workspace-detected instance (via git remote), falling back
  // to the globally configured default so multi-instance setups behave
  // correctly per-project.
  const detected = getInstanceUrl();

  // Step 1: instance URL
  const url = await vscode.window.showInputBox({
    title: "GitLab CI: Configure Authentication (1/2)",
    prompt: "GitLab instance URL",
    value: detected,
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

  // Remember the instance as the default for next time.
  await cfg.update("gitlabUrl", baseUrl, vscode.ConfigurationTarget.Global);
  if (!token) return;

  // Store via the CLI so the keychain-backed, multi-instance store is the single
  // source of truth (shared with `glvis` runs from the terminal).
  try {
    const res = await runGlvis(context, ["login", "--instance", baseUrl, "--stdin"], token);
    if (res.code !== 0) {
      vscode.window.showErrorMessage(
        `GitLab login failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`
      );
      return;
    }

    // Store a fallback in VSCode's SecretStorage so sandboxed extension hosts
    // (e.g. VSCode on macOS) can still authenticate the spawned server process.
    // The key is the *exact* instance URL that login succeeded for, so
    // multi-instance setups work even when the keychain is locked.
    await context.secrets.store(`glvis:token:${baseUrl}`, token);

    vscode.window.showInformationMessage(
      `GitLab CI Visualizer: ${res.stdout.trim() || "authentication configured."}`
    );

    // If a server is already running it is using the old (or no) credentials.
    // Kill it so the next panel spawns a fresh process with the new env vars.
    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel.killServer();
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to run glvis login: ${String(err)}`);
  }
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

  // killServer stops any running glvis process so the next getServer() call
  // spawns a fresh instance. Used after credential changes.
  killServer() {
    if (this.serverProc) {
      this.serverProc.kill();
      this.serverProc = undefined;
    }
    this.serverPromise = undefined;
  }

  private async startServer(): Promise<string> {
    const bin = resolveBinary(this.context);
    if (!bin) {
      throw new Error("glvis binary not found. Run 'npm run build-go' in the vscode directory.");
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Detect whether the native keychain works in this VSCode context.
    // If not, inject the token via env vars so the spawned server can use it.
    const creds = await getEffectiveCredentials(this.context);

    return new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GLVIS_NO_BROWSER: "1",
      };
      if (creds) {
        env.GLVIS_GITLAB_URL = creds.url;
        env.GLVIS_GITLAB_TOKEN = creds.token;
      }

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
