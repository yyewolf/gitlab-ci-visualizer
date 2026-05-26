package gitlabci

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Analyze is the main entry point.
func Analyze(input Input) (*Output, error) {
	ci, err := parseYAML(input.YAML)
	if err != nil {
		return &Output{Error: err.Error()}, nil
	}

	// Effective variables: global CI vars overridden by caller-provided vars
	vars := make(map[string]string, len(ci.variables)+len(input.Variables))
	for k, v := range ci.variables {
		vars[k] = v
	}
	for k, v := range input.Variables {
		vars[k] = v
	}

	stageIdx := make(map[string]int, len(ci.stages))
	for i, s := range ci.stages {
		stageIdx[s] = i
	}

	jobs := []Job{}
	for name, raw := range ci.jobs {
		if strings.HasPrefix(name, ".") {
			continue // template / hidden job
		}
		j := processJob(name, raw, vars, stageIdx)
		jobs = append(jobs, j)
	}

	// A job with no stage: defaults to "test", which may not be in the declared
	// stages list. Insert any missing stages before .post so the graph renders them
	// in a real column rather than overlapping with .pre (column 0 fallback).
	var warnings []string
	for _, j := range jobs {
		if _, ok := stageIdx[j.Stage]; !ok {
			warnings = append(warnings, fmt.Sprintf("job %q references stage %q which is not defined in stages", j.Name, j.Stage))
			insert := len(ci.stages) - 1
			if insert < 0 {
				insert = 0
			}
			ci.stages = append(ci.stages[:insert:insert], append([]string{j.Stage}, ci.stages[insert:]...)...)
			for i, s := range ci.stages {
				stageIdx[s] = i
			}
		}
	}

	sort.Slice(jobs, func(i, k int) bool {
		si, sk := stageIdx[jobs[i].Stage], stageIdx[jobs[k].Stage]
		if si != sk {
			return si < sk
		}
		return jobs[i].Name < jobs[k].Name
	})

	// GitLab rule: a pipeline with only .pre/.post jobs does not run.
	hasMiddleJob := false
	for _, j := range jobs {
		if j.Enabled && j.Stage != ".pre" && j.Stage != ".post" {
			hasMiddleJob = true
			break
		}
	}
	if !hasMiddleJob {
		for i := range jobs {
			jobs[i].Enabled = false
		}
	}

	return &Output{
		Stages:             ci.stages,
		Jobs:               jobs,
		Edges:              computeEdges(jobs, stageIdx),
		SuggestedBranches:  extractSuggestedBranches(ci),
		SuggestedVariables: extractSuggestedVariables(ci),
		Warnings:           warnings,
	}, nil
}

func processJob(name string, raw map[string]interface{}, vars map[string]string, stageIdx map[string]int) Job {
	stage := getStr(raw, "stage")
	if stage == "" {
		stage = "test"
	}
	if _, ok := stageIdx[stage]; !ok {
		stage = "test"
	}

	j := Job{
		Name:         name,
		Stage:        stage,
		When:         "on_success",
		Needs:        []string{},
		RulesTrace:   []RuleTrace{},
		AllowFailure:  getBool(raw, "allow_failure", false),
		Interruptible: getBool(raw, "interruptible", false),
		Image:        extractImage(raw["image"]),
		ResourceGroup: getStr(raw, "resource_group"),
		Environment:  extractEnvironment(raw["environment"]),
		Tags:         extractTags(raw["tags"]),
	}

	// Job-level variables (merged for rule evaluation)
	jobVars := extractVarMap(raw["variables"])
	j.Variables = jobVars

	// Artifacts
	if a, ok := raw["artifacts"]; ok {
		j.Artifacts = extractArtifacts(a)
	}

	// Needs
	if n, ok := raw["needs"]; ok {
		j.HasExplicitNeeds = true
		j.Needs = extractNeeds(n)
	}

	// Parallel / matrix
	j.ParallelCount, j.MatrixInstances = extractParallel(raw["parallel"])

	// Merge job vars into effective vars for rule evaluation
	effectiveVars := make(map[string]string, len(vars)+len(jobVars))
	for k, v := range vars {
		effectiveVars[k] = v
	}
	for k, v := range jobVars {
		effectiveVars[k] = v
	}

	// Determine when/enabled via rules or only/except
	j.When, j.Enabled, j.RulesTrace = evalRules(raw, effectiveVars)
	return j
}

// ---- rule evaluation ----

func evalRules(raw map[string]interface{}, vars map[string]string) (when string, enabled bool, trace []RuleTrace) {
	jobWhen := getStr(raw, "when")
	if jobWhen == "" {
		jobWhen = "on_success"
	}

	if rulesRaw, ok := raw["rules"]; ok {
		return evalRulesBlock(rulesRaw, vars)
	}

	onlyRaw, hasOnly := raw["only"]
	exceptRaw, hasExcept := raw["except"]
	if hasOnly || hasExcept {
		return evalOnlyExcept(onlyRaw, exceptRaw, vars, jobWhen)
	}

	if jobWhen == "never" {
		return "never", false, nil
	}
	return jobWhen, true, nil
}

func evalRulesBlock(rulesRaw interface{}, vars map[string]string) (string, bool, []RuleTrace) {
	list, ok := rulesRaw.([]interface{})
	if !ok {
		return "on_success", true, nil
	}

	flat := make([]interface{}, 0, len(list))
	var flatten func(interface{})
	flatten = func(val interface{}) {
		switch v := val.(type) {
		case []interface{}:
			for _, item := range v {
				flatten(item)
			}
		case map[string]interface{}:
			flat = append(flat, v)
		}
	}
	for _, item := range list {
		flatten(item)
	}
	if len(flat) == 0 {
		return "on_success", true, nil
	}

	var trace []RuleTrace
	for i, item := range flat {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}

		ifExpr := getStr(m, "if")
		ruleWhen := getStr(m, "when")
		if ruleWhen == "" {
			ruleWhen = "on_success"
		}

		matched := true
		if ifExpr != "" {
			var err error
			matched, err = EvalExpr(ifExpr, vars)
			if err != nil {
				matched = false
			}
		}

		// changes/exists treated as always-matching (no filesystem context)
		t := RuleTrace{RuleIndex: i, Condition: ifExpr, Matched: matched, When: ruleWhen}
		trace = append(trace, t)

		if matched {
			return ruleWhen, ruleWhen != "never", trace
		}
	}

	// No rule matched
	return "never", false, trace
}

func evalOnlyExcept(onlyRaw, exceptRaw interface{}, vars map[string]string, jobWhen string) (string, bool, []RuleTrace) {
	branch := vars["CI_COMMIT_BRANCH"]
	tag := vars["CI_COMMIT_TAG"]
	source := vars["CI_PIPELINE_SOURCE"]

	if onlyRefs := extractOnlyExceptRefs(onlyRaw); len(onlyRefs) > 0 {
		matched := false
		for _, ref := range onlyRefs {
			if matchRef(ref, branch, tag, source) {
				matched = true
				break
			}
		}
		if !matched {
			return "never", false, []RuleTrace{{
				Condition: fmt.Sprintf("only: %v", onlyRefs), Matched: false,
			}}
		}
	}

	if exceptRefs := extractOnlyExceptRefs(exceptRaw); len(exceptRefs) > 0 {
		for _, ref := range exceptRefs {
			if matchRef(ref, branch, tag, source) {
				return "never", false, []RuleTrace{{
					Condition: fmt.Sprintf("except: %v", exceptRefs), Matched: true,
				}}
			}
		}
	}

	if jobWhen == "never" {
		return "never", false, nil
	}
	return jobWhen, true, nil
}

func extractOnlyExceptRefs(raw interface{}) []string {
	switch v := raw.(type) {
	case []interface{}:
		return toStrSlice(v)
	case map[string]interface{}:
		if refs, ok := v["refs"]; ok {
			return toStrSlice(refs)
		}
	}
	return nil
}

func matchRef(ref, branch, tag, source string) bool {
	switch ref {
	case "branches":
		return branch != ""
	case "tags":
		return tag != ""
	case "merge_requests":
		return source == "merge_request_event"
	case "schedules":
		return source == "schedule"
	case "pipelines":
		return source == "pipeline"
	case "pushes":
		return source == "push"
	default:
		if strings.HasPrefix(ref, "/") && strings.HasSuffix(ref, "/") {
			pattern := ref[1 : len(ref)-1]
			re, err := regexp.Compile(pattern)
			if err != nil {
				return false
			}
			return re.MatchString(branch) || re.MatchString(tag)
		}
		return branch == ref || tag == ref
	}
}

// ---- edge computation ----

func computeEdges(jobs []Job, stageIdx map[string]int) []Edge {
	edges := []Edge{}

	// Build: stageIndex → []enabled job names with that stage.
	// Disabled jobs are excluded so that a stage where all jobs are disabled is
	// treated as empty, letting the backward search reach the last non-empty stage.
	stageJobs := make(map[int][]string)
	for _, j := range jobs {
		if !j.Enabled {
			continue
		}
		if idx, ok := stageIdx[j.Stage]; ok {
			stageJobs[idx] = append(stageJobs[idx], j.Name)
		}
	}

	for _, j := range jobs {
		if j.HasExplicitNeeds {
			for _, need := range j.Needs {
				edges = append(edges, Edge{From: need, To: j.Name, Type: "needs"})
			}
			// empty needs means "start immediately", no edges
			continue
		}

		// Stage-based implicit ordering
		myIdx := stageIdx[j.Stage]
		for prevIdx := myIdx - 1; prevIdx >= 0; prevIdx-- {
			if prevJobs, ok := stageJobs[prevIdx]; ok && len(prevJobs) > 0 {
				for _, pj := range prevJobs {
					edges = append(edges, Edge{From: pj, To: j.Name, Type: "stage"})
				}
				break
			}
		}
	}

	return edges
}

// ---- field extractors ----

func extractImage(raw interface{}) string {
	switch v := raw.(type) {
	case string:
		return v
	case map[string]interface{}:
		return getStr(v, "name")
	}
	return ""
}

func extractEnvironment(raw interface{}) string {
	switch v := raw.(type) {
	case string:
		return v
	case map[string]interface{}:
		return getStr(v, "name")
	}
	return ""
}

func extractTags(raw interface{}) []string {
	return toStrSlice(raw)
}

func extractVarMap(raw interface{}) map[string]string {
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		switch vv := v.(type) {
		case map[string]interface{}:
			if s, ok := vv["value"]; ok {
				out[k] = fmt.Sprintf("%v", s)
			}
		default:
			out[k] = fmt.Sprintf("%v", vv)
		}
	}
	return out
}

func extractArtifacts(raw interface{}) *Artifacts {
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	a := &Artifacts{
		ExpireIn: getStr(m, "expire_in"),
		When:     getStr(m, "when"),
	}
	if paths, ok := m["paths"]; ok {
		a.Paths = toStrSlice(paths)
	}
	if reports, ok := m["reports"]; ok {
		if rm, ok := reports.(map[string]interface{}); ok {
			a.Reports = make(map[string][]string)
			for k, v := range rm {
				a.Reports[k] = toStrSlice(v)
			}
		}
	}
	if a.Paths == nil && a.Reports == nil && a.ExpireIn == "" && a.When == "" {
		return nil
	}
	return a
}

func extractNeeds(raw interface{}) []string {
	var out []string
	var flatten func(val interface{})
	flatten = func(val interface{}) {
		switch v := val.(type) {
		case []interface{}:
			for _, item := range v {
				flatten(item)
			}
		case string:
			out = append(out, v)
		case map[string]interface{}:
			if job, ok := v["job"]; ok {
				out = append(out, fmt.Sprintf("%v", job))
			}
		}
	}
	flatten(raw)
	return out
}

func extractParallel(raw interface{}) (count int, instances []MatrixInstance) {
	if raw == nil {
		return 0, nil
	}
	switch v := raw.(type) {
	case int:
		return v, nil
	case map[string]interface{}:
		matrixRaw, ok := v["matrix"]
		if !ok {
			return 0, nil
		}
		matrixList, ok := matrixRaw.([]interface{})
		if !ok {
			return 0, nil
		}
		instances = expandMatrix(matrixList)
		return len(instances), instances
	}
	return 0, nil
}

// expandMatrix produces all combinations from a list of variable-dimension maps.
func expandMatrix(matrixList []interface{}) []MatrixInstance {
	// Each entry in matrixList is a map of varName → [values...]
	// Produce cartesian product across entries, then across dimensions within each entry.
	var all []MatrixInstance

	for _, entry := range matrixList {
		entryMap, ok := entry.(map[string]interface{})
		if !ok {
			continue
		}
		// Collect dimensions: [{key, []values}]
		type dim struct {
			key  string
			vals []string
		}
		var dims []dim
		for k, v := range entryMap {
			dims = append(dims, dim{key: k, vals: toStrSlice(v)})
		}
		// Sort for determinism
		sort.Slice(dims, func(i, j int) bool { return dims[i].key < dims[j].key })

		// Cartesian product of dims
		var combinations []map[string]string
		combinations = append(combinations, map[string]string{})
		for _, d := range dims {
			var next []map[string]string
			for _, combo := range combinations {
				for _, val := range d.vals {
					newCombo := make(map[string]string, len(combo)+1)
					for k, v := range combo {
						newCombo[k] = v
					}
					newCombo[d.key] = val
					next = append(next, newCombo)
				}
			}
			combinations = next
		}

		for _, combo := range combinations {
			// Build a display name from sorted key:value pairs
			var parts []string
			var keys []string
			for k := range combo {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				parts = append(parts, k+":"+combo[k])
			}
			all = append(all, MatrixInstance{
				Variables: combo,
				Name:      "[" + strings.Join(parts, ", ") + "]",
			})
		}
	}
	return all
}

// ---- branch suggestion extraction ----

var onlyExceptKeywords = map[string]bool{
	"branches": true, "tags": true, "api": true, "external": true,
	"pipelines": true, "pushes": true, "schedules": true, "triggers": true,
	"web": true, "merge_requests": true, "external_pull_requests": true, "chat": true,
}

var candidateBranches = []string{
	"main", "master", "develop", "development",
	"feature/test", "feature-test",
	"release/1.0.0", "release-1.0.0",
	"hotfix/fix", "hotfix-fix",
	"v1.0.0", "v1.0",
}

func extractSuggestedBranches(ci *parsedCI) []string {
	seen := make(map[string]bool)
	var result []string

	add := func(b string) {
		if b != "" && !seen[b] {
			seen[b] = true
			result = append(result, b)
		}
	}

	for name, raw := range ci.jobs {
		if strings.HasPrefix(name, ".") {
			continue
		}
		for _, section := range []string{"only", "except"} {
			if v, ok := raw[section]; ok {
				for _, ref := range extractOnlyExceptRefs(v) {
					add(refToBranchExample(ref))
				}
			}
		}
		if rulesRaw, ok := raw["rules"]; ok {
			if list, ok := rulesRaw.([]interface{}); ok {
				for _, item := range list {
					if m, ok := item.(map[string]interface{}); ok {
						if expr := getStr(m, "if"); expr != "" {
							for _, b := range branchesFromExpr(expr) {
								add(b)
							}
						}
					}
				}
			}
		}
	}

	sort.Strings(result)
	return result
}

func refToBranchExample(ref string) string {
	if onlyExceptKeywords[ref] {
		return ""
	}
	if strings.HasPrefix(ref, "/") && strings.HasSuffix(ref, "/") {
		return regexToBranchExample(ref[1 : len(ref)-1])
	}
	return ref
}

// branchesFromExpr scans a rules:if expression for $CI_COMMIT_BRANCH comparisons.
func branchesFromExpr(expr string) []string {
	var result []string
	l := newLexer(expr)
	var tokens []tok
	for {
		t := l.next()
		tokens = append(tokens, t)
		if t.kind == tkEOF {
			break
		}
	}
	for i, t := range tokens {
		if t.kind != tkVar || (t.val != "CI_COMMIT_BRANCH" && t.val != "CI_COMMIT_REF_NAME") {
			continue
		}
		if i+2 >= len(tokens) {
			continue
		}
		op, val := tokens[i+1], tokens[i+2]
		switch op.kind {
		case tkEq:
			if val.kind == tkStr {
				result = append(result, val.val)
			}
		case tkMatch:
			if val.kind == tkRegex || val.kind == tkStr {
				if ex := regexToBranchExample(stripRegexDelimiters(val.val)); ex != "" {
					result = append(result, ex)
				}
			}
		}
	}
	return result
}

func regexToBranchExample(pattern string) string {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return ""
	}
	for _, c := range candidateBranches {
		if re.MatchString(c) {
			return c
		}
	}
	// Fallback: simplify the pattern into a plausible branch name hint
	p := pattern
	p = strings.TrimPrefix(p, "(?i)")
	p = strings.TrimPrefix(p, "^")
	p = strings.TrimSuffix(p, "$")
	p = strings.ReplaceAll(p, ".*", "example")
	p = strings.ReplaceAll(p, ".+", "example")
	p = strings.ReplaceAll(p, `\d+`, "1")
	p = strings.ReplaceAll(p, `\d*`, "")
	p = strings.ReplaceAll(p, `\w+`, "word")
	p = strings.ReplaceAll(p, `\w*`, "word")
	p = strings.ReplaceAll(p, `\`, "")
	p = regexp.MustCompile(`\[[^\]]*\][*+?]?`).ReplaceAllString(p, "x")
	p = strings.NewReplacer("(", "", ")", "", "?", "", "|", "-").Replace(p)
	p = strings.TrimSpace(p)
	if p == "" {
		return "branch-name"
	}
	return p
}

// ---- variable key suggestion extraction ----

// predefined GitLab CI variables already covered by the UI's dedicated fields.
var predefinedCIVars = map[string]bool{
	"CI_COMMIT_BRANCH":    true,
	"CI_COMMIT_TAG":       true,
	"CI_PIPELINE_SOURCE":  true,
	"CI_COMMIT_REF_NAME":  true,
}

func extractSuggestedVariables(ci *parsedCI) []string {
	seen := make(map[string]bool)
	var result []string

	add := func(k string) {
		// Skip GitLab predefined variables (CI_* / GITLAB_*) except ones
		// the user might legitimately override in rules conditions.
		if predefinedCIVars[k] {
			return
		}
		if strings.HasPrefix(k, "CI_") || strings.HasPrefix(k, "GITLAB_") {
			return
		}
		if !seen[k] {
			seen[k] = true
			result = append(result, k)
		}
	}

	// Global variables:
	for k := range ci.variables {
		add(k)
	}

	// Variables referenced in rules:if across all jobs:
	for name, raw := range ci.jobs {
		if strings.HasPrefix(name, ".") {
			continue
		}
		if rulesRaw, ok := raw["rules"]; ok {
			if list, ok := rulesRaw.([]interface{}); ok {
				for _, item := range list {
					if m, ok := item.(map[string]interface{}); ok {
						if expr := getStr(m, "if"); expr != "" {
							for _, k := range varsFromExpr(expr) {
								add(k)
							}
						}
					}
				}
			}
		}
	}

	sort.Strings(result)
	return result
}

// varsFromExpr tokenizes a rules:if expression and returns all $VAR names.
func varsFromExpr(expr string) []string {
	var result []string
	l := newLexer(expr)
	for {
		t := l.next()
		if t.kind == tkEOF {
			break
		}
		if t.kind == tkVar {
			result = append(result, t.val)
		}
	}
	return result
}
