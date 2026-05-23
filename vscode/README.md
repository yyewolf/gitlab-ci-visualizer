# GitLab CI Visualizer

Preview and analyze GitLab CI pipelines directly in VSCode. Open a `.gitlab-ci.yml`, simulate any branch or pipeline condition, and see which jobs actually run — rendered as an interactive graph.

## Usage

Open any `.yml` or `.yaml` file, then click the preview button in the editor title bar or run **Preview GitLab CI** from the command palette.

The panel opens beside your file with:
- your current git branch pre-filled
- the open file already loaded
- analysis running automatically

Click any job node to see the full rule trace: every `rules:`, `only:`, or `except:` entry, whether it matched, and why the job runs or is skipped.

## Features

- **Pipeline graph** — stage lanes with dependency edges, including `needs:` edges
- **Rule evaluation** — `rules:if`, `only:`, `except:` evaluated against your chosen branch, pipeline source, and variables
- **Rule trace** — click a job to see every rule and its outcome
- **`extends:` resolution** — single and multi-parent inheritance, child wins on conflicts
- **`parallel:matrix` expansion** — full cartesian product into individual job instances
- **Variable suggestions** — branches and CI variables are read from your config and offered as suggestions

## What the analyzer handles

| Feature | Notes |
|---|---|
| `rules:if` | `==`, `!=`, `=~`, `!~`, `&&`, `\|\|`, null checks |
| `only:` / `except:` | refs, branches, tags, merge requests, schedules, regex |
| `extends:` | single and multi-parent, deep merge |
| `parallel:matrix` | cartesian expansion |
| `needs:` | explicit dependencies as direct edges |
| `when:` | `on_success`, `on_failure`, `always`, `manual`, `never` |
| `.pre` / `.post` | dropped when no middle-stage job runs |

`include:` files are not fetched. `changes:` and `exists:` are both assumed true.

## License

MIT
