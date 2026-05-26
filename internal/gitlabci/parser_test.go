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
		"nil":     {nil, nil},
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
			nil,
		},
		"array with non-string elements skipped": {
			[]interface{}{"a", 123, map[string]interface{}{"key": "value"}, "b"},
			[]string{"a", "b"},
		},
		"empty nested arrays": {
			[]interface{}{[]interface{}{}, []interface{}{[]interface{}{}}},
			nil,
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
		"nil":    {nil, nil},
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
			nil,
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
