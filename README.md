# GitLab CI Visualizer

You paste a `.gitlab-ci.yml`, tell it what to simulate (branch, pipeline source, custom variables), and it draws the graph and tells you which jobs actually run.

There's a VSCode extension that opens beside your file, and a standalone web app if you'd rather not use VSCode.

---

## What it does

- Draws the pipeline as a graph with stage lanes and dependency edges
- Evaluates `rules:`, `only:`, and `except:` against whatever conditions you set
- Click a job to see the rule trace: every rule, whether it matched, what caused the job to run or be skipped
- Resolves `extends:` and expands `parallel:matrix` into individual instances
- Reads branches and CI variables from your config and offers them as suggestions
- In VSCode: loads the open file, picks up your current git branch, and runs the analysis automatically

---

## VSCode extension

Open a `.yaml` or `.yml` in VSCode, then click the preview button in the editor title bar (or run "Preview GitLab CI" from the command palette). The panel opens beside your file with the content already loaded and your current branch filled in. Analysis runs on its own, but there's a button if you need to re-run.

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
go run ./cmd -serve :3001
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
- `parallel:matrix` - full cartesian product
- `needs:` - explicit dependencies, shown as direct edges
- `when:` - `on_success`, `on_failure`, `always`, `manual`, `never`
- `.pre` / `.post` stages - GitLab drops them when no middle-stage job runs

It doesn't fetch `include:` files, evaluate `changes:` or `exists:` (both assumed true), or handle multi-project pipelines.

---

## Stack

- Go: parses the YAML, evaluates rules, serves the API
- React + TypeScript + Tailwind + [React Flow](https://reactflow.dev/)
- VSCode extension with the Go binary bundled per platform

## License

MIT
