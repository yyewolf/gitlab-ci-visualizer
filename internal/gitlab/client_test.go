package gitlab

import "testing"

func TestDetectProject(t *testing.T) {
	cases := []struct {
		name, remote, want string
	}{
		{"ssh", "git@gitlab.com:group/project.git", "group/project"},
		{"ssh no suffix", "git@gitlab.com:group/sub/project", "group/sub/project"},
		{"https", "https://gitlab.com/group/project.git", "group/project"},
		{"https no suffix", "https://gitlab.com/group/project", "group/project"},
		{"https nested", "https://gitlab.example.com/a/b/c.git", "a/b/c"},
		{"empty", "", ""},
		{"trailing newline", "git@gitlab.com:group/project.git\n", "group/project"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := DetectProject(c.remote); got != c.want {
				t.Errorf("DetectProject(%q) = %q, want %q", c.remote, got, c.want)
			}
		})
	}
}
