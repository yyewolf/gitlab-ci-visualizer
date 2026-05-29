package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/auth"
	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlab"
)

// loginCmd prompts for a GitLab instance + PAT, validates it, and stores it in
// the OS keychain (falling back to a plaintext file with a warning).
func loginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Store GitLab credentials for include/downstream resolution",
		RunE: func(cmd *cobra.Command, args []string) error {
			instance := "https://gitlab.com"
			var token string

			form := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("GitLab instance URL").
						Value(&instance).
						Validate(func(s string) error {
							if strings.TrimSpace(s) == "" {
								return fmt.Errorf("required")
							}
							return nil
						}),
					huh.NewInput().
						Title("Personal Access Token").
						Description("Needs the \"api\" scope.").
						Password(true).
						Value(&token).
						Validate(func(s string) error {
							if strings.TrimSpace(s) == "" {
								return fmt.Errorf("required")
							}
							return nil
						}),
				),
			)
			if err := form.Run(); err != nil {
				return err
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
}
