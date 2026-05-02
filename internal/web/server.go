package web

import (
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
)

//go:embed static/*
var staticFiles embed.FS

func Register(mux *http.ServeMux, logger *slog.Logger) {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		requested := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requested == "." || requested == "" {
			serveIndex(w, r, sub)
			return
		}
		if _, err := fs.Stat(sub, requested); err == nil {
			setCachePolicy(w, requested)
			fileServer.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		logger.Debug("serving SPA fallback", "path", r.URL.Path)
		serveIndex(w, r, sub)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, sub fs.FS) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFileFS(w, r, sub, "index.html")
}

func setCachePolicy(w http.ResponseWriter, requested string) {
	if requested == "index.html" || strings.HasSuffix(requested, ".html") {
		w.Header().Set("Cache-Control", "no-store")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
}
