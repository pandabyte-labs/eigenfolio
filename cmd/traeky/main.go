package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/pandabytelabs/traeky/internal/cloud"
	"github.com/pandabytelabs/traeky/internal/web"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	addr := env("TRAEKY_ADDR", ":8080")
	mode := strings.ToLower(env("TRAEKY_MODE", "all"))
	dataDir := env("TRAEKY_DATA_DIR", "./data")

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

	switch mode {
	case "all", "app", "web":
		web.Register(mux, logger)
	case "cloud":
		// Cloud-only mode registers only the health endpoint plus the Cloud API below.
	default:
		logger.Error("invalid TRAEKY_MODE", "mode", mode)
		os.Exit(2)
	}

	if mode == "all" || mode == "cloud" {
		store, err := cloud.NewFileStore(dataDir)
		if err != nil {
			logger.Error("failed to initialize cloud store", "err", err)
			os.Exit(1)
		}
		cloud.Register(mux, cloud.Config{
			Store:           store,
			Logger:          logger,
			MaxPayloadBytes: envInt64("TRAEKY_MAX_PAYLOAD_BYTES", 25*1024*1024),
			CORSOrigins:     splitCSV(os.Getenv("TRAEKY_CORS_ORIGINS")),
		})
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	go func() {
		logger.Info("traeky listening", "addr", addr, "mode", mode, "data_dir", dataDir)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	logger.Info("server stopped")
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	var n int64
	_, err := fmt.Sscanf(value, "%d", &n)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if r.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}
