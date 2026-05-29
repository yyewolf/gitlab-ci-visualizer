package cli

import (
	"github.com/spf13/cobra"
)

// loginCmd prompts for a GitLab instance + PAT and stores it (keychain with a
// file fallback). The interactive form and storage land in later steps; this
// wires the command into the tree.
func loginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Store GitLab credentials for include/downstream resolution",
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.Println("login: not implemented yet")
			return nil
		},
	}
}
