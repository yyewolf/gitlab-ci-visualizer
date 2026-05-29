package gitlabci

import (
	"reflect"
	"testing"
)

func TestToStrSlice(t *testing.T) {
	tests := map[string]struct {
		input    interface{}
		expected []string
	}{
		"nil":     {nil, []string{}},
		"string":  {"single", []string{"single"}},
		"flat array": {
			[]interface{}{"a", "b", "c"},
			[]string{"a", "b", "c"},
		},
		"nested array one level": {
			[]interface{}{[]interface{}{"a", "b"}, "c"},
			[]string{"a", "b", "c"},
		},
		"deeply nested array": {
			[]interface{}{[]interface{}{[]interface{}{"nested"}}, "flat"},
			[]string{"nested", "flat"},
		},
    "mixed nested arrays": {
      []interface{}{[]interface{}{"a", []interface{}{"b", []interface{}{"c"}}}, "d"},
      []string{"a", "b", "c", "d"},
    },
    "empty array": {
      []interface{}{},
      []string{},
    },
		"array with non-string elements skipped": {
			[]interface{}{"a", 123, map[string]interface{}{"key": "value"}, "b"},
			[]string{"a", "b"},
		},
    "empty nested arrays": {
      []interface{}{[]interface{}{}, []interface{}{[]interface{}{}}},
      []string{},
    },
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			result := toStrSlice(tt.input)
			if !reflect.DeepEqual(result, tt.expected) {
				t.Errorf("toStrSlice() = %v, expected %v", result, tt.expected)
			}
		})
	}
}

func TestExtractNeeds(t *testing.T) {
	tests := map[string]struct {
		input    interface{}
		expected []string
	}{
		"nil":    {nil, []string{}},
		"string": {"single", []string{"single"}},
		"flat array of strings": {
			[]interface{}{"a", "b", "c"},
			[]string{"a", "b", "c"},
		},
		"nested array of strings": {
			[]interface{}{[]interface{}{"a", "b"}, "c"},
			[]string{"a", "b", "c"},
		},
		"deeply nested array": {
			[]interface{}{[]interface{}{[]interface{}{"nested"}}, "flat"},
			[]string{"nested", "flat"},
		},
		"flat array with maps": {
			[]interface{}{
				"a",
				map[string]interface{}{"job": "b"},
				"c",
			},
			[]string{"a", "b", "c"},
		},
		"nested array with maps": {
			[]interface{}{
				[]interface{}{"a", map[string]interface{}{"job": "b"}},
				[]interface{}{"c", map[string]interface{}{"job": "d"}},
			},
			[]string{"a", "b", "c", "d"},
		},
		"empty array": {
			[]interface{}{},
			[]string{},
		},
		"array with non-needs elements skipped": {
			[]interface{}{"a", 123, "b"},
			[]string{"a", "b"},
		},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			result := extractNeeds(tt.input)
			if !reflect.DeepEqual(result, tt.expected) {
				t.Errorf("extractNeeds() = %v, expected %v", result, tt.expected)
			}
		})
	}
}

func TestEvalRulesBlock(t *testing.T) {
	tests := map[string]struct {
		rawRules interface{}
		vars     map[string]string
		wantWhen string
		wantEn   bool
	}{
		"nil rules": {
			rawRules: nil,
			vars:     map[string]string{},
			wantWhen: "on_success",
			wantEn:   true,
		},
		"flat rules - first matches": {
			rawRules: []interface{}{
				map[string]interface{}{"if": "$CI_COMMIT_TAG", "when": "on_success"},
			},
			vars:     map[string]string{"CI_COMMIT_TAG": "v1.0"},
			wantWhen: "on_success",
			wantEn:   true,
		},
		"flat rules - first no match, second matches": {
			rawRules: []interface{}{
				map[string]interface{}{"if": "$CI_COMMIT_TAG", "when": "on_success"},
				map[string]interface{}{"if": "$CI_COMMIT_BRANCH", "when": "on_success"},
			},
			vars:     map[string]string{"CI_COMMIT_BRANCH": "main"},
			wantWhen: "on_success",
			wantEn:   true,
		},
		"flat rules - when never": {
			rawRules: []interface{}{
				map[string]interface{}{"if": "$CI_COMMIT_TAG", "when": "never"},
			},
			vars:     map[string]string{"CI_COMMIT_TAG": "v1.0"},
			wantWhen: "never",
			wantEn:   false,
		},
		"nested array rules - should be flattened": {
			rawRules: []interface{}{
				[]interface{}{
					map[string]interface{}{"if": "$CI_COMMIT_TAG"},
				},
				[]interface{}{
					map[string]interface{}{"if": "$CI_PIPELINE_SOURCE == \"schedule\"", "when": "never"},
				},
				[]interface{}{
					map[string]interface{}{"if": "$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS", "when": "never"},
				},
				[]interface{}{
					map[string]interface{}{"if": "$CI_COMMIT_BRANCH"},
				},
				[]interface{}{
					map[string]interface{}{"if": "$CI_PIPELINE_SOURCE"},
				},
			},
			vars:     map[string]string{"CI_COMMIT_BRANCH": "main", "CI_OPEN_MERGE_REQUESTS": ""},
			wantWhen: "on_success",
			wantEn:   true,
		},
		"nested array rules - matches when never": {
			rawRules: []interface{}{
				[]interface{}{
					map[string]interface{}{"if": "$CI_COMMIT_TAG"},
				},
				[]interface{}{
					map[string]interface{}{"if": "$CI_PIPELINE_SOURCE == \"schedule\"", "when": "never"},
				},
			},
			vars:     map[string]string{"CI_PIPELINE_SOURCE": "schedule"},
			wantWhen: "never",
			wantEn:   false,
		},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			when, enabled, _ := evalRulesBlock(tt.rawRules, tt.vars)
			if when != tt.wantWhen {
				t.Errorf("evalRulesBlock() when = %v, want %v", when, tt.wantWhen)
			}
			if enabled != tt.wantEn {
				t.Errorf("evalRulesBlock() enabled = %v, want %v", enabled, tt.wantEn)
			}
		})
	}
}
