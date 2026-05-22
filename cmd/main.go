package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/yyewolf/gitlab-ci-visualizer/internal/gitlabci"
)

func main() {
	serve := flag.String("serve", "", "serve HTTP API on this address (e.g. :3001)")
	flag.Parse()

	if *serve != "" {
		runServer(*serve)
		return
	}

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

	mux.HandleFunc("/analyze", func(w http.ResponseWriter, r *http.Request) {
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
		json.NewEncoder(w).Encode(result)
	})

	// Serve sample YAML files from ./samples/
	mux.Handle("/samples/", http.StripPrefix("/samples/", http.FileServer(http.Dir("samples"))))

	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
