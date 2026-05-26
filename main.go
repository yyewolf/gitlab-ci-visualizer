package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlabci"
)

//go:embed web/dist
var webFS embed.FS

func main() {
	serve := flag.String("serve", "", "address to listen on (e.g. :3001)")
	flag.Parse()

	if *serve != "" {
		runServer(*serve)
		return
	}

	// Stdin/stdout protocol — used by the VSCode extension.
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fatal(err)
	}

	var input gitlabci.Input
	if err := json.Unmarshal(data, &input); err != nil {
		fatal(err)
	}

	result, err := gitlabci.Analyze(input)
	if err != nil {
		fatal(err)
	}

	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "error: %v\n", err)
	os.Exit(1)
}

func runServer(addr string) {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/analyze", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var input gitlabci.Input
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		result, err := gitlabci.Analyze(input)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(result); err != nil {
			log.Printf("encode response: %v", err)
		}
	})

	// Frontend (SPA).
	distSub, err := fs.Sub(webFS, "web/dist")
	if err != nil {
		log.Fatalf("web/dist embed: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(distSub)))

	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
