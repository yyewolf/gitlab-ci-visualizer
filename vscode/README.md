# GitLab CI Visualizer

Preview and analyze GitLab CI pipelines directly in VSCode. Open a `.gitlab-ci.yml`, simulate any branch or pipeline condition, and see which jobs actually run - rendered as an interactive graph.

## Usage

Open any `.yml` or `.yaml` file, then click the preview button in the editor title bar or run **Preview GitLab CI** from the command palette.

The panel opens beside your file with:
- your current git branch pre-filled
- the open file already loaded
- analysis running automatically

Click any job node to see the full rule trace: every `rules:`, `only:`, or `except:` entry, whether it matched, and why the job runs or is skipped.

## GitLab integration

Run **GitLab CI: Configure Authentication** from the command palette to store a Personal Access Token (needs `api` scope, Developer role on the project).

With a token configured, use **Analyze with GitLab** to:

- Resolve all `include:` files server-side via the GitLab CI lint API - you see the full merged pipeline, not just what's in the file you have open
- Automatically resolve triggered downstream pipelines (see below)

### Triggered downstream pipelines

Jobs with a `trigger:` keyword show a **trigger →** badge. After analysis, their downstream pipeline is resolved automatically:

| Trigger type | How it resolves |
|---|---|
| `trigger: {include: child.yml}` | Reads the file from your workspace - no token needed |
| `trigger: {project: group/project}` | Fetches and lints the downstream project via the GitLab API |

Click the trigger job in the graph, then click **View downstream pipeline →** in the details panel to navigate into it. A breadcrumb in the toolbar lets you go back to the main pipeline.

## Features

- **Pipeline graph** - stage lanes with dependency edges, including `needs:` edges
- **Artifact flow view** - separate tab showing how artifacts pass between jobs (amber edges)
- **Rule evaluation** - `rules:if`, `only:`, `except:` evaluated against your chosen branch, pipeline source, and variables
- **Rule trace** - click a job to see every rule and its outcome
- **`extends:` resolution** - single and multi-parent inheritance, child wins on conflicts
- **`parallel:matrix` expansion** - cartesian product expanded into instance cards with variable chips
- **Job badges** - `allow_failure`, `when`, `interruptible`, `retry`, `release`, `coverage`, `pages`, `trigger`, and more
- **Variable suggestions** - branches and CI variables read from your config and offered as suggestions
- **GitLab-resolved analysis** - `include:` resolved server-side; downstream pipelines fetched and shown inline

## What the analyzer handles

| Feature | Notes |
|---|---|
| `rules:if` | `==`, `!=`, `=~`, `!~`, `&&`, `\|\|`, null checks |
| `only:` / `except:` | refs, branches, tags, merge requests, schedules, regex |
| `extends:` | single and multi-parent, deep merge |
| `parallel:matrix` | cartesian expansion, instance cards in details panel |
| `needs:` | explicit dependencies as direct edges |
| `needs[].artifacts` | tracked to exclude from artifact flow |
| `dependencies:` | explicit artifact source override |
| `when:` | `on_success`, `on_failure`, `always`, `manual`, `never` |
| `.pre` / `.post` | dropped when no middle-stage job runs |
| `trigger:` | badge shown; downstream pipeline resolved automatically |

`changes:` and `exists:` are both assumed true (no filesystem context).

## License

MIT
