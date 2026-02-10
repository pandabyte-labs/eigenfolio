
import type { AppConfig, Transaction } from "../domain/types";
import { DEFAULT_HOLDING_PERIOD_DAYS, DEFAULT_UPCOMING_WINDOW_DAYS } from "../domain/config";
import type { EncryptedPayload } from "../crypto/cryptoService";
import { hashPin, encryptProfilePayload, decryptProfilePayload } from "./profileSecurity";

export type ProfileId = string;

export type ProfileSummary = {
  id: ProfileId;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileOverview = {
  profiles: ProfileSummary[];
  hasLegacyData: boolean;
};

type ProfileDataPayloadVersion = 1;

type ProfileDataPayload = {
  version: ProfileDataPayloadVersion;
  transactions: Transaction[];
  nextTransactionId: number;
  config: AppConfig;
};

type ProfilesIndex = {
  currentProfileId: ProfileId | null;
  profiles: ProfileSummary[];
};

type ActiveProfileSession = {
  meta: ProfileSummary;
  pinHash: string;
  data: ProfileDataPayload;
};

const LS_PROFILES_INDEX_KEY = "traeky:profiles:index";
const PROFILE_DATA_PREFIX = "traeky:profile:";
const PROFILE_DATA_SUFFIX = ":data";

const LEGACY_TRANSACTIONS_KEY = "traeky:transactions";
const LEGACY_NEXT_ID_KEY = "traeky:next-tx-id";
const LEGACY_CONFIG_KEY = "traeky:app-config";
const PROFILE_PIN_INDEX_KEY = "traeky:profiles-pin-index";

type ProfilePinIndex = {
  [profileId: string]: string;
};

function readProfilePinIndex(): ProfilePinIndex {
  const value = readJson<ProfilePinIndex | null>(PROFILE_PIN_INDEX_KEY);
  if (!value || typeof value !== "object") {
    return {};
  }
  return value;
}

function writeProfilePinIndex(index: ProfilePinIndex): void {
  writeJson(PROFILE_PIN_INDEX_KEY, index);
}


let activeProfile: ActiveProfileSession | null = null;

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore and fall back to null.
  }
  return null;
}

function readJson<T>(key: string): T | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore persistence errors.
  }
}

function removeKey(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore persistence errors.
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateProfileId(): ProfileId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readProfilesIndex(): ProfilesIndex {
  const idx = readJson<ProfilesIndex>(LS_PROFILES_INDEX_KEY);
  if (!idx || !Array.isArray(idx.profiles)) {
    return { currentProfileId: null, profiles: [] };
  }
  return {
    currentProfileId: idx.currentProfileId ?? null,
    profiles: idx.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  };
}

function writeProfilesIndex(index: ProfilesIndex): void {
  writeJson(LS_PROFILES_INDEX_KEY, index);
}

function buildProfileDataKey(profileId: ProfileId): string {
  return `${PROFILE_DATA_PREFIX}${profileId}${PROFILE_DATA_SUFFIX}`;
}

function createDefaultConfig(): AppConfig {
  return {
    holding_period_days: DEFAULT_HOLDING_PERIOD_DAYS,
    upcoming_holding_window_days: DEFAULT_UPCOMING_WINDOW_DAYS,
    base_currency: "EUR",
    price_fetch_enabled: true,
    coingecko_api_key: null,
  };
}

function createEmptyProfileData(): ProfileDataPayload {
  return {
    version: 1,
    transactions: [],
    nextTransactionId: 1,
    config: createDefaultConfig(),
  };
}

function readLegacyTransactions(): Transaction[] {
  const items = readJson<Transaction[]>(LEGACY_TRANSACTIONS_KEY);
  if (!items || !Array.isArray(items)) return [];
  return items;
}

function readLegacyNextId(): number | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(LEGACY_NEXT_ID_KEY);
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readLegacyConfig(): AppConfig | null {
  const cfg = readJson<AppConfig>(LEGACY_CONFIG_KEY);
  if (!cfg || typeof cfg !== "object") return null;
  const baseCurrency = cfg.base_currency === "USD" ? "USD" : "EUR";
  const holding =
    typeof cfg.holding_period_days === "number" && Number.isFinite(cfg.holding_period_days)
      ? cfg.holding_period_days
      : DEFAULT_HOLDING_PERIOD_DAYS;
  const upcoming =
    typeof cfg.upcoming_holding_window_days === "number" &&
    Number.isFinite(cfg.upcoming_holding_window_days)
      ? cfg.upcoming_holding_window_days
      : DEFAULT_UPCOMING_WINDOW_DAYS;
  const priceFetchEnabled =
    typeof cfg.price_fetch_enabled === "boolean" ? cfg.price_fetch_enabled : true;
  const coingeckoApiKey =
    typeof cfg.coingecko_api_key === "string" ? cfg.coingecko_api_key : null;

  return {
    holding_period_days: holding,
    upcoming_holding_window_days: upcoming,
    base_currency: baseCurrency,
    price_fetch_enabled: priceFetchEnabled,
    coingecko_api_key: coingeckoApiKey,
  };
}

function removeLegacyStorage(): void {
  removeKey(LEGACY_TRANSACTIONS_KEY);
  removeKey(LEGACY_NEXT_ID_KEY);
  removeKey(LEGACY_CONFIG_KEY);
}

function profileHasLegacyData(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return (
      !!storage.getItem(LEGACY_TRANSACTIONS_KEY) ||
      !!storage.getItem(LEGACY_CONFIG_KEY) ||
      !!storage.getItem(LEGACY_NEXT_ID_KEY)
    );
  } catch {
    return false;
  }
}

export function getProfileOverview(): ProfileOverview {
  const index = readProfilesIndex();
  return {
    profiles: index.profiles,
    hasLegacyData: profileHasLegacyData(),
  };
}

export function getActiveProfileSummary(): ProfileSummary | null {
  if (!activeProfile) return null;
  return activeProfile.meta;
}

export function hasActiveProfileSession(): boolean {
  return !!activeProfile;
}
export function logoutActiveProfileSession(): void {
  activeProfile = null;
}



async function persistActiveProfile(): Promise<void> {
  if (!activeProfile) return;

  const payload: ProfileDataPayload = activeProfile.data;
  const encrypted: EncryptedPayload = await encryptProfilePayload(
    activeProfile.pinHash,
    payload,
  );
  const key = buildProfileDataKey(activeProfile.meta.id);
  writeJson(key, encrypted);

  const index = readProfilesIndex();
  const now = nowIso();

  // Keep in-memory meta consistent so the UI reflects changes immediately.
  activeProfile.meta = { ...activeProfile.meta, updatedAt: now };

  const updatedProfiles = index.profiles.map((p) =>
    p.id === activeProfile!.meta.id
      ? { ...p, updatedAt: now, name: activeProfile!.meta.name }
      : p,
  );

  writeProfilesIndex({
    currentProfileId: activeProfile.meta.id,
    profiles: updatedProfiles,
  });
}

export async function createInitialProfile(name: string, pin: string): Promise<ProfileSummary> {
  const trimmedName = name.trim() || "Default";
  const pinHash = await hashPin(pin);

  const index = readProfilesIndex();
  const id = generateProfileId();
  const now = nowIso();
  const meta: ProfileSummary = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  };

  let data: ProfileDataPayload;

  if (profileHasLegacyData()) {
    const transactions = readLegacyTransactions();
    const nextId =
      readLegacyNextId() ??
      (transactions.length
        ? transactions.reduce((acc, tx) => (tx.id && tx.id > acc ? tx.id : acc), 0) + 1
        : 1);
    const config = readLegacyConfig() ?? createDefaultConfig();
    data = {
      version: 1,
      transactions,
      nextTransactionId: nextId,
      config,
    };
    removeLegacyStorage();
  } else {
    data = createEmptyProfileData();
  }

  activeProfile = {
    meta,
    pinHash,
    data,
  };

  const profiles = [...index.profiles, meta];
  writeProfilesIndex({
    currentProfileId: id,
    profiles,
  });

  const pinIndex = readProfilePinIndex();
  pinIndex[id] = pinHash;
  writeProfilePinIndex(pinIndex);

  await persistActiveProfile();

  return meta;
}

export async function loginProfile(profileId: ProfileId, pin: string): Promise<ProfileSummary> {
  const index = readProfilesIndex();
  if (index.profiles.length === 0) {
    throw new Error("Profile not found");
  }

  const pinIndex = readProfilePinIndex();
  const pinHash = await hashPin(pin);

  let meta: ProfileSummary | null =
    index.profiles.find((p) => p.id === profileId && pinIndex[p.id] === pinHash) ?? null;

  if (!meta) {
    meta = index.profiles.find((p) => pinIndex[p.id] === pinHash) ?? null;
  }

  if (!meta) {
    throw new Error("Invalid PIN");
  }

  const key = buildProfileDataKey(meta.id);
  const encrypted = readJson<EncryptedPayload>(key);
  if (!encrypted) {
    throw new Error("Profile data not found");
  }

  const data = await decryptProfilePayload<ProfileDataPayload>(pinHash, encrypted);
  if (!data || data.version !== 1) {
    throw new Error("Unsupported profile data version");
  }

  activeProfile = {
    meta,
    pinHash,
    data,
  };
  // IMPORTANT: Do not mutate meta.updatedAt during login.
  // `updatedAt` is used as "data last changed" (e.g. export freshness).
  // A login itself must not mark the profile as "changed".
  writeProfilesIndex({
    currentProfileId: meta.id,
    profiles: index.profiles,
  });

  return meta;
}


export function getActiveProfileConfig(): AppConfig {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  return activeProfile.data.config;
}

export function setActiveProfileConfig(config: AppConfig): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data.config = config;
  void persistActiveProfile();
}

export function getActiveProfileTransactions(): Transaction[] {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  return activeProfile.data.transactions;
}

export function setActiveProfileTransactions(items: Transaction[]): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data.transactions = items;
  void persistActiveProfile();
}

export function getNextActiveProfileTxId(): number {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const id = activeProfile.data.nextTransactionId;
  activeProfile.data.nextTransactionId = id + 1;
  void persistActiveProfile();
  return id;
}


export async function createAdditionalProfile(
  name: string,
  pin: string,
): Promise<ProfileSummary> {
  const trimmedName = name.trim() || "Profile";
  const pinHash = await hashPin(pin);

  const index = readProfilesIndex();
  const id = generateProfileId();
  const now = nowIso();

  const meta: ProfileSummary = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  };

  const data = createEmptyProfileData();
  const payload: ProfileDataPayload = data;
  const encrypted: EncryptedPayload = await encryptProfilePayload(pinHash, payload);
  const key = buildProfileDataKey(id);
  writeJson(key, encrypted);

  const profiles = [...index.profiles, meta];

  writeProfilesIndex({
    currentProfileId: id,
    profiles,
  });

  const pinIndex = readProfilePinIndex();
  pinIndex[id] = pinHash;
  writeProfilePinIndex(pinIndex);

  activeProfile = {
    meta,
    pinHash,
    data,
  };

  return meta;
}

export async function resetActiveProfileData(): Promise<void> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data = createEmptyProfileData();
  await persistActiveProfile();
}

export async function verifyActiveProfilePin(pin: string): Promise<boolean> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const candidateHash = await hashPin(pin);
  return candidateHash === activeProfile.pinHash;
}

export function renameActiveProfile(name: string): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  activeProfile.meta = {
    ...activeProfile.meta,
    name: trimmed,
  };
  void persistActiveProfile();
}

export async function changeActiveProfilePin(
  currentPin: string,
  newPin: string,
): Promise<void> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const currentHash = await hashPin(currentPin);
  if (currentHash !== activeProfile.pinHash) {
    throw new Error("Invalid current PIN");
  }
  const newHash = await hashPin(newPin);
  activeProfile.pinHash = newHash;

  const pinIndex = readProfilePinIndex();
  pinIndex[activeProfile.meta.id] = newHash;
  writeProfilePinIndex(pinIndex);

  void persistActiveProfile();
}

export function deleteActiveProfile(): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const index = readProfilesIndex();
  const idToDelete = activeProfile.meta.id;

  const key = buildProfileDataKey(idToDelete);
  removeKey(key);

  const remainingProfiles = index.profiles.filter((p) => p.id !== idToDelete);
  const nextCurrentId = remainingProfiles.length > 0 ? remainingProfiles[0].id : null;

  writeProfilesIndex({
    currentProfileId: nextCurrentId,
    profiles: remainingProfiles,
  });

  activeProfile = null;
}