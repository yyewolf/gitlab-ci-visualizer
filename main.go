package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/cli"
)

//go:embed web/dist
var webFS embed.FS

//go:embed samples
var samplesFS embed.FS

func main() {
	if err := cli.Execute(cli.Assets{WebFS: webFS, SamplesFS: samplesFS}); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
