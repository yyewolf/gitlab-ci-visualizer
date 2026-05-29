package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlab"
	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlabci"
)

// resolveRequest asks the server to resolve include: directives via CI lint.
type resolveRequest struct {
	YAML      string            `json:"yaml"`
	Variables map[string]string `json:"variables"`
}

type resolveResponse struct {
	ResolvedYAML string `json:"resolved_yaml"`
}

// handleResolve runs the YAML through the GitLab CI lint API to merge includes.
func handleResolve(opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req resolveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		project := gitlab.DetectProjectFromDir(workDir(opts))
		ref := req.Variables["CI_COMMIT_BRANCH"]
		if ref == "" {
			ref = "main"
		}

		result, err := opts.GitLab.Lint(r.Context(), req.YAML, project, ref)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		merged := result.MergedYAML
		if merged == "" {
			merged = req.YAML
		}
		writeJSON(w, resolveResponse{ResolvedYAML: merged})
	}
}

// downstreamRequest resolves a single trigger job's downstream pipeline and
// returns it already analyzed (so the frontend gets a ready-to-render result).
type downstreamRequest struct {
	Trigger struct {
		Project string `json:"project"`
		Branch  string `json:"branch"`
		Include string `json:"include"`
	} `json:"trigger"`
	Variables map[string]string `json:"variables"`
}

// handleDownstream resolves a trigger:'s downstream YAML (local include or
// cross-project fetch + lint), then analyzes it.
func handleDownstream(opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req downstreamRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		yaml, source, err := resolveDownstreamYAML(r.Context(), opts, req)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if yaml == "" {
			http.Error(w, "downstream pipeline could not be resolved", http.StatusNotFound)
			return
		}

		vars := map[string]string{}
		for k, v := range req.Variables {
			vars[k] = v
		}
		vars["CI_PIPELINE_SOURCE"] = source
		if source == "pipeline" && req.Trigger.Branch != "" {
			vars["CI_COMMIT_BRANCH"] = req.Trigger.Branch
		}

		result, err := gitlabci.Analyze(gitlabci.Input{YAML: yaml, Variables: vars})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, result)
	}
}

// resolveDownstreamYAML returns the downstream YAML and its pipeline source.
// trigger.include → local workspace file (parent_pipeline); trigger.project →
// fetch raw + lint across the project boundary (pipeline).
func resolveDownstreamYAML(ctx context.Context, opts Options, req downstreamRequest) (string, string, error) {
	switch {
	case req.Trigger.Include != "":
		path := filepath.Join(workDir(opts), req.Trigger.Include)
		data, err := os.ReadFile(path)
		if err != nil {
			return "", "", nil // silently skip unresolvable local includes
		}
		return string(data), "parent_pipeline", nil

	case req.Trigger.Project != "":
		branch := req.Trigger.Branch
		if branch == "" {
			branch = req.Variables["CI_COMMIT_BRANCH"]
		}
		if branch == "" {
			branch = "main"
		}
		raw, err := opts.GitLab.FetchRawFile(ctx, req.Trigger.Project, ".gitlab-ci.yml", branch)
		if err != nil {
			return "", "", err
		}
		// Best-effort include resolution; fall back to the raw file on error.
		if lint, err := opts.GitLab.Lint(ctx, raw, req.Trigger.Project, branch); err == nil && lint.MergedYAML != "" {
			return lint.MergedYAML, "pipeline", nil
		}
		return raw, "pipeline", nil

	default:
		return "", "", nil
	}
}

func workDir(opts Options) string {
	if opts.WorkDir != "" {
		return opts.WorkDir
	}
	if wd, err := os.Getwd(); err == nil {
		return wd
	}
	return "."
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// writeAPIError maps a gitlab.APIError to its HTTP status, defaulting to 500.
func writeAPIError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if apiErr, ok := err.(*gitlab.APIError); ok && apiErr.Status != 0 {
		status = apiErr.Status
	}
	http.Error(w, err.Error(), status)
}
