# agents.md — GitLab CI Visualizer

Context document for AI agents working in this repository.

---

## What this project does

Takes a `.gitlab-ci.yml`, evaluates which jobs run under given conditions (branch, pipeline source, custom variables), and renders the pipeline as a graph. Delivered as both a VSCode extension and a standalone web app.

---

## Architecture

```
main.go                  — binary entry point (stdin/stdout JSON protocol or -serve HTTP)
                           embeds web/dist and samples via //go:embed
internal/gitlabci/
  parser.go              — YAML → parsedCI (stages, variables, jobs map)
  pipeline.go            — parsedCI → Output (job resolution, rule eval, edge computation)
  expr.go                — rules:if expression evaluator
  types.go               — Go structs for Input/Output/Job/Edge/…
web/src/
  types.ts               — TypeScript mirrors of the Go types
  App.tsx                — root: state, condition panel, graph, details panel
  components/
    PipelineGraph.tsx    — React Flow graph (nodes + edges)
    JobNode.tsx          — single job card in the graph
    JobDetails.tsx       — right-side panel shown when a job is selected
    ConditionPanel.tsx   — left-side inputs (branch, source, variables)
vscode/src/extension.ts  — VSCode extension: spawns the Go binary, manages the webview
.goreleaser.yaml         — goreleaser config for GitHub releases
```

### Data flow

1. User sets conditions (branch, pipeline source, variables) → frontend sends `PipelineInput` JSON to the Go binary via stdin (or HTTP POST `/api/analyze`).
2. Go binary: `parser.go` unmarshals the YAML, `pipeline.go` resolves jobs and emits `Output` JSON to stdout.
3. Frontend receives `Output` (stages, jobs, edges, suggestions, warnings) and renders the graph.

### Standalone binary mode (`-serve`)

The binary embeds `web/dist` and `samples` at compile time. Running `gitlab-ci-visualizer -serve :3001` serves:
- `GET /` — embedded React SPA
- `POST /api/analyze` — analysis endpoint
- `GET /samples/*` — embedded sample YAML files

The frontend calls `/api/analyze` in both dev (Vite proxies it) and production.

---

## Key conventions

### Adding a new job-level field

This is the most common change. Follow this checklist:

1. **`internal/gitlabci/types.go`** — add the field to `Job` with a JSON tag.
2. **`internal/gitlabci/pipeline.go`** — populate it inside `processJob`. Use `getBool`, `getStr`, or a custom extractor. Keep it consistent with how existing fields are done (e.g. `allow_failure`, `interruptible`).
3. **`web/src/types.ts`** — mirror the field on the `Job` interface. Optional fields use `?`.
4. **`web/src/components/JobDetails.tsx`** — render the field in the `<Section title="Status">` block (or add a new section if it's complex). Follow the `{job.field && <Row label="...">...</Row>}` pattern for boolean flags.

Boolean flags that are false by default should only be shown when true (same as `allow_failure`, `interruptible`). Fields that have meaningful non-empty string values follow `{job.field && <Row>}`.

### Adding a new parser feature

- Edit `parser.go` for YAML extraction / struct changes.
- Edit `pipeline.go` for logic that transforms parsed data into output.
- Add tests in `parser_test.go`.

### Expression evaluator (`expr.go`)

Handles `rules:if` expressions: `==`, `!=`, `=~`, `!~`, `&&`, `||`, null checks, variable references. Extend the lexer/parser there for new operator support.

---

## Build

```bash
# Frontend must be built first (embeds into the Go binary)
cd web && npm install && npm run build && cd ..

# Go binary (embeds web/dist at compile time)
go build -o gitlab-ci-visualizer .

# Run the standalone web app
./gitlab-ci-visualizer -serve :3001

# VSCode extension (builds Go binaries for all platforms + bundles)
cd vscode && npm install && npm run build && npm run package-all
```

### Dev mode (hot reload)

```bash
# Terminal 1 — Go API server
go run . -serve :3002

# Terminal 2 — Vite dev server (proxies /api and /samples to :3002)
cd web && npm run dev
```

### Release

Build the frontend first, then run goreleaser (from your CI or locally):

```bash
npm --prefix web ci && npm --prefix web run build
GITHUB_TOKEN=... goreleaser release --clean
```

Goreleaser cross-compiles for linux/darwin/windows (amd64 + arm64) and publishes a GitHub release with archives and a `checksums.txt`.

Tests:

```bash
go test ./internal/gitlabci/...
```

---

## What the Go binary does NOT handle

- `include:` — not fetched (no network access)
- `changes:` / `exists:` — always treated as matching (no filesystem context)
- Multi-project pipelines
- `default:` block — currently not parsed; job-level values only

If you add `default:` support, parse it in `parser.go`, add a field to `parsedCI`, and thread it through `processJob` as a fallback.

---

## Frontend rendering notes

- The graph uses **React Flow**. Nodes are `JobNode`, edges are typed `"needs"` or `"stage"`.
- Disabled jobs are rendered with reduced opacity in `JobNode.tsx`.
- `PipelineGraph.tsx` owns layout: jobs are grouped by stage into columns. Stage order comes from `Output.stages`.
- The right panel (`JobDetails.tsx`) shows all resolved fields and the full rules trace.

---

## GitLab CI fields currently surfaced

| Field | Go | TS | UI |
|---|---|---|---|
| `stage` | ✓ | ✓ | header |
| `when` | ✓ | ✓ | Status |
| `allow_failure` | ✓ | ✓ | Status |
| `interruptible` | ✓ | ✓ | Status |
| `image` | ✓ | ✓ | Status |
| `environment` | ✓ | ✓ | Status |
| `resource_group` | ✓ | ✓ | Status |
| `tags` | ✓ | ✓ | Status |
| `needs` | ✓ | ✓ | Needs section |
| `artifacts` | ✓ | ✓ | Artifacts section |
| `parallel` / `matrix` | ✓ | ✓ | Matrix section |
| `variables` | ✓ | ✓ | Variables section |
| `rules` (trace) | ✓ | ✓ | Rules evaluation section |
| `only` / `except` | ✓ | — | (affects enabled only) |
| `extends` | ✓ | — | (resolved at parse time) |
