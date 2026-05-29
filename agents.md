# agents.md - GitLab CI Visualizer

Context document for AI agents working in this repository.

---

## What this project does

Takes a `.gitlab-ci.yml`, evaluates which jobs run under given conditions (branch, pipeline source, custom variables), and renders the pipeline as an interactive graph. Delivered as both a VSCode extension and a standalone web app.

---

## Architecture

```
main.go                  - thin entry point: embeds web/dist + samples/ via
                           //go:embed and calls internal/cli.Execute
internal/cli/            - cobra commands: root (serve + autodetect/--file +
                           random port + open browser), `glvis login`
internal/server/         - HTTP server: /api/analyze, /api/initial,
                           /api/resolve, /api/downstream
internal/gitlab/         - GitLab client: CI lint (include resolution), raw file
                           fetch, downstream resolution, project/instance detect
internal/auth/           - credential store: OS keychain + ~/.config/glvis fallback
internal/gitlabci/
  parser.go              - YAML → parsedCI (stages, variables, jobs map, extends resolution)
  pipeline.go            - parsedCI → Output (job resolution, rule eval, edge computation,
                           artifact edge computation, trigger extraction)
  expr.go                - rules:if expression evaluator
  types.go               - Go structs: Input / Output / Job / Edge / Artifacts / TriggerInfo / …
web/src/
  types.ts               - TypeScript mirrors of the Go types (keep in sync with types.go)
  App.tsx                - root: state, view mode toggle, downstream navigation, condition panel,
                           graph, details panel
  components/
    PipelineGraph.tsx    - React Flow pipeline graph (JobNode, needs/stage edges)
    JobNode.tsx          - single job card: status dot, badges, image line
    ArtifactFlowView.tsx - React Flow artifact flow graph (ArtifactJobNode, amber edges)
    ArtifactJobNode.tsx  - job card for artifact view: producer indicator, artifact summary
    JobDetails.tsx       - right-side panel shown when a job is selected
    ConditionPanel.tsx   - left-side inputs (YAML source, branch, pipeline source, variables)
vscode/src/extension.ts  - VSCode extension: spawns `glvis` as a local server,
                           manages the webview, and calls its HTTP endpoints
                           (analyze/resolve/downstream) over the parsed port
samples/
  ctf-gitlab-ci.yaml     - complex multi-stage CTF pipeline
  artifact-flow.yaml     - artifact flow showcase (build → test → package → deploy)
  matrix.yaml            - parallel, parallel:matrix cross-products, rules overrides
  triggers.yaml          - parent-child and multi-project trigger showcase
  .gitlab-ci-infra.yml   - child pipeline referenced by triggers.yaml
.goreleaser.yaml         - goreleaser config for GitHub releases
```

### Data flow

1. User sets conditions (branch, pipeline source, variables) → frontend sends `PipelineInput` JSON to `POST /api/analyze`.
2. Server: `parser.go` unmarshals YAML and resolves `extends`, `pipeline.go` resolves jobs, evaluates rules, computes dependency edges, artifact edges, and extracts trigger info, emits `Output` JSON.
3. Frontend receives `Output` (stages, jobs, edges, artifact_edges, suggestions, warnings) and renders the selected view.
4. With a GitLab token, the frontend (standalone) or extension first calls `/api/resolve` to merge includes, then `/api/analyze`, then `/api/downstream` per trigger job to get each downstream pipeline (already analyzed).

### Server mode (`glvis`)

The binary embeds `web/dist` and `samples` at compile time. Running `glvis` (or `glvis --addr=...`) binds a random free port and serves:
- `GET /` - embedded React SPA
- `GET /api/initial` - autodetected/--file YAML + branch + whether GitLab resolution is available
- `POST /api/analyze` - analysis endpoint
- `POST /api/resolve` - include resolution via the GitLab CI lint API
- `POST /api/downstream` - resolve + analyze a trigger's downstream pipeline
- `GET /samples/*` - embedded sample YAML files

The frontend calls `/api/analyze` in both dev (Vite proxies it) and production. The VSCode extension spawns this server and calls the same endpoints over HTTP.

---

## Key conventions

### Adding a new job-level field

This is the most common change. Follow this checklist:

1. **`internal/gitlabci/types.go`** - add the field to `Job` with a JSON tag.
2. **`internal/gitlabci/pipeline.go`** - populate it inside `processJob`. Use `getBool`, `getStr`, or a custom extractor. Keep consistent with existing fields.
3. **`web/src/types.ts`** - mirror the field on the `Job` interface. Optional fields use `?`.
4. **`web/src/components/JobDetails.tsx`** - render it in the appropriate `<Section>` block using the `{job.field && <Row label="...">...</Row>}` pattern.
5. **`web/src/components/JobNode.tsx`** - add a badge in the badges row if the field is worth showing at a glance. Use `<Badge color="...">label</Badge>`. Pick a color not already used for a semantically different concept.

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

### Trigger parsing

`extractTrigger(raw)` handles all `trigger:` forms:
- `trigger: group/project` - string shorthand → `TriggerInfo{Project: "group/project"}`
- `trigger: {project:, branch:, strategy:}` - multi-project trigger
- `trigger: {include: child.yml}` - local parent-child (string shorthand)
- `trigger: {include: {local: path}}` - local parent-child (map)
- `trigger: {include: [{local: path}]}` - local parent-child (array)

`TriggerInfo.Include != ""` means parent-child; `TriggerInfo.Project != ""` means multi-project.

---

## Build

```bash
# Frontend must be built first (output is embedded into the Go binary)
cd web && npm install && npm run build && cd ..

# Go binary (embeds web/dist and samples/ at compile time)
go build -o glvis .

# Run it (random port, opens the browser, analyzes ./.gitlab-ci.yml)
./glvis

# VSCode extension (builds Go binaries for all platforms + bundles)
cd vscode && npm install && npm run build && npm run package-all
```

### Dev mode (hot reload)

```bash
# Terminal 1 - Go API + samples server on a fixed port for the Vite proxy
go run . --addr=127.0.0.1:3002 --no-browser

# Terminal 2 - Vite dev server (proxies /api and /samples to :3002)
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

- `include:` - not fetched (no network access); resolved server-side by the VSCode extension's GitLab integration
- `changes:` / `exists:` - always treated as matching (no filesystem context)
- `default:` block - not parsed; job-level values only

If you add `default:` support, parse it in `parser.go`, add a field to `parsedCI`, and thread it through `processJob` as a fallback for each field.

---

## Frontend rendering notes

- The graph uses **React Flow**. Both views (Pipeline, Artifact flow) are separate React Flow instances.
- `PipelineGraph.tsx` uses `JobNode` (type `"job"`). Edges are `"needs"` (blue, solid) or `"stage"` (gray, dashed). The `"Show stage edges"` toggle hides stage edges from rendering but still uses them for ancestor BFS.
- `ArtifactFlowView.tsx` uses `ArtifactJobNode` (type `"artifactJob"`). Edges are amber/gold, all sourced from `pipeline.artifact_edges`. Jobs not in the artifact flow (neither producer nor consumer) are dimmed. Hovering traces the upstream artifact chain.
- Both views share the same layout algorithm (stage columns) and `computeAncestors` BFS logic (each file has its own copy since edge IDs differ).
- The right panel (`JobDetails.tsx`) is shared across all views. It receives `downstreamPipeline: boolean` and `onViewDownstream` props to control the downstream navigation button on trigger jobs.
- View mode state lives in `App.tsx` as `viewMode: "pipeline" | "artifacts"`.
- Downstream pipeline navigation state lives in `App.tsx` as `downstreamNav: { jobName, pipeline } | null`. When set, `activePipeline` switches to the downstream pipeline and a breadcrumb appears in the toolbar. All views and stats operate on `activePipeline`.

### Handle IDs (React Flow)

Both node types expose six handles. The direction is determined by whether the edge is horizontal (cross-stage) or vertical (same-stage), and which direction within same-stage:

| Handle ID | Type | Position | When used |
|---|---|---|---|
| `left` | target | Left | incoming cross-stage edge |
| `right` | source | Right | outgoing cross-stage edge |
| `top` | target | Top | incoming same-stage edge (source is above) |
| `bottom` | source | Bottom | outgoing same-stage edge (target is below) |
| `topSrc` | source | Top | outgoing same-stage edge (target is above, wraps up) |
| `bottomTgt` | target | Bottom | incoming same-stage edge (source is below, wraps up) |

React Flow silently drops edges where the handle type (`source`/`target`) doesn't match the edge role. Always use `topSrc`/`bottomTgt` for upward same-stage edges, not `top`/`bottom`.

---

## VSCode extension - downstream pipeline resolution

After every successful analysis (`analyze` or `analyze-with-gitlab`), `resolveDownstreamPipelines` runs asynchronously for each enabled job that has a `trigger` field:

**Parent-child (`trigger.include`):**
1. Read the file from the workspace filesystem using `fs.readFileSync`.
2. Run `runAnalysis` with the file content and `CI_PIPELINE_SOURCE=parent_pipeline`.
3. Send `{ type: "downstream-pipeline", jobName, pipeline }` to the webview.

**Multi-project (`trigger.project`) - requires a GitLab token:**
1. `GET /api/v4/projects/{project}/repository/files/.gitlab-ci.yml/raw?ref={branch}` - fetch the raw YAML.
2. `POST /api/v4/projects/{project}/ci/lint { content, dry_run: true, ref }` - resolve includes server-side, get `merged_yaml`. Falls back to raw YAML if the lint call fails.
3. Run `runAnalysis` with the merged YAML and `CI_PIPELINE_SOURCE=pipeline`.
4. Send `{ type: "downstream-pipeline", jobName, pipeline }` to the webview.

The frontend stores received pipelines in `downstreamPipelines: Record<string, Pipeline>`. When all are populated, trigger jobs show a **View downstream pipeline →** button in `JobDetails`.

---

## GitLab CI fields currently surfaced

| Field | Go | TS | Badge | Details panel |
|---|---|---|---|---|
| `stage` | ✓ | ✓ | - | header |
| `when` | ✓ | ✓ | ✓ (when ≠ on_success) | Status |
| `allow_failure` | ✓ | ✓ | ✓ amber | Status |
| `interruptible` | ✓ | ✓ | ✓ fuchsia | Status |
| `image` | ✓ | ✓ | - (shown below name) | Status |
| `environment` | ✓ | ✓ | ✓ teal | Status |
| `resource_group` | ✓ | ✓ | ✓ orange | Status |
| `tags` | ✓ | ✓ | ✓ zinc (first tag) | Status |
| `retry` | ✓ | ✓ | ✓ rose (`retry:N`) | - |
| `release` | ✓ | ✓ | ✓ emerald | - |
| `coverage` | ✓ | ✓ | ✓ indigo | - |
| `pages` | ✓ | ✓ | ✓ cyan | - |
| `trigger` | ✓ | ✓ | ✓ orange (`trigger →`) | Trigger section |
| `needs` | ✓ | ✓ | - | Needs section |
| `needs[].artifacts` | ✓ | ✓ | - | (feeds artifact edges) |
| `dependencies` | ✓ | ✓ | - | (feeds artifact edges) |
| `artifacts` | ✓ | ✓ | ✓ sky | Artifacts section |
| `parallel` / `matrix` | ✓ | ✓ | ✓ violet | Matrix/Parallel section |
| `variables` | ✓ | ✓ | - | Variables section |
| `rules` (trace) | ✓ | ✓ | - | Rules evaluation section |
| `only` / `except` | ✓ | - | - | (affects enabled only) |
| `extends` | ✓ | - | - | (resolved at parse time) |

### Edge types in `Output`

| Field | Type values | Used by |
|---|---|---|
| `edges` | `"needs"`, `"stage"` | PipelineGraph |
| `artifact_edges` | `"artifact"` | ArtifactFlowView |

`artifact_edges` are computed from: `dependencies` (explicit override) → `needs` minus `artifacts:false` entries → stage-based inheritance from artifact-producing predecessors.

### Message protocol (VSCode extension ↔ webview)

| Direction | Type | Payload | When |
|---|---|---|---|
| ext → web | `yaml` | `{ data, branch?, useGitlab? }` | file opened or saved |
| ext → web | `pipeline` | `Pipeline` | analysis complete |
| ext → web | `downstream-pipeline` | `{ jobName, pipeline }` | downstream resolved |
| ext → web | `error` | `string` | analysis or resolution failed |
| web → ext | `ready` | - | webview loaded |
| web → ext | `analyze` | `PipelineInput` | user clicked Analyze |
| web → ext | `analyze-with-gitlab` | `PipelineInput` | user clicked Analyze with GitLab |
