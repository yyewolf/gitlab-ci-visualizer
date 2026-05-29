// Package auth stores GitLab credentials, preferring the OS keychain and
// falling back to a plaintext file under ~/.config/glvis when no keychain is
// available (with a warning printed by callers).
package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// keyringService is the service name used for keychain entries.
const keyringService = "glvis"

// Credentials is a GitLab instance URL plus its token.
type Credentials struct {
	Instance string `json:"instance"`
	Token    string `json:"token"`
}

// ErrNotFound is returned when no credentials are stored for an instance.
var ErrNotFound = errors.New("no stored credentials")

// Save stores creds, keyed by instance. It returns usedFile=true when it had to
// fall back to the plaintext file because the keychain was unavailable, so the
// caller can warn the user.
func Save(creds Credentials) (usedFile bool, err error) {
	data, err := json.Marshal(creds)
	if err != nil {
		return false, err
	}
	if err := keyring.Set(keyringService, creds.Instance, string(data)); err == nil {
		return false, nil
	}
	return true, saveFile(creds)
}

// Load returns the credentials stored for instance, checking the keychain first
// then the file fallback. Returns ErrNotFound if neither has an entry.
func Load(instance string) (Credentials, error) {
	if raw, err := keyring.Get(keyringService, instance); err == nil {
		var creds Credentials
		if err := json.Unmarshal([]byte(raw), &creds); err == nil {
			return creds, nil
		}
	}
	return loadFile(instance)
}

func saveFile(creds Credentials) error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	all, err := readFileCreds()
	if err != nil {
		return err
	}
	all[creds.Instance] = creds

	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "credentials.json"), data, 0o600)
}

func loadFile(instance string) (Credentials, error) {
	all, err := readFileCreds()
	if err != nil {
		return Credentials{}, err
	}
	if creds, ok := all[instance]; ok {
		return creds, nil
	}
	return Credentials{}, ErrNotFound
}

func readFileCreds() (map[string]Credentials, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]Credentials{}, nil
	}
	if err != nil {
		return nil, err
	}
	all := map[string]Credentials{}
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	return all, nil
}

func configDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "glvis"), nil
}
