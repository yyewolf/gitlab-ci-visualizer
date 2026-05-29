package cli

import (
	"context"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/server"
)

// Assets bundles the embedded filesystems injected from package main.
type Assets struct {
	WebFS     fs.FS
	SamplesFS fs.FS
}

// Execute is the CLI entrypoint. assets carries the embedded frontend/samples.
func Execute(assets Assets) error {
	var (
		file      string
		addr      string
		noBrowser bool
	)

	root := &cobra.Command{
		Use:   "glvis",
		Short: "Visualize and simulate GitLab CI pipelines",
		Long: "glvis starts a local server, analyzes the .gitlab-ci.yml in the " +
			"current directory (or --file), and opens it in your browser.",
		RunE: func(cmd *cobra.Command, args []string) error {
			resolved := resolveFile(file)

			ctx, stop := signal.NotifyContext(context.Background(),
				os.Interrupt, syscall.SIGTERM)
			defer stop()

			opts := server.Options{
				Addr:      addr,
				WebFS:     assets.WebFS,
				SamplesFS: assets.SamplesFS,
				File:      resolved,
			}

			return server.Serve(ctx, opts, func(url string) {
				if !noBrowser && os.Getenv("GLVIS_NO_BROWSER") == "" {
					_ = openBrowser(url)
				}
			})
		},
	}

	root.Flags().StringVar(&file, "file", "", "path to a .gitlab-ci.yml (default: autodetect in CWD)")
	root.Flags().StringVar(&addr, "addr", "127.0.0.1:0", "listen address (\":0\" picks a random free port)")
	root.Flags().BoolVar(&noBrowser, "no-browser", false, "do not open the browser on start")

	root.AddCommand(loginCmd())

	return root.Execute()
}

// resolveFile returns the explicit --file if given, otherwise the CWD
// .gitlab-ci.yml if it exists, otherwise "".
func resolveFile(file string) string {
	if file != "" {
		return file
	}
	candidate := ".gitlab-ci.yml"
	if _, err := os.Stat(candidate); err == nil {
		abs, err := filepath.Abs(candidate)
		if err == nil {
			return abs
		}
		return candidate
	}
	return ""
}
