package cloud

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerLifecycleWithoutAPIAuth(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_1234567890abcdefghijklmnopqrstuv"
	body := `{"body":{"format":"traeky-vault","ciphertext":"opaque"},"client_id":"test"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("PUT status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("missing ETag")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "opaque") {
		t.Fatalf("GET body = %s, want encrypted payload", rec.Body.String())
	}
}

func TestHandlerReportsOccupiedVaultKey(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_occupied1234567890abcdefghijklmn"
	body := `{"body":{"ciphertext":"opaque"}}`
	for i, want := range []int{http.StatusCreated, http.StatusConflict} {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("If-None-Match", "*")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("request %d status = %d, want %d, body=%s", i+1, rec.Code, want, rec.Body.String())
		}
	}
}

func TestHandlerVaultAuthProtectsCiphertext(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_auth_handler1234567890abcdefghij"
	body := `{"body":{"format":"traeky-vault","ciphertext":"opaque"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	req.Header.Set("X-Traeky-Vault-Auth", "client-auth-proof")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("PUT status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"auth_required":true`) {
		t.Fatalf("PUT response = %s, want auth_required", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	req.Header.Set("X-Traeky-Vault-Auth", "client-auth-proof")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("authenticated GET status = %d, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerCanRotateVaultAuth(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_auth_rotate1234567890abcdefghij"
	body := `{"body":{"ciphertext":"a"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	req.Header.Set("X-Traeky-Vault-Auth", "old-proof")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(`{"body":{"ciphertext":"b"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", "1")
	req.Header.Set("X-Traeky-Vault-Auth", "old-proof")
	req.Header.Set("X-Traeky-New-Vault-Auth", "new-proof")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	req.Header.Set("X-Traeky-Vault-Auth", "old-proof")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old auth GET status = %d, want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	req.Header.Set("X-Traeky-Vault-Auth", "new-proof")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("new auth GET status = %d, body=%s", rec.Code, rec.Body.String())
	}
}
