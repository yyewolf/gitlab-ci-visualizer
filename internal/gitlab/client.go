// Package gitlab is the Go port of the logic that previously lived in the
// VSCode extension's TypeScript: resolving include: directives via the CI lint
// API, fetching raw pipeline files, and detecting the GitLab project from a git
// remote. Keeping it here makes the CLI and the extension share one
// implementation.
package gitlab

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Config identifies a GitLab instance and the token used to talk to it.
type Config struct {
	// URL is the instance base URL, without a trailing slash.
	URL   string
	Token string
}

// Configured reports whether a token is set.
func (c Config) Configured() bool { return c.Token != "" }

// APIError carries an HTTP status so callers can craft helpful messages.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

// LintResult mirrors the GitLab CI lint API response.
type LintResult struct {
	Valid      bool     `json:"valid"`
	Errors     []string `json:"errors"`
	Warnings   []string `json:"warnings"`
	MergedYAML string   `json:"merged_yaml"`
}

func (c Config) httpClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

// Lint resolves include: directives by running the YAML through the GitLab CI
// lint API. When project is non-empty it uses the project-scoped endpoint
// (which resolves project includes); otherwise it falls back to the global lint
// endpoint, which validates syntax but cannot resolve includes.
func (c Config) Lint(ctx context.Context, content, project, ref string) (LintResult, error) {
	if !c.Configured() {
		return LintResult{}, &APIError{Message: "no GitLab token configured; run `glvis login`"}
	}

	var apiURL string
	var body map[string]any
	if project != "" {
		apiURL = fmt.Sprintf("%s/api/v4/projects/%s/ci/lint", c.URL, url.PathEscape(project))
		body = map[string]any{"content": content, "dry_run": true, "ref": ref}
	} else {
		apiURL = fmt.Sprintf("%s/api/v4/ci/lint", c.URL)
		body = map[string]any{"content": content}
	}

	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(buf))
	if err != nil {
		return LintResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("PRIVATE-TOKEN", c.Token)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return LintResult{}, &APIError{Message: fmt.Sprintf("failed to reach GitLab at %s: %v", c.URL, err)}
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return LintResult{}, &APIError{Status: 401, Message: "unauthorized (401): your GitLab token is invalid or expired; run `glvis login`"}
	case http.StatusForbidden:
		return LintResult{}, &APIError{Status: 403, Message: "forbidden (403): you need at least Developer access on the project to resolve the pipeline"}
	case http.StatusNotFound:
		return LintResult{}, &APIError{Status: 404, Message: fmt.Sprintf("project not found (404): %q", project)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		text, _ := io.ReadAll(resp.Body)
		return LintResult{}, &APIError{Status: resp.StatusCode, Message: fmt.Sprintf("GitLab API error (%d):\n%s", resp.StatusCode, text)}
	}

	var result LintResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return LintResult{}, err
	}
	if !result.Valid && len(result.Errors) > 0 {
		return result, &APIError{Message: "GitLab validation errors:\n" + strings.Join(result.Errors, "\n")}
	}
	return result, nil
}

// FetchRawFile fetches the raw contents of a file from a project at a ref.
func (c Config) FetchRawFile(ctx context.Context, project, filePath, ref string) (string, error) {
	if !c.Configured() {
		return "", &APIError{Message: "no GitLab token configured; run `glvis login`"}
	}
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/repository/files/%s/raw?ref=%s",
		c.URL, url.PathEscape(project), url.PathEscape(filePath), url.QueryEscape(ref))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("PRIVATE-TOKEN", c.Token)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", &APIError{Message: fmt.Sprintf("failed to reach GitLab at %s: %v", c.URL, err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &APIError{Status: resp.StatusCode, Message: fmt.Sprintf("failed to fetch %s (HTTP %d)", filePath, resp.StatusCode)}
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ValidateToken checks the token against GET /api/v4/user and returns the
// authenticated username on success.
func (c Config) ValidateToken(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+"/api/v4/user", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("PRIVATE-TOKEN", c.Token)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", &APIError{Message: fmt.Sprintf("failed to reach GitLab at %s: %v", c.URL, err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return "", &APIError{Status: 401, Message: "unauthorized (401): token is invalid or expired"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &APIError{Status: resp.StatusCode, Message: fmt.Sprintf("GitLab API error (%d)", resp.StatusCode)}
	}

	var user struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return "", err
	}
	return user.Username, nil
}

var sshRemoteRe = regexp.MustCompile(`^git@[^:]+:(.+?)(?:\.git)?$`)

// DetectProject parses a git remote URL into a GitLab "group/project" path.
func DetectProject(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	if m := sshRemoteRe.FindStringSubmatch(remote); m != nil {
		return m[1]
	}
	u, err := url.Parse(remote)
	if err != nil {
		return ""
	}
	p := strings.TrimSuffix(strings.TrimPrefix(u.Path, "/"), ".git")
	return p
}

// DetectInstance parses a git remote URL into the GitLab instance base URL
// (scheme + host), e.g. "https://gitlab.example.com". Returns "" if it can't.
func DetectInstance(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	if m := sshRemoteRe.FindStringSubmatch(remote); m != nil {
		// git@host:group/project(.git) → grab the host between '@' and ':'.
		at := strings.IndexByte(remote, '@')
		colon := strings.IndexByte(remote, ':')
		if at >= 0 && colon > at {
			return "https://" + remote[at+1:colon]
		}
		return ""
	}
	u, err := url.Parse(remote)
	if err != nil || u.Host == "" {
		return ""
	}
	scheme := u.Scheme
	if scheme == "" {
		scheme = "https"
	}
	return scheme + "://" + u.Host
}

// remoteURL returns the origin remote URL for dir, best-effort.
func remoteURL(dir string) string {
	cmd := exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// DetectProjectFromDir runs `git remote get-url origin` in dir and parses it.
func DetectProjectFromDir(dir string) string {
	return DetectProject(remoteURL(dir))
}

// DetectInstanceFromDir derives the GitLab instance base URL from dir's origin
// remote, best-effort.
func DetectInstanceFromDir(dir string) string {
	return DetectInstance(remoteURL(dir))
}
