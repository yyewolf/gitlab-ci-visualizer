# PLAN-CLI — `glvis` CLI

> **Working agreement (read this first):** Whenever a design decision is made or
> changed while working on the CLI — library choices, command shapes, storage
> formats, fallbacks, anything non-obvious — record it in the **Decisions log**
> at the bottom of this file with the date and a one-line rationale. Update or
> supersede stale entries rather than deleting context. This file is the source
> of truth for the CLI's design.

## Goal

Ship a first-class CLI binary `glvis` that:

- `glvis` — start the local server, find and analyze `.gitlab-ci.yml` in the
  CWD if present, open the browser to the running page.
- `glvis --file=<path>` — use an explicit file instead of CWD autodetection.
- `glvis login` — interactive auth flow (charmbracelet): prompt for GitLab
  instance URL and a Personal Access Token, store it in the OS keychain when
  available, otherwise fall back (with a warning) to a file under
  `~/.config/glvis`.

Behavioral requirements:

- The server always tries to bind a **random free port** (`:0`) so we never
  collide with a fixed port. The chosen port is read back from the listener.
- After binding, **open the browser** to the served page.
- The existing stdin/stdout JSON protocol (used by the VSCode extension) must
  keep working unchanged.

## Current state (baseline)

- [main.go](main.go) is a flat `package main` with `flag`-based dispatch:
  - no flags → read `gitlabci.Input` JSON from stdin, write `Output` to stdout.
  - `-serve <addr>` → run HTTP server (embeds `web/dist` + `samples`).
- Analysis lives in [internal/gitlabci/](internal/gitlabci/);
  `gitlabci.Analyze(Input) (Output, error)`. `Input{ YAML, Variables }`.
- Frontend [web/src/App.tsx](web/src/App.tsx) gets its YAML either from VSCode
  webview messages (`type: "yaml"`) or from manual paste; it POSTs to
  `/api/analyze`. There is **no** current path for the server to hand the
  frontend an initial local file — this is the gap the CLI must close.

## Convergence with the VSCode extension (decided)

The VSCode extension collapses onto the CLI: it becomes a **thin launcher**.
All behavior lives in the Go server; the extension launches `glvis`, iframes the
served UI, and passes context per-launch. This kills both kinds of divergence —
duplicated GitLab logic **and** separately-bundled webview assets.

Today the extension reimplements GitLab logic in TypeScript:

- `include:` resolution via CI lint API ([extension.ts:286-290](vscode/src/extension.ts#L286-L290))
- raw-file fetch + downstream pipeline resolution ([extension.ts:418-458](vscode/src/extension.ts#L418-L458))
- token in VSCode SecretStorage ([extension.ts:130](vscode/src/extension.ts#L130))
- webview assets bundled in `vscode/media/` (a copy of `web/dist`)

Target end state:

- **Go server owns everything**: `/api/analyze`, plus new `/api/resolve`
  (include resolution via CI lint) and `/api/downstream` (downstream pipeline
  resolution). Port the TS GitLab logic into a new `internal/gitlab` package.
- **Extension = launcher**: on command, spawn `glvis serve --no-browser` on a
  random port, capture the printed URL, and load it in the webview via an
  iframe (`vscode.env.asExternalUri` + webview `portMapping`). The captured
  file path, git branch, and GitLab token are handed to the server per-launch
  (init endpoint / query param) — no `glvis login` needed inside VSCode; the
  token still comes from VSCode SecretStorage and is passed to the spawned
  process (env var, not argv).
- **One UI**: the webview loads `web/dist` *from the Go server*, so
  `vscode/media/` and per-extension asset bundling go away. The extension keeps
  only the platform binary.
- The stdin/stdout JSON protocol can be **retired** once the extension launches
  the server instead of spawning the analyzer per-call. Keep `--stdio` only if
  we still want a scriptable one-shot mode; otherwise drop it.

## Architecture

Migrate to cobra. Server-centric; stdin/stdout retired in favor of the launcher.

```
main.go                       // thin: cmd.Execute()
internal/cli/
  root.go                     // root cmd: serve + analyze CWD file, --file flag
  login.go                    // login subcommand (charm form)
internal/server/
  server.go                   // HTTP server, moved out of main.go
internal/gitlab/
  client.go                   // CI lint (include resolution), raw file fetch,
                              // downstream pipeline resolution (ported from TS)
internal/auth/
  store.go                    // keychain w/ file fallback, load/save creds
```

### Command dispatch

- Root command runs the server flow and (if found) analyzes the CWD
  `.gitlab-ci.yml` or `--file`.
- `glvis login` is a normal subcommand.
- No stdin sniffing. The stdin/stdout one-shot protocol is retired now that the
  extension launches the server; revisit only if a scriptable one-shot is
  requested.

### Server changes

- `runServer` moves to `internal/server`. Signature becomes
  `Serve(ctx, opts)` where opts carries the listen addr (`:0`), the initial
  file path, and resolved auth (instance + token, optional).
- Bind with `net.Listen("tcp", "127.0.0.1:0")`, read
  `ln.Addr().(*net.TCPAddr).Port`, log the URL, then `http.Serve(ln, mux)`.
- New endpoint `GET /api/initial` returns `{ yaml, branch, file }` for the
  autodetected/`--file` file so the frontend can self-load. Branch is read from
  git (`git rev-parse --abbrev-ref HEAD`) best-effort.
- New endpoints `POST /api/resolve` (include resolution via CI lint) and
  `POST /api/downstream` (downstream pipeline resolution), backed by
  `internal/gitlab` — the Go port of the extension's TypeScript logic. These
  are required now (not follow-up) because the extension is a thin client.
- Frontend: on mount, fetch `/api/initial`; if it returns YAML, seed
  `conditions.yaml`/`branch` and auto-analyze. The VSCode message path can be
  dropped once the webview loads from the server (it's the same origin now).
- GitLab token source: `glvis login` (keychain/file) for standalone use, OR a
  per-launch token handed by the extension via env var. Server holds it in
  memory for `/api/resolve` + `/api/downstream`.

### Browser opening

Small cross-platform helper (`open`/`xdg-open`/`rundll32 url.dll`), no heavy dep.
Skip if `--no-browser` is passed or `$GLVIS_NO_BROWSER` is set (useful for CI).

### Auth storage (`internal/auth`)

- Credentials: `{ instance string, token string }`, keyed by instance host.
- Keychain via **zalando/go-keyring** (cross-platform: macOS Keychain, Linux
  Secret Service / libsecret, Windows Credential Manager). See Decisions log for
  why not keybase/go-keychain.
- Fallback when keyring is unavailable: write `~/.config/glvis/credentials.json`
  with `0600` perms and print a clear warning that the token is stored in
  plaintext on disk.
- `login.go`: charmbracelet **huh** form — input for instance URL (default
  `https://gitlab.com`), masked input for PAT. Optionally validate the token
  with a `GET /api/v4/user` call before storing.

## Dependencies to add

- `github.com/spf13/cobra`
- `github.com/charmbracelet/huh` (forms; pulls bubbletea/lipgloss)
- `github.com/zalando/go-keyring`

## Implementation steps

1. ✅ Add cobra; move server out of main.go into `internal/server`. Drop the
   stdin/stdout one-shot path.
2. ✅ Random-port listener + browser open + `/api/initial` endpoint.
3. ✅ Port the extension's TS GitLab logic into `internal/gitlab`; expose
   `POST /api/resolve` and `POST /api/downstream`.
4. ✅ Frontend: fetch `/api/initial` on load and auto-analyze; route include /
   downstream calls through the new server endpoints (standalone mode).
5. ✅ `internal/auth` store (keyring + file fallback) with tests.
6. ✅ `glvis login` huh form + token validation (GET /api/v4/user).
7. ✅ Rework the VSCode extension to be server-backed: spawn
   `glvis --no-browser --addr=127.0.0.1:0`, parse the port from its log output,
   and call the Go endpoints for analyze/resolve/downstream instead of the TS
   implementations. Bundled webview + postMessage UI kept.
8. ✅ Update README. Rename binary to `glvis` in `.goreleaser.yaml`, the
   extension `build-go`/`package-all.sh` scripts, and `resolveBinary`.

## Open questions

- Webview→localhost: confirm `asExternalUri` + webview `portMapping` cleanly
  loads the Go server in an iframe under the VSCode webview CSP. Prototype early
  — this is the riskiest assumption of the thin-launcher approach.
- Extension lifecycle: one server process per panel, or one shared server for
  the window? Proposed: one per panel, killed on dispose.
- Should `glvis` watch the file for changes and push re-analysis (websocket/SSE),
  matching the VSCode live-regen UX? Proposed as a follow-up.
- Binary rename `gitlab-ci-visualizer` → `glvis`: confirm VSCode bundling and
  goreleaser asset names are updated together.

## Decisions log

- **2026-05-29** — Use cobra for command structure; `glvis` (root) serves,
  `glvis login` for auth. _Rationale: user request; clean subcommand growth._
- **2026-05-29** — ~~Keep the VSCode stdin/stdout JSON protocol behind a hidden
  `--stdio` flag.~~ **Superseded same day** (see thin-launcher decision below):
  the stdin/stdout one-shot protocol is retired; the extension launches the
  server instead.
- **2026-05-29** — ~~VSCode extension becomes a thin launcher that iframes the
  served UI.~~ **Superseded same day:** chose **server-backed messaging** instead
  to de-risk the webview→localhost CSP/iframe unknown. The extension keeps its
  bundled webview + postMessage UI, but spawns/talks to the Go server over HTTP
  for analyze + GitLab logic rather than doing it in TypeScript. _Rationale:
  kills the logic divergence (the thing that actually hurts) without betting on
  `asExternalUri`+`portMapping` iframe behavior. Webview asset bundling stays for
  now; can revisit unifying it later._
- **2026-05-29** — Port the extension's TypeScript GitLab logic (CI lint include
  resolution, raw file fetch, downstream resolution) into a Go `internal/gitlab`
  package exposed as `/api/resolve` + `/api/downstream`. _Rationale: single
  source of truth shared by CLI and extension._
- **2026-05-29** — Extension passes the GitLab token to the spawned server via
  **env var, not argv** (argv is visible in process listings). Token still
  originates from VSCode SecretStorage; `glvis login` is for standalone use.
  _Rationale: avoid leaking secrets through the process table._
- **2026-05-29** — Keychain library: **zalando/go-keyring**, not
  keybase/go-keychain. _Rationale: user said "go-keychain" but keybase's lib is
  macOS-only; go-keyring is cross-platform (macOS/Linux/Windows) which the rest
  of the project targets. Revisit if a hard dep on macOS-only behavior appears._
- **2026-05-29** — File fallback at `~/.config/glvis/credentials.json`, mode
  `0600`, with a printed plaintext-storage warning. _Rationale: user spec._
- **2026-05-29** — Random port via `net.Listen(":0")`, read back actual port,
  then open browser. `--no-browser`/`$GLVIS_NO_BROWSER` escape hatch.
  _Rationale: user spec + CI ergonomics._
- **2026-05-29** — New `GET /api/initial` endpoint + frontend self-load to feed
  the autodetected/`--file` YAML into the web UI outside VSCode. _Rationale:
  closes the only gap between CLI and existing web flow._
- **2026-05-29** — `/api/downstream` returns the **already-analyzed** pipeline
  (server resolves downstream YAML then runs `gitlabci.Analyze`), not just the
  merged YAML. _Rationale: matches what the frontend renders; keeps the
  resolve+analyze orchestration server-side, mirroring the old TS flow._
- **2026-05-29** — `gitlabConfig` precedence: `GLVIS_GITLAB_TOKEN`/`_URL` env
  vars win over the stored credentials from `glvis login`. _Rationale: env is
  how the (server-backed) extension hands a per-launch token to the spawned
  server without touching the user's keychain entry._
- **2026-05-29** — File-fallback credential store is a JSON **map keyed by
  instance** (`credentials.json`), so multiple instances coexist. _Rationale:
  users may target gitlab.com + a self-hosted instance._
- **2026-05-29** — Server `Serve` takes a `started(url)` callback fired once the
  listener is bound, so the CLI opens the browser on the actual random port.
  _Rationale: port is only known after bind._
- **2026-05-29** — **Auto-GitLab-resolution.** The GitLab instance is derived
  from the repo's `origin` remote (`gitlab.DetectInstance`), and credentials are
  loaded for *that* instance (not a hardcoded gitlab.com). `/api/initial` returns
  `gitlab_available` (token configured AND project detectable); the frontend
  defaults to GitLab-resolved analysis when true. _Rationale: user wants
  includes to resolve automatically when analyzing a CI in a repo whose instance
  they're logged into — no extra click. Env `GLVIS_GITLAB_TOKEN` still overrides
  for the extension's per-launch case._
- **2026-05-29** — Extension discovers the server port by **parsing the
  `listening on http://127.0.0.1:PORT` log line** from the spawned process's
  stdout/stderr (server binds `:0`). _Rationale: simplest contract; no extra IPC
  or fixed port. If the log format changes, update the regex in `startServer`._
- **2026-05-29** — **One server process per panel**, killed on
  `panel.onDidDispose`. Token/URL are read from VSCode config + SecretStorage at
  spawn time and passed via env. _Caveat: reconfiguring the GitLab token doesn't
  affect a panel already open — reopen the preview to pick it up._
- **2026-05-29** — Binary renamed `gitlab-ci-visualizer` → `glvis`. goreleaser
  `project_name` (release/archive naming) kept as `gitlab-ci-visualizer`; only
  the `builds.binary` is `glvis`. Extension bundles `glvis-<os>-<arch>`.
  _Rationale: don't churn release asset names; the user-facing command is
  `glvis`._
- **2026-05-29** — **Extension uses the CLI's credential store, not VSCode
  SecretStorage.** "Configure Authentication" pipes the token to
  `glvis login --instance <url> --stdin`; the nudge checks `glvis auth status
  --instance <url>` (exit 0 = configured). _Rationale: one keychain-backed,
  multi-instance store shared between the CLI and the extension — no divergent
  secret silos._
- **2026-05-29** — **Extension no longer passes a token/URL when spawning the
  server.** The server detects the instance from the repo's `origin` remote and
  loads the matching credentials from the store, so different repos resolve
  against different GitLab instances automatically. `gitlabConfig` honors an
  explicit `GLVIS_GITLAB_URL` override for store lookup (used by neither the
  extension nor the CLI by default, but available). _Rationale: true
  multi-instance support falls out of git-remote detection + the shared store._
- **2026-05-29** — Added non-interactive `glvis login --instance X --stdin`
  (token from stdin, not argv → not visible in the process table) and a script-
  friendly `glvis auth status --instance X`. _Rationale: the extension drives
  these programmatically._
- **2026-05-29** — Loading indicator is a small spinner chip overlaid at the
  top-right of the graph area (driven by the existing `loading` state), rather
  than a full-screen overlay. `pointer-events-none` so it never blocks graph
  interaction. _Rationale: non-blocking feedback; the graph stays visible and
  usable during re-analysis._
- **2026-05-29** — Stages are drawn as in-canvas **stage band** nodes
  (`StageBandNode`), one tall column per visible stage tiled edge-to-edge so
  their left borders form the vertical boundaries; the stage name sits in a
  header at the top of each band. Replaces the floating `StageLegend`
  rectangles. Bands are `zIndex:-1`, non-interactive (`pointer-events-none`,
  not selectable/draggable) and live in the flow so they pan/zoom with the
  graph. Band height = `STAGE_HEADER_H + maxJobsInStage*(NODE_H+JOB_GAP)`.
  _Rationale: the user wanted stage structure shown as boundaries that move
  with the graph, not detached chips that ignore zoom/pan._
