# GitLab CI Visualizer

You paste a `.gitlab-ci.yml`, tell it what to simulate (branch, pipeline source, custom variables), and it draws the graph and tells you which jobs actually run.

There's a VSCode extension that opens beside your file, and a standalone web app if you'd rather not use VSCode.

---

## What it does

- Draws the pipeline as a graph with stage lanes and dependency edges
- Evaluates `rules:`, `only:`, and `except:` against whatever conditions you set
- Click a job to see the rule trace: every rule, whether it matched, what caused the job to run or be skipped
- Resolves `extends:` and expands `parallel:matrix` into individual instances shown as cards
- Shows artifact flow as a separate view: which jobs produce artifacts and how they pass through the pipeline
- Surfaces job badges for `allow_failure`, `when`, `interruptible`, `retry`, `release`, `coverage`, `pages`, `trigger`, and more
- Reads branches and CI variables from your config and offers them as suggestions
- In VSCode: loads the open file, picks up your current git branch, and runs the analysis automatically
- In VSCode with a GitLab token: resolves `include:` directives server-side and shows triggered downstream pipelines inline

---

## VSCode extension

Open a `.yaml` or `.yml` in VSCode, then click the preview button in the editor title bar (or run **Preview GitLab CI** from the command palette). The panel opens beside your file with the content already loaded and your current branch filled in. Analysis runs on its own, but there's a button if you need to re-run.

### GitLab integration

Run **GitLab CI: Configure Authentication** from the command palette to store a Personal Access Token. With a token configured:

- **Analyze with GitLab** - resolves all `include:` files via the CI lint API and shows the full merged pipeline
- **Triggered downstream pipelines** - jobs with `trigger:` automatically resolve their downstream pipeline:
  - `trigger: {include: child.yml}` reads the file from your workspace (no token needed)
  - `trigger: {project: group/project}` fetches and lints the downstream project via the GitLab API
  - Click the trigger job, then **View downstream pipeline →** to navigate into it

### Installing from a .vsix file

Grab the `.vsix` for your platform from the [releases page](https://github.com/yyewolf/gitlab-ci-visualizer/releases), then:

```
code --install-extension gitlab-ci-visualizer-<platform>-0.1.0.vsix
```

---

## Standalone web app

You need Go and Node.

```bash
# Build the frontend
cd web && npm install && npm run build && cd ..

# Run the server
go run . -serve :3001
```

Open `http://localhost:3001`, paste YAML, set conditions, click Analyze.

---

## Building from source

Requires Go 1.21+ and Node 18+.

```bash
cd vscode
npm install

# Web frontend + Go binaries for all platforms + TypeScript
npm run build

# Single .vsix with everything bundled
npm run package

# One .vsix per platform (smaller)
npm run package-all
```

`package-all` outputs:

| File | Platform |
|---|---|
| `gitlab-ci-visualizer-linux-x64-*.vsix` | Linux x86-64 |
| `gitlab-ci-visualizer-linux-arm64-*.vsix` | Linux ARM64 |
| `gitlab-ci-visualizer-darwin-x64-*.vsix` | macOS Intel |
| `gitlab-ci-visualizer-darwin-arm64-*.vsix` | macOS Apple Silicon |
| `gitlab-ci-visualizer-win32-x64-*.vsix` | Windows x86-64 |

---

## What the analyzer handles

- `rules:` - `if` expressions with `==`, `!=`, `=~`, `!~`, `&&`, `||`, null checks
- `only:` / `except:` - refs, branches, tags, merge requests, schedules, regex patterns
- `extends:` - single and multi-parent inheritance, child wins on conflicts
- `parallel:matrix` - full cartesian product, instances shown as cards on click
- `needs:` - explicit dependencies shown as direct edges; `needs[].artifacts: false` tracked
- `dependencies:` - explicit artifact source override
- `when:` - `on_success`, `on_failure`, `always`, `manual`, `never`
- `.pre` / `.post` stages - GitLab drops them when no middle-stage job runs
- `trigger:` - parsed and shown as a badge; downstream pipeline resolved in VSCode

`changes:` and `exists:` are both assumed true (no filesystem context).

---

## Stack

- Go: parses the YAML, evaluates rules, serves the API
- React + TypeScript + Tailwind + [React Flow](https://reactflow.dev/)
- VSCode extension with the Go binary bundled per platform

## License

MIT
