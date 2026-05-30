package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlab"
	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlabci"
)

// Options configures a server instance.
type Options struct {
	// Addr is the listen address. Use ":0" (the default) for a random free port.
	Addr string
	// WebFS serves the built frontend (expects a "web/dist" subtree).
	WebFS fs.FS
	// SamplesFS serves sample YAML files (expects a "samples" subtree).
	SamplesFS fs.FS
	// File is the autodetected/--file .gitlab-ci.yml path, surfaced via
	// /api/initial so the frontend can self-load. May be empty.
	File string
	// GitLab is the instance + token used for include/downstream resolution.
	GitLab gitlab.Config
	// WorkDir is the directory used for git-based project detection and for
	// resolving local trigger:include files. Defaults to the process CWD.
	WorkDir string
}

// initialResponse is what GET /api/initial returns to the frontend.
type initialResponse struct {
	YAML   string `json:"yaml"`
	Branch string `json:"branch"`
	File   string `json:"file"`
	// GitLabAvailable is true when the server can resolve includes/downstream:
	// a token is configured and the repo maps to a detectable project. The
	// frontend uses this to default to GitLab-resolved analysis.
	GitLabAvailable bool   `json:"gitlab_available"`
	GitLabInstance  string `json:"gitlab_instance,omitempty"`
	GitLabProject   string `json:"gitlab_project,omitempty"`
}

// Serve binds a listener and runs the HTTP server until ctx is cancelled.
// It returns the URL it is serving on via the started callback once the
// listener is bound (so callers can open a browser on the actual port).
func Serve(ctx context.Context, opts Options, started func(url string)) error {
	if opts.Addr == "" {
		opts.Addr = "127.0.0.1:0"
	}

	ln, err := net.Listen("tcp", opts.Addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/analyze", handleAnalyze)
	mux.HandleFunc("/api/initial", handleInitial(opts))
	mux.HandleFunc("/api/resolve", handleResolve(opts))
	mux.HandleFunc("/api/downstream", handleDownstream(opts))
	mux.HandleFunc("/api/watch", handleWatch(opts))

	// Sample YAML files.
	mux.HandleFunc("/samples/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		http.FileServer(http.FS(opts.SamplesFS)).ServeHTTP(w, r)
	})

	// Frontend (SPA).
	distSub, err := fs.Sub(opts.WebFS, "web/dist")
	if err != nil {
		return fmt.Errorf("web/dist embed: %w", err)
	}
	mux.Handle("/", http.FileServer(http.FS(distSub)))

	srv := &http.Server{Handler: mux}

	url := fmt.Sprintf("http://%s", ln.Addr().String())
	log.Printf("listening on %s", url)
	if started != nil {
		started(url)
	}

	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func handleAnalyze(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var input gitlabci.Input
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	result, err := gitlabci.Analyze(input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("encode response: %v", err)
	}
}

// handleInitial serves the autodetected file's contents, the current git
// branch, and whether GitLab resolution is available, so the frontend can
// self-load, auto-analyze, and default to GitLab-resolved analysis when possible.
func handleInitial(opts Options) http.HandlerFunc {
	project := gitlab.DetectProjectFromDir(workDir(opts))
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		resp := initialResponse{
			File:            opts.File,
			Branch:          currentBranch(),
			GitLabAvailable: opts.GitLab.Configured() && project != "",
			GitLabProject:   project,
		}
		if resp.GitLabAvailable {
			resp.GitLabInstance = opts.GitLab.URL
		}
		if opts.File != "" {
			data, err := os.ReadFile(opts.File)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			resp.YAML = string(data)
		}

		if err := json.NewEncoder(w).Encode(resp); err != nil {
			log.Printf("encode initial: %v", err)
		}
	}
}

// handleWatch streams Server-Sent Events whenever the watched file changes.
// It polls the file's modification time (no extra dependencies) and emits a
// "change" event so the frontend can re-fetch and re-analyze. If no file is
// configured the stream stays open but idle.
func handleWatch(opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		// Initial comment so the client knows the stream is live.
		fmt.Fprint(w, ":ok\n\n")
		flusher.Flush()

		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()

		var last time.Time
		if opts.File != "" {
			if fi, err := os.Stat(opts.File); err == nil {
				last = fi.ModTime()
			}
		}

		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if opts.File == "" {
					continue
				}
				fi, err := os.Stat(opts.File)
				if err != nil {
					continue
				}
				if mt := fi.ModTime(); mt.After(last) {
					last = mt
					fmt.Fprint(w, "event: change\ndata: {}\n\n")
					flusher.Flush()
				}
			}
		}
	}
}

// currentBranch returns the current git branch, best-effort.
func currentBranch() string {
	out, err := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
