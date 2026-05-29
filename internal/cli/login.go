package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/auth"
	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlab"
)

// loginCmd prompts for a GitLab instance + PAT, validates it, and stores it in
// the OS keychain (falling back to a plaintext file with a warning).
//
// It also supports a non-interactive mode used by the VSCode extension:
//
//	glvis login --instance https://gitlab.com --stdin   # token read from stdin
func loginCmd() *cobra.Command {
	var (
		instanceFlag string
		stdin        bool
	)

	cmd := &cobra.Command{
		Use:           "login",
		Short:         "Store GitLab credentials for include/downstream resolution",
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			instance := instanceFlag
			var token string

			if stdin {
				// Non-interactive: instance from flag, token from stdin.
				if instance == "" {
					return fmt.Errorf("--instance is required with --stdin")
				}
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					return fmt.Errorf("reading token from stdin: %w", err)
				}
				token = strings.TrimSpace(string(data))
				if token == "" {
					return fmt.Errorf("empty token on stdin")
				}
			} else {
				if instance == "" {
					instance = "https://gitlab.com"
				}
				form := huh.NewForm(
					huh.NewGroup(
						huh.NewInput().
							Title("GitLab instance URL").
							Value(&instance).
							Validate(required),
						huh.NewInput().
							Title("Personal Access Token").
							Description("Needs the \"api\" scope.").
							EchoMode(huh.EchoModePassword).
							Value(&token).
							Validate(required),
					),
				)
				if err := form.Run(); err != nil {
					return err
				}
			}

			instance = strings.TrimRight(strings.TrimSpace(instance), "/")
			cfg := gitlab.Config{URL: instance, Token: strings.TrimSpace(token)}

			user, err := cfg.ValidateToken(context.Background())
			if err != nil {
				return fmt.Errorf("token validation failed: %w", err)
			}
			cmd.Printf("Authenticated as %s on %s\n", user, instance)

			usedFile, err := auth.Save(auth.Credentials{Instance: instance, Token: cfg.Token})
			if err != nil {
				return fmt.Errorf("storing credentials: %w", err)
			}
			if usedFile {
				cmd.PrintErrln("warning: no OS keychain available — token stored in plaintext under your config dir (~/.config/glvis/credentials.json)")
			} else {
				cmd.Println("Credentials stored in your OS keychain.")
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&instanceFlag, "instance", "", "GitLab instance URL (skips the prompt)")
	cmd.Flags().BoolVar(&stdin, "stdin", false, "read the token from stdin (non-interactive; requires --instance)")
	return cmd
}

func required(s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("required")
	}
	return nil
}
