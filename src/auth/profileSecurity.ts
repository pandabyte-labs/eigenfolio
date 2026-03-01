import {
  encryptJsonWithPassphrase,
  decryptJsonWithPassphrase,
  type EncryptedPayload,
} from "../crypto/cryptoService";

const rawProfilePinSalt =
  (import.meta.env.VITE_PROFILE_PIN_SALT as string | undefined) ??
  (import.meta.env.TRAEKY_PROFILE_PIN_SALT as string | undefined);

const LEGACY_PROFILE_PIN_SALT = rawProfilePinSalt ?? "";

const rawProfileEncryptionKey =
  (import.meta.env.VITE_PROFILE_ENCRYPTION_KEY as string | undefined) ??
  (import.meta.env.TRAEKY_PROFILE_ENCRYPTION_KEY as string | undefined);

const LEGACY_PROFILE_ENCRYPTION_KEY = rawProfileEncryptionKey ?? null;

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto && "subtle" in globalThis.crypto) {
    return globalThis.crypto as Crypto;
  }
  throw new Error("Web Crypto API is not available in this environment");
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export type PassphraseValidationError = "too_short" | "too_weak";

export function validateProfilePassphrase(passphrase: string): PassphraseValidationError | null {
  const p = passphrase;
  if (p.length < 12) return "too_short";

  const normalized = p.trim().toLowerCase();
  if (!normalized) return "too_weak";

  if (/^\d+$/.test(normalized)) return "too_weak";
  if (/^(.)\1+$/.test(normalized)) return "too_weak";
  if (/^(0123456789|1234567890)$/.test(normalized)) return "too_weak";

  const common = [
    "password",
    "passwort",
    "qwertyuiop",
    "qwertzuiop",
    "asdfghjkl",
    "letmein",
    "iloveyou",
  ];
  if (common.includes(normalized)) return "too_weak";

  for (let i = 0; i <= normalized.length - 6; i += 1) {
    const chunk = normalized.slice(i, i + 6);
    if (/^\d{6}$/.test(chunk)) {
      let asc = true;
      let desc = true;
      for (let j = 1; j < chunk.length; j += 1) {
        const prev = chunk.charCodeAt(j - 1);
        const cur = chunk.charCodeAt(j);
        if (cur !== prev + 1) asc = false;
        if (cur !== prev - 1) desc = false;
      }
      if (asc || desc) return "too_weak";
    }
  }

  return null;
}

export function passphraseNeedsUpgrade(passphrase: string): boolean {
  return validateProfilePassphrase(passphrase) !== null;
}

export async function hashLegacyPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${LEGACY_PROFILE_PIN_SALT}:${pin}`);
  const digest = await getWebCrypto().subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function encryptProfilePayload<T>(passphrase: string, payload: T): Promise<EncryptedPayload> {
  return encryptJsonWithPassphrase(payload, passphrase);
}

export async function decryptProfilePayload<T>(passphrase: string, encrypted: EncryptedPayload): Promise<T> {
  return decryptJsonWithPassphrase<T>(encrypted, passphrase);
}

export function hasLegacyCryptoConfig(): boolean {
  return !!LEGACY_PROFILE_ENCRYPTION_KEY;
}

export async function decryptLegacyProfilePayload<T>(encrypted: EncryptedPayload): Promise<T> {
  if (!LEGACY_PROFILE_ENCRYPTION_KEY) {
    throw new Error("Legacy profile encryption key is not configured");
  }
  return decryptJsonWithPassphrase<T>(encrypted, LEGACY_PROFILE_ENCRYPTION_KEY);
}
