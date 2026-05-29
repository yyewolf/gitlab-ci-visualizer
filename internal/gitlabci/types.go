package gitlabci

// Input is the request body for POST /api/analyze.
type Input struct {
	YAML      string            `json:"yaml"`
	Variables map[string]string `json:"variables"`
}

// Output is the JSON returned from POST /api/analyze.
type Output struct {
	Stages             []string `json:"stages"`
	Jobs               []Job    `json:"jobs"`
	Edges              []Edge   `json:"edges"`
	ArtifactEdges      []Edge   `json:"artifact_edges,omitempty"`
	SuggestedBranches  []string `json:"suggested_branches,omitempty"`
	SuggestedVariables []string `json:"suggested_variables,omitempty"`
	Warnings           []string `json:"warnings,omitempty"`
	Error              string   `json:"error,omitempty"`
}

// Job is a resolved, analysed CI job.
type Job struct {
	Name             string            `json:"name"`
	Stage            string            `json:"stage"`
	Enabled          bool              `json:"enabled"`
	When             string            `json:"when"`
	AllowFailure     bool              `json:"allow_failure"`
	Interruptible    bool              `json:"interruptible"`
	Image            string            `json:"image,omitempty"`
	Needs            []string          `json:"needs"`
	HasExplicitNeeds bool              `json:"has_explicit_needs"`
	Artifacts        *Artifacts        `json:"artifacts,omitempty"`
	Variables        map[string]string `json:"variables,omitempty"`
	Tags             []string          `json:"tags,omitempty"`
	Environment      string            `json:"environment,omitempty"`
	ResourceGroup    string            `json:"resource_group,omitempty"`
	ParallelCount    int               `json:"parallel_count,omitempty"`
	MatrixInstances  []MatrixInstance  `json:"matrix_instances,omitempty"`
	RulesTrace       []RuleTrace       `json:"rules_trace"`
	Retry               int         `json:"retry,omitempty"`
	Release             bool        `json:"release,omitempty"`
	Coverage            bool        `json:"coverage,omitempty"`
	Pages               bool        `json:"pages,omitempty"`
	NeedsNoArtifacts    []string    `json:"needs_no_artifacts,omitempty"`
	Dependencies        *[]string   `json:"dependencies,omitempty"`
	Trigger             *TriggerInfo `json:"trigger,omitempty"`
}

// TriggerInfo describes a trigger: keyword pointing to a downstream pipeline.
// Exactly one of Project (multi-project) or Include (parent-child / local) is set.
type TriggerInfo struct {
	Project  string `json:"project,omitempty"`  // multi-project: "group/project"
	Branch   string `json:"branch,omitempty"`   // target branch for multi-project
	Strategy string `json:"strategy,omitempty"` // "depend" etc.
	Include  string `json:"include,omitempty"`  // local file path for parent-child
}

// Artifacts holds the artifact configuration of a job.
type Artifacts struct {
	Paths    []string            `json:"paths,omitempty"`
	Reports  map[string][]string `json:"reports,omitempty"`
	ExpireIn string              `json:"expire_in,omitempty"`
	When     string              `json:"when,omitempty"`
}

// MatrixInstance is one expanded instance of a parallel:matrix job.
type MatrixInstance struct {
	Variables map[string]string `json:"variables"`
	Name      string            `json:"name"`
}

// Edge is a dependency between two jobs.
type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type"` // "needs" or "stage"
}

// RuleTrace records why a rule did or did not match.
type RuleTrace struct {
	RuleIndex int    `json:"rule_index"`
	Condition string `json:"condition,omitempty"`
	Matched   bool   `json:"matched"`
	When      string `json:"when,omitempty"`
}
