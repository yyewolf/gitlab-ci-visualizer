package gitlabci

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// reserved top-level keys that are not job names
var reservedKeys = map[string]bool{
	"stages": true, "variables": true, "default": true,
	"workflow": true, "include": true, "image": true,
	"services": true, "before_script": true, "after_script": true,
	"cache": true, "artifacts": true,
}

// parsedCI holds the extracted configuration.
type parsedCI struct {
	stages    []string
	variables map[string]string
	jobs      map[string]map[string]interface{} // all jobs, including hidden
}

func parseYAML(src string) (*parsedCI, error) {
	var raw map[string]interface{}
	if err := yaml.Unmarshal([]byte(src), &raw); err != nil {
		return nil, fmt.Errorf("YAML parse error: %w", err)
	}

	ci := &parsedCI{
		variables: make(map[string]string),
		jobs:      make(map[string]map[string]interface{}),
	}

	// Stages
	if v, ok := raw["stages"]; ok {
		ci.stages = toStrSlice(v)
	}
	if len(ci.stages) == 0 {
		ci.stages = []string{".pre", "build", "test", "deploy", ".post"}
	} else {
		hasPre, hasPost := false, false
		for _, s := range ci.stages {
			if s == ".pre" {
				hasPre = true
			}
			if s == ".post" {
				hasPost = true
			}
		}
		if !hasPre {
			ci.stages = append([]string{".pre"}, ci.stages...)
		}
		if !hasPost {
			ci.stages = append(ci.stages, ".post")
		}
	}

	// Global variables
	if v, ok := raw["variables"]; ok {
		if m, ok := v.(map[string]interface{}); ok {
			for k, val := range m {
				switch vv := val.(type) {
				case map[string]interface{}:
					// value: may have "value" and "description" keys
					if s, ok := vv["value"]; ok {
						ci.variables[k] = fmt.Sprintf("%v", s)
					}
				default:
					ci.variables[k] = fmt.Sprintf("%v", vv)
				}
			}
		}
	}

	// Extract jobs (anything not reserved)
	for key, val := range raw {
		if reservedKeys[key] {
			continue
		}
		m, ok := val.(map[string]interface{})
		if !ok {
			continue
		}
		ci.jobs[key] = m
	}

	resolveExtends(ci)
	return ci, nil
}

// resolveExtends does a single pass of extends resolution (no multi-hop needed
// because the input is expected to be already-merged, but we handle it anyway).
func resolveExtends(ci *parsedCI) {
	for name, job := range ci.jobs {
		raw, ok := job["extends"]
		if !ok {
			continue
		}
		var parents []string
		switch v := raw.(type) {
		case string:
			parents = []string{v}
		case []interface{}:
			for _, p := range v {
				if s, ok := p.(string); ok {
					parents = append(parents, s)
				}
			}
		}

		merged := make(map[string]interface{})
		for _, parent := range parents {
			if p, ok := ci.jobs[parent]; ok {
				deepMergeInto(merged, p)
			}
		}
		deepMergeInto(merged, job) // child wins
		delete(merged, "extends")
		ci.jobs[name] = merged
	}
}

// deepMergeInto copies src into dst; existing dst keys win (child-wins semantics
// when called after parent is already in dst).
func deepMergeInto(dst, src map[string]interface{}) {
	for k, v := range src {
		if _, exists := dst[k]; exists {
			if srcM, ok := v.(map[string]interface{}); ok {
				if dstM, ok := dst[k].(map[string]interface{}); ok {
					deepMergeInto(dstM, srcM)
					continue
				}
			}
			// dst wins
			continue
		}
		dst[k] = v
	}
}

// ---- helpers ----

func toStrSlice(v interface{}) []string {
	result := []string{}
	var flatten func(val interface{})
	flatten = func(val interface{}) {
		switch vVal := val.(type) {
		case []interface{}:
			for _, item := range vVal {
				flatten(item)
			}
		case string:
			result = append(result, vVal)
		}
	}
	flatten(v)
	return result
}

func getStr(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func getBool(m map[string]interface{}, key string, def bool) bool {
	v, ok := m[key]
	if !ok {
		return def
	}
	switch val := v.(type) {
	case bool:
		return val
	case string:
		return strings.EqualFold(val, "true")
	}
	return def
}
