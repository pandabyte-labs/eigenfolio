package cloud

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

type Config struct {
	Store           Store
	Logger          *slog.Logger
	MaxPayloadBytes int64
	CORSOrigins     []string
}

type Handler struct {
	store           Store
	logger          *slog.Logger
	maxPayloadBytes int64
	corsOrigins     map[string]struct{}
}

type putRequest struct {
	Body       json.RawMessage `json:"body"`
	ClientID   string          `json:"client_id,omitempty"`
	DeviceName string          `json:"device_name,omitempty"`
}

type response struct {
	VaultID      string          `json:"vault_id"`
	Revision     int64           `json:"revision"`
	UpdatedAt    string          `json:"updated_at"`
	ClientID     string          `json:"client_id,omitempty"`
	DeviceName   string          `json:"device_name,omitempty"`
	AuthRequired bool            `json:"auth_required"`
	Body         json.RawMessage `json:"body,omitempty"`
}

func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Store == nil {
		panic("cloud.Register: Store is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	maxPayload := cfg.MaxPayloadBytes
	if maxPayload <= 0 {
		maxPayload = 25 * 1024 * 1024
	}
	h := &Handler{
		store:           cfg.Store,
		logger:          logger,
		maxPayloadBytes: maxPayload,
		corsOrigins:     map[string]struct{}{},
	}
	for _, origin := range cfg.CORSOrigins {
		h.corsOrigins[origin] = struct{}{}
	}
	mux.Handle("/api/v1/", h)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	if path == "info" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":             "traeky-cloud",
			"version":             "2",
			"e2e":                 true,
			"auth_required":       false,
			"auth_mode":           "optional_vault_secret",
			"anonymous_key_model": true,
			"max_payload_bytes":   h.maxPayloadBytes,
		})
		return
	}

	vaultID, ok := parseVaultPath(path)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "resource not found")
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.getVault(w, r, vaultID)
	case http.MethodPut:
		h.putVault(w, r, vaultID)
	case http.MethodDelete:
		h.deleteVault(w, r, vaultID)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	}
}

func parseVaultPath(path string) (string, bool) {
	const prefix = "vaults/"
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	if strings.Contains(rest, "/") || rest == "" {
		return "", false
	}
	return rest, true
}

func (h *Handler) getVault(w http.ResponseWriter, r *http.Request, vaultID string) {
	vault, err := h.store.Get(vaultID, vaultAuth(r))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", vault.Revision))
	writeJSON(w, http.StatusOK, toResponse(vault, true))
}

func (h *Handler) putVault(w http.ResponseWriter, r *http.Request, vaultID string) {
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, h.maxPayloadBytes)
	var req putRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid encrypted vault payload")
		return
	}
	if len(req.Body) == 0 || !json.Valid(req.Body) {
		writeError(w, http.StatusBadRequest, "bad_request", "body must be valid encrypted json")
		return
	}

	createOnly := strings.TrimSpace(r.Header.Get("If-None-Match")) == "*"
	var expected *int64
	if match := strings.TrimSpace(r.Header.Get("If-Match")); match != "" && match != "*" {
		match = strings.Trim(match, "\"")
		n, err := strconv.ParseInt(match, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "bad_request", "If-Match must be a numeric revision or *")
			return
		}
		expected = &n
	}

	vault, err := h.store.Put(vaultID, expected, createOnly, req.Body, req.ClientID, req.DeviceName, vaultAuth(r), nextVaultAuth(r))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", vault.Revision))
	status := http.StatusOK
	if vault.Revision == 1 {
		status = http.StatusCreated
	}
	writeJSON(w, status, toResponse(vault, true))
}

func (h *Handler) deleteVault(w http.ResponseWriter, r *http.Request, vaultID string) {
	err := h.store.Delete(vaultID, vaultAuth(r))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidID):
		writeError(w, http.StatusBadRequest, "invalid_vault_id", "invalid vault id")
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "vault not found")
	case errors.Is(err, ErrOccupied):
		writeError(w, http.StatusConflict, "vault_occupied", "vault key is already occupied")
	case errors.Is(err, ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "revision conflict")
	case errors.Is(err, ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized", "vault auth secret is missing or invalid")
	default:
		h.logger.Error("cloud error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
	}
}

func (h *Handler) applyCORS(w http.ResponseWriter, r *http.Request) {
	if len(h.corsOrigins) == 0 {
		return
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	if _, ok := h.corsOrigins[origin]; !ok {
		if _, wildcard := h.corsOrigins["*"]; !wildcard {
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-Match, If-None-Match, X-Traeky-Vault-Auth, X-Traeky-New-Vault-Auth")
	w.Header().Set("Access-Control-Expose-Headers", "ETag")
}

func toResponse(v EncryptedVault, includeBody bool) response {
	res := response{
		VaultID:      v.VaultID,
		Revision:     v.Revision,
		UpdatedAt:    v.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ClientID:     v.ClientID,
		DeviceName:   v.DeviceName,
		AuthRequired: v.AuthRequired,
	}
	if includeBody {
		res.Body = v.Body
	}
	return res
}

func vaultAuth(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Traeky-Vault-Auth"))
}

func nextVaultAuth(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Traeky-New-Vault-Auth"))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
