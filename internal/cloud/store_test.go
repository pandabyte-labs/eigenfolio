package cloud

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestFileStorePutGetWithAnonymousVaultKey(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_1234567890abcdefghijklmnopqrstuv"
	body := json.RawMessage(`{"format":"traeky-vault","ciphertext":"opaque"}`)
	created, err := store.Put(vaultKey, nil, true, body, "client", "device", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 {
		t.Fatalf("revision = %d, want 1", created.Revision)
	}

	got, err := store.Get(vaultKey, "")
	if err != nil {
		t.Fatal(err)
	}
	var gotMap map[string]string
	if err := json.Unmarshal(got.Body, &gotMap); err != nil {
		t.Fatal(err)
	}
	if gotMap["ciphertext"] != "opaque" {
		t.Fatalf("ciphertext = %q, want opaque", gotMap["ciphertext"])
	}

	if _, err := store.Put(vaultKey, nil, true, body, "", "", "", ""); !errors.Is(err, ErrOccupied) {
		t.Fatalf("collision err = %v, want ErrOccupied", err)
	}
}

func TestFileStoreRevisionConflict(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_abcdef1234567890abcdefghijklmnop"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	expected := int64(99)
	if _, err := store.Put(vaultKey, &expected, false, body, "", "", "", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	expected = 1
	updated, err := store.Put(vaultKey, &expected, false, json.RawMessage(`{"ciphertext":"b"}`), "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 {
		t.Fatalf("revision = %d, want 2", updated.Revision)
	}
}

func TestFileStoreRejectsInvalidVaultID(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put("../bad", nil, true, json.RawMessage(`{"x":1}`), "", "", "", ""); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("err = %v, want ErrInvalidID", err)
	}
}

func TestFileStoreVaultAuthProtectsReadAndWrite(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_auth1234567890abcdefghijklmnop"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	created, err := store.Put(vaultKey, nil, true, body, "", "", "auth-proof", "")
	if err != nil {
		t.Fatal(err)
	}
	if !created.AuthRequired {
		t.Fatal("created vault should require auth")
	}
	if _, err := store.Get(vaultKey, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthenticated get err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, "wrong"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong auth get err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, "auth-proof"); err != nil {
		t.Fatalf("authenticated get err = %v", err)
	}
	expected := int64(1)
	if _, err := store.Put(vaultKey, &expected, false, body, "", "", "wrong", ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong auth update err = %v, want ErrUnauthorized", err)
	}
}

func TestFileStoreCanRotateVaultAuth(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_rotate1234567890abcdefghijklmn"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", "old-proof", ""); err != nil {
		t.Fatal(err)
	}
	expected := int64(1)
	if _, err := store.Put(vaultKey, &expected, false, json.RawMessage(`{"ciphertext":"b"}`), "", "", "old-proof", "new-proof"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(vaultKey, "old-proof"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("old auth err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, "new-proof"); err != nil {
		t.Fatalf("new auth err = %v", err)
	}
}
