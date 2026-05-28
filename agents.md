# agents.md — GitLab CI Visualizer

Context document for AI agents working in this repository.

---

## What this project does

Takes a `.gitlab-ci.yml`, evaluates which jobs run under given conditions (branch, pipeline source, custom variables), and renders the pipeline as an interactive graph. Delivered as both a VSCode extension and a standalone web app.

---

## Architecture

```
main.go                  — binary entry point (stdin/stdout JSON protocol or -serve HTTP)
                           embeds web/dist and samples/ via //go:embed
internal/gitlabci/
  parser.go              — YAML → parsedCI (stages, variables, jobs map, extends resolution)
  pipeline.go            — parsedCI → Output (job resolution, rule eval, edge computation,
                           artifact edge computation)
  expr.go                — rules:if expression evaluator
  types.go               — Go structs: Input / Output / Job / Edge / Artifacts / …
web/src/
  types.ts               — TypeScript mirrors of the Go types (keep in sync with types.go)
  App.tsx                — root: state, view mode toggle, condition panel, graph, details panel
  components/
    PipelineGraph.tsx    — React Flow pipeline graph (JobNode, needs/stage edges)
    JobNode.tsx          — single job card: status dot, badges, image line
    ArtifactFlowView.tsx — React Flow artifact flow graph (ArtifactJobNode, amber edges)
    ArtifactJobNode.tsx  — job card for artifact view: producer indicator, artifact summary
    JobDetails.tsx       — right-side panel shown when a job is selected
    ConditionPanel.tsx   — left-side inputs (YAML source, branch, pipeline source, variables)
vscode/src/extension.ts  — VSCode extension: spawns the Go binary, manages the webview
samples/
  ctf-gitlab-ci.yaml     — complex multi-stage CTF pipeline (existing sample)
  artifact-flow.yaml     — artifact flow showcase (build → test → package → deploy)
.goreleaser.yaml         — goreleaser config for GitHub releases
```

### Data flow

1. User sets conditions (branch, pipeline source, variables) → frontend sends `PipelineInput` JSON to the Go binary via stdin (or HTTP POST `/api/analyze`).
2. Go binary: `parser.go` unmarshals YAML and resolves `extends`, `pipeline.go` resolves jobs, evaluates rules, computes dependency edges and artifact edges, emits `Output` JSON.
3. Frontend receives `Output` (stages, jobs, edges, artifact_edges, suggestions, warnings) and renders the selected view.

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
2. **`internal/gitlabci/pipeline.go`** — populate it inside `processJob`. Use `getBool`, `getStr`, or a custom extractor. Keep consistent with existing fields.
3. **`web/src/types.ts`** — mirror the field on the `Job` interface. Optional fields use `?`.
4. **`web/src/components/JobDetails.tsx`** — render it in the `<Section title="Status">` block using the `{job.field && <Row label="...">...</Row>}` pattern.
5. **`web/src/components/JobNode.tsx`** — add a badge in the badges row if the field is worth showing at a glance. Use `<Badge color="...">label</Badge>`. Pick a color not already used for a semantically different concept.

Boolean flags false by default should only be shown when true (same as `allow_failure`, `interruptible`).

### Adding a new view

The app has two views: **Pipeline** (`PipelineGraph.tsx`) and **Artifact flow** (`ArtifactFlowView.tsx`). Both use the same stage-column layout constants:

```ts
NODE_W = 208, NODE_H = 80, STAGE_GAP = 80, JOB_GAP = 12, STAGE_HEADER_H = 32
```

To add a third view:
1. Create `FooView.tsx` using the same React Flow setup and layout math.
2. Create a `FooJobNode.tsx` if the node appearance differs.
3. Add a `"foo"` variant to the `viewMode` state in `App.tsx` and add a tab button in the toolbar.
4. The `"Show stage edges"` checkbox is only shown for the Pipeline view; follow that pattern for view-specific controls.

### Adding a new parser feature

- Edit `parser.go` for YAML extraction / struct changes.
- Edit `pipeline.go` for logic that transforms parsed data into output.
- Add tests in `parser_test.go`.

### Expression evaluator (`expr.go`)

Handles `rules:if` expressions: `==`, `!=`, `=~`, `!~`, `&&`, `||`, null checks, variable references. Extend the lexer/parser there for new operator support.

### Needs parsing and artifacts

`extractNeedsAndArtifacts(raw)` returns both `(needs []string, noArtifacts []string)`. The `noArtifacts` list contains job names whose `needs` entry has `artifacts: false`. This feeds into `computeArtifactEdges` to exclude those edges from the artifact flow.

`extractDependencies(raw)` returns `*[]string`: nil = field not present (inherit from stage), pointer to empty slice = `dependencies: []` (no artifact downloads), pointer to non-empty slice = explicit list.

---

## Build

```bash
# Frontend must be built first (output is embedded into the Go binary)
cd web && npm install && npm run build && cd ..

# Go binary (embeds web/dist and samples/ at compile time)
go build -o gitlab-ci-visualizer .

# Run the standalone web app
./gitlab-ci-visualizer -serve :3001

# VSCode extension (builds Go binaries for all platforms + bundles)
cd vscode && npm install && npm run build && npm run package-all
```

### Dev mode (hot reload)

```bash
# Terminal 1 — Go API + samples server
go run . -serve :3002

# Terminal 2 — Vite dev server (proxies /api and /samples to :3002)
cd web && npm run dev
```

### Release

```bash
npm --prefix web ci && npm --prefix web run build
GITHUB_TOKEN=... goreleaser release --clean
```

Tests:

```bash
go test ./internal/gitlabci/...
```

---

## What the Go binary does NOT handle

- `include:` — not fetched (no network access)
- `changes:` / `exists:` — always treated as matching (no filesystem context)
- Multi-project pipelines
- `default:` block — not parsed; job-level values only

If you add `default:` support, parse it in `parser.go`, add a field to `parsedCI`, and thread it through `processJob` as a fallback for each field.

---

## Frontend rendering notes

- The graph uses **React Flow**. Both views (Pipeline, Artifact flow) are separate React Flow instances.
- `PipelineGraph.tsx` uses `JobNode` (type `"job"`). Edges are `"needs"` (blue, solid) or `"stage"` (gray, dashed). The `"Show stage edges"` toggle hides stage edges from rendering but still uses them for ancestor BFS.
- `ArtifactFlowView.tsx` uses `ArtifactJobNode` (type `"artifactJob"`). Edges are amber/gold, all sourced from `pipeline.artifact_edges`. Jobs not in the artifact flow (neither producer nor consumer) are dimmed. Hovering traces the upstream artifact chain.
- Both views share the same layout algorithm (stage columns) and `computeAncestors` BFS logic (each file has its own copy since edge IDs differ).
- The right panel (`JobDetails.tsx`) is shared across all views.
- View mode state lives in `App.tsx` as `viewMode: "pipeline" | "artifacts"`.

---

## GitLab CI fields currently surfaced

| Field | Go | TS | Badge | Details panel |
|---|---|---|---|---|
| `stage` | ✓ | ✓ | — | header |
| `when` | ✓ | ✓ | ✓ (when ≠ on_success) | Status |
| `allow_failure` | ✓ | ✓ | ✓ amber | Status |
| `interruptible` | ✓ | ✓ | ✓ fuchsia | Status |
| `image` | ✓ | ✓ | — (shown below name) | Status |
| `environment` | ✓ | ✓ | ✓ teal | Status |
| `resource_group` | ✓ | ✓ | ✓ orange | Status |
| `tags` | ✓ | ✓ | ✓ zinc (first tag) | Status |
| `retry` | ✓ | ✓ | ✓ rose (`retry:N`) | — |
| `release` | ✓ | ✓ | ✓ emerald | — |
| `coverage` | ✓ | ✓ | ✓ indigo | — |
| `pages` | ✓ | ✓ | ✓ cyan | — |
| `needs` | ✓ | ✓ | — | Needs section |
| `needs[].artifacts` | ✓ | ✓ | — | (feeds artifact edges) |
| `dependencies` | ✓ | ✓ | — | (feeds artifact edges) |
| `artifacts` | ✓ | ✓ | ✓ sky | Artifacts section |
| `parallel` / `matrix` | ✓ | ✓ | ✓ violet | Matrix section |
| `variables` | ✓ | ✓ | — | Variables section |
| `rules` (trace) | ✓ | ✓ | — | Rules evaluation section |
| `only` / `except` | ✓ | — | — | (affects enabled only) |
| `extends` | ✓ | — | — | (resolved at parse time) |

### Edge types in `Output`

| Field | Type values | Used by |
|---|---|---|
| `edges` | `"needs"`, `"stage"` | PipelineGraph |
| `artifact_edges` | `"artifact"` | ArtifactFlowView |

`artifact_edges` are computed from: `dependencies` (explicit override) → `needs` minus `artifacts:false` entries → stage-based inheritance from artifact-producing predecessors.
