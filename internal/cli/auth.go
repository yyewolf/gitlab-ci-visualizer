package cli

import (
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/auth"
)

// authCmd groups credential-store inspection commands. Storing happens via
// `glvis login`; this is mainly for the VSCode extension to check whether a
// token is already configured for an instance.
func authCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Inspect stored GitLab credentials",
	}
	cmd.AddCommand(authStatusCmd())
	return cmd
}

func authStatusCmd() *cobra.Command {
	var instance string
	cmd := &cobra.Command{
		Use:           "status",
		Short:         "Exit 0 if a token is stored for --instance, non-zero otherwise",
		SilenceUsage:  true,
		SilenceErrors: true,
		Run: func(cmd *cobra.Command, args []string) {
			inst := strings.TrimRight(instance, "/")
			if inst == "" {
				inst = "https://gitlab.com"
			}
			creds, err := auth.Load(inst)
			if err != nil || creds.Token == "" {
				cmd.Printf("not configured: %s\n", inst)
				os.Exit(1)
			}
			cmd.Printf("configured: %s\n", inst)
		},
	}
	cmd.Flags().StringVar(&instance, "instance", "", "GitLab instance URL (default https://gitlab.com)")
	return cmd
}
