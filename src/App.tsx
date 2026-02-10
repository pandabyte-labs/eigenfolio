import React, { useEffect, useRef, useState } from "react";
import { createPortfolioDataSource, type PortfolioDataSource, computeLocalHoldings, computeLocalExpiring, loadLocalTransactions, saveLocalAppConfig } from "./data/dataSource";
import { useAuth } from "./auth/AuthContext";
import {
  getProfileOverview,
  type ProfileOverview,
  type ProfileSummary,
  createInitialProfile,
  createAdditionalProfile,
  loginProfile,
  resetActiveProfileData,
  verifyActiveProfilePin,
  renameActiveProfile,
  changeActiveProfilePin,
  deleteActiveProfile,
  getActiveProfileSummary,
  logoutActiveProfileSession,
} from "./auth/profileStore";
import { t, Language, getDefaultLanguage } from "./i18n";
import { CURRENT_CSV_SCHEMA_VERSION, CSV_SCHEMA_VERSION_COLUMN } from "./data/csvSchema";
import { Transaction, HoldingsItem, HoldingsResponse, CsvImportResult, AppConfig, ExpiringHolding } from "./domain/types";
import { DEFAULT_HOLDING_PERIOD_DAYS, DEFAULT_UPCOMING_WINDOW_DAYS } from "./domain/config";
import { getAssetMetadata, getTxExplorerUrl } from "./domain/assets";
import { applyPricesToHoldings, setCoingeckoApiKey, fetchHistoricalPriceForSymbol, getPriceApiStatus } from "./data/priceService";
import packageJson from "../package.json";

const RESET_CONFIRMATION_WORD = "RESET";

const APP_VERSION = packageJson.version;
const LOCAL_STORAGE_LANG_KEY = "traeky_lang";

const LS_PROFILE_EXPORT_TS_SUFFIX = ":last-exported-at";
const SYNC_DANGER_MS = 1000 * 60 * 60 * 24 * 3;

function readProfileLastExportAt(profileId: string): string | null {
  try {
    const key = `traeky:profile:${profileId}${LS_PROFILE_EXPORT_TS_SUFFIX}`;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeProfileLastExportAt(profileId: string, value: string): void {
  try {
    const key = `traeky:profile:${profileId}${LS_PROFILE_EXPORT_TS_SUFFIX}`;
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}



function formatTxTypeLabel(txType: string | null | undefined): string {
  const code = (txType || "").toUpperCase();
  switch (code) {
    case "STAKING_REWARD":
      return "STAKING REWARD";
    case "TRANSFER_IN":
      return "TRANSFER (IN)";
    case "TRANSFER_OUT":
      return "TRANSFER (OUT)";
    case "TRANSFER_INTERNAL":
      return "TRANSFER (INTERNAL)";
    default:
      return code || "";
  }
}

// Convert a UTC timestamp string to a Date restricted to the local timezone.
function toLocalInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function timestampToLocalInputValue(timestamp: string): string {
  try {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)) {
      return timestamp.slice(0, 16);
    }
    const d = new Date(timestamp);
    if (!isNaN(d.getTime())) {
      return toLocalInputValue(d);
    }
  } catch {
    // ignore
  }
  return "";
}

const FIAT_ASSET_SYMBOLS = new Set(["EUR", "USD", "CHF", "GBP"]);

function isFiatAssetSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return FIAT_ASSET_SYMBOLS.has(symbol.toUpperCase());
}


function isTaxRelevant(tx: Transaction): boolean {
  const t = (tx.tx_type || "").trim().toUpperCase();
  const asset = (tx.asset_symbol || "").trim().toUpperCase();

  // Treat obvious fiat currencies as non-taxable holdings
  if (asset === "EUR" || asset === "USD") {
    return false;
  }

  return t === "BUY" || t === "AIRDROP" || t === "STAKING_REWARD";
}

function isHoldingPeriodReached(tx: Transaction, holdingDays: number): boolean {
  if (!isTaxRelevant(tx)) return false;
  const buyTime = new Date(tx.timestamp).getTime();
  if (Number.isNaN(buyTime)) return false;

  const now = Date.now();
  const diffDays = (now - buyTime) / (1000 * 60 * 60 * 24);
  return diffDays >= holdingDays;
}

function holdingPeriodEndDate(tx: Transaction, holdingDays: number): Date | null {
  if (!isTaxRelevant(tx)) return null;
  const buyTime = new Date(tx.timestamp).getTime();
  if (Number.isNaN(buyTime)) return null;
  const endTime = buyTime + holdingDays * 24 * 60 * 60 * 1000;
  return new Date(endTime);
}
function buildLinkedTransactionChain(transactions: Transaction[], rootId: number): Set<number> {
  const idToTx = new Map<number, Transaction>();
  for (const tx of transactions) {
    if (typeof tx.id === "number") {
      idToTx.set(tx.id, tx);
    }
  }
  if (!idToTx.has(rootId)) {
    return new Set<number>();
  }
  const adjacency = new Map<number, Set<number>>();
  const addEdge = (a: number | null | undefined, b: number | null | undefined) => {
    if (typeof a !== "number" || typeof b !== "number") {
      return;
    }
    if (!adjacency.has(a)) {
      adjacency.set(a, new Set<number>());
    }
    if (!adjacency.has(b)) {
      adjacency.set(b, new Set<number>());
    }
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  for (const tx of transactions) {
    if (typeof tx.id !== "number") {
      continue;
    }
    addEdge(tx.id, tx.linked_tx_prev_id);
    addEdge(tx.id, tx.linked_tx_next_id);
  }
  const visited = new Set<number>();
  const queue: number[] = [];
  queue.push(rootId);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const neighbors = adjacency.get(current);
    if (!neighbors) {
      continue;
    }
    neighbors.forEach((n) => {
      if (!visited.has(n)) {
        queue.push(n);
      }
    });
  }
  return visited;
}


const App: React.FC = () => {
  const { auth, logout, isAuthModalOpen, closeAuthModal } = useAuth();
  const dataSource: PortfolioDataSource = React.useMemo(
    () => createPortfolioDataSource(auth.mode),
    [auth.mode]
  );

  const [activeProfile, setActiveProfile] = useState<ProfileSummary | null>(null);
  const [profileOverview, setProfileOverview] = useState<ProfileOverview | null>(null);
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);

  const [profileNameInput, setProfileNameInput] = useState("");
  const [profilePinInput, setProfilePinInput] = useState("");
  const [profilePinConfirmInput, setProfilePinConfirmInput] = useState("");
  const [profileSetupError, setProfileSetupError] = useState<string | null>(null);

  const [loginProfileId, setLoginProfileId] = useState<string | null>(null);
  const [loginPinInput, setLoginPinInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isProfileLoginOverlayOpen, setIsProfileLoginOverlayOpen] = useState(false);

  const [isCreateProfileOverlayOpen, setIsCreateProfileOverlayOpen] = useState(false);
  const [createProfileNameInput, setCreateProfileNameInput] = useState("");
  const [createProfilePinInput, setCreateProfilePinInput] = useState("");
  const [createProfilePinConfirmInput, setCreateProfilePinConfirmInput] = useState("");
  const [createProfileError, setCreateProfileError] = useState<string | null>(null);

  const [isRenameProfileOverlayOpen, setIsRenameProfileOverlayOpen] = useState(false);
  const [renameProfileNameInput, setRenameProfileNameInput] = useState("");
  const [renameProfileError, setRenameProfileError] = useState<string | null>(null);

  const [isPinChangeOverlayOpen, setIsPinChangeOverlayOpen] = useState(false);
  const [pinChangeCurrentPinInput, setPinChangeCurrentPinInput] = useState("");
  const [pinChangeNewPinInput, setPinChangeNewPinInput] = useState("");
  const [pinChangeNewPinConfirmInput, setPinChangeNewPinConfirmInput] = useState("");
  const [pinChangeError, setPinChangeError] = useState<string | null>(null);

  const profileDropdownRef = useRef<HTMLDivElement | null>(null);
  const [isProfileMenuOverlayOpen, setIsProfileMenuOverlayOpen] = useState(false);

  const [showProfileDeleteConfirmation, setShowProfileDeleteConfirmation] = useState(false);
  const [profileDeleteConfirmInput, setProfileDeleteConfirmInput] = useState("");
  const [profileDeletePinInput, setProfileDeletePinInput] = useState("");
  const [profileDeleteError, setProfileDeleteError] = useState<string | null>(null);
  const [lang, setLang] = useState<Language>(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = window.localStorage.getItem(LOCAL_STORAGE_LANG_KEY);
        if (stored === "de" || stored === "en") {
          return stored as Language;
        }
      } catch {
        // ignore
      }
    }
    return getDefaultLanguage();
  });
  const [holdings, setHoldings] = useState<HoldingsItem[]>([]);
  const [holdingsPortfolioEur, setHoldingsPortfolioEur] = useState<number | null>(
    null
  );
  const [holdingsPortfolioUsd, setHoldingsPortfolioUsd] = useState<number | null>(
    null
  );
  const [fxRateEurUsd, setFxRateEurUsd] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const displayHoldings = holdings.filter((h) => !isFiatAssetSymbol(h.asset_symbol));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [txFilterYear, setTxFilterYear] = useState<string>("");
  const [txFilterAsset, setTxFilterAsset] = useState<string>("");
  const [txFilterType, setTxFilterType] = useState<string>("");
  const [txSearch, setTxSearch] = useState<string>("");
  const [txChainFilterRootId, setTxChainFilterRootId] = useState<number | null>(null);
  const [txPage, setTxPage] = useState(1);
  const [txPageSize, setTxPageSize] = useState(25);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsDirty, setIsSettingsDirty] = useState(false);
  const filteredTransactions = React.useMemo(
    () => {
      const filtered = transactions.filter((tx) => {
        if (txFilterYear) {
          const year = tx.timestamp ? tx.timestamp.slice(0, 4) : "";
          if (year !== txFilterYear) {
            return false;
          }
        }
        if (txFilterAsset) {
          const needle = txFilterAsset.trim().toUpperCase();
          if (needle && !tx.asset_symbol.toUpperCase().includes(needle)) {
            return false;
          }
        }
        if (txFilterType) {
          if ((tx.tx_type || "").toUpperCase() !== txFilterType.toUpperCase()) {
            return false;
          }
        }
        if (txSearch) {
          const needle = txSearch.trim().toLowerCase();
          if (needle) {
            const haystack = [
              tx.asset_symbol,
              tx.tx_type,
              tx.source || "",
              tx.note || "",
              tx.tx_id || "",
            ]
              .join(" ")
              .toLowerCase();
            if (!haystack.includes(needle)) {
              return false;
            }
          }
        }

        return true;
      });

      let result = filtered.slice();
      if (txChainFilterRootId != null) {
        const chainIds = buildLinkedTransactionChain(transactions, txChainFilterRootId);
        if (chainIds.size > 0) {
          result = result.filter((tx) => typeof tx.id === "number" && chainIds.has(tx.id));
        } else {
          result = [];
        }
      }

      return result.sort((a, b) => {
        const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        const safeATime = Number.isFinite(aTime) ? aTime : 0;
        const safeBTime = Number.isFinite(bTime) ? bTime : 0;
        return safeBTime - safeATime;
      });
    },
    [transactions, txFilterYear, txFilterAsset, txFilterType, txSearch, txChainFilterRootId],
  );

  const totalTransactions = filteredTransactions.length;
  const totalPages = totalTransactions > 0 ? Math.ceil(totalTransactions / txPageSize) : 1;
  const currentPage = Math.min(txPage, totalPages);

  const paginatedTransactions = React.useMemo(
    () => {
      const startIndex = (currentPage - 1) * txPageSize;
      return filteredTransactions.slice(startIndex, startIndex + txPageSize);
    },
    [filteredTransactions, currentPage, txPageSize],
  );

  const [csvImporting, setCsvImporting] = useState(false);
  const [externalImportSource, setExternalImportSource] = useState<string>("binance_trade_xlsx");
  const [externalImporting, setExternalImporting] = useState(false);
  const [externalImportResult, setExternalImportResult] = useState<CsvImportResult | null>(null);
  const [externalFileName, setExternalFileName] = useState<string | null>(null);
  const [showExternalImport, setShowExternalImport] = useState(false);
  const [showTransactionForm, setShowTransactionForm] = useState(false);

  
  useEffect(() => {
    const overview = getProfileOverview();
    setProfileOverview(overview);
    if (overview.profiles.length > 0 && !loginProfileId) {
      setLoginProfileId(overview.profiles[0].id);
    }
    // We intentionally run this only once during initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_STORAGE_LANG_KEY, lang);
      }
    } catch {
      // ignore
    }
  }, [lang]);


  useEffect(() => {
    function handleGlobalPointerDown(event: MouseEvent | TouchEvent) {
      if (!profileDropdownRef.current) return;
      const target = event.target as Node | null;
      if (target && profileDropdownRef.current.contains(target)) {
        return;
      }
      setIsProfileMenuOverlayOpen(false);
    }

    if (isProfileMenuOverlayOpen) {
      document.addEventListener("mousedown", handleGlobalPointerDown);
      document.addEventListener("touchstart", handleGlobalPointerDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleGlobalPointerDown);
      document.removeEventListener("touchstart", handleGlobalPointerDown);
    };
  }, [isProfileMenuOverlayOpen]);
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const [resetConfirmationInput, setResetConfirmationInput] = useState("");
  const [pricesRefreshing, setPricesRefreshing] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [expiring, setExpiring] = useState<ExpiringHolding[]>([]);
  const [holdingPeriodInput, setHoldingPeriodInput] = useState<string>("");
  const [priceFetchEnabledInput, setPriceFetchEnabledInput] = useState<boolean>(true);
  const [coingeckoApiKeyInput, setCoingeckoApiKeyInput] = useState<string>("");

  const [form, setForm] = useState({
    asset_symbol: "IOTA",
    tx_type: "BUY",
    amount: "",
    price_fiat: "",
    fiat_currency: "EUR",
    timestamp: toLocalInputValue(new Date()),
    source: "",
    note: "",
    tx_id: "",
    linked_tx_prev_id: "",
    linked_tx_next_id: "",
  });

  const currentLocale = t(lang, "locale_code");

  useEffect(() => {
    if (config) {
      setHoldingPeriodInput(String(config.holding_period_days));
      setPriceFetchEnabledInput(config.price_fetch_enabled !== false);
      setCoingeckoApiKeyInput(config.coingecko_api_key ?? "");
    }
  }, [config]);

  useEffect(() => {
    if (!config) {
      setIsSettingsDirty(false);
      return;
    }

    const baseHolding = String(config.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS);
    const baseApiKey = config.coingecko_api_key ?? "";

    const holdingDirty =
      holdingPeriodInput.length > 0 && holdingPeriodInput !== baseHolding;
    const apiKeyDirty = coingeckoApiKeyInput !== baseApiKey;

    setIsSettingsDirty(holdingDirty || apiKeyDirty);
  }, [config, holdingPeriodInput, coingeckoApiKeyInput]);


  const dateTimeFormatter = React.useMemo(
    () =>
      new Intl.DateTimeFormat(currentLocale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [currentLocale]
  );

  const dateFormatter = React.useMemo(
    () =>
      new Intl.DateTimeFormat(currentLocale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    [currentLocale]
  );

  const fetchData = async () => {
  try {
    setLoading(true);

    const { config: configJson, holdings: holdingsJson, transactions: txJson, expiring: expiringJson } =
      await dataSource.loadInitialData();

    setConfig(configJson);
    setHoldings(holdingsJson.items ?? []);
    setHoldingsPortfolioEur(holdingsJson.portfolio_value_eur ?? null);
    setHoldingsPortfolioUsd(holdingsJson.portfolio_value_usd ?? null);
    setFxRateEurUsd(holdingsJson.fx_rate_eur_usd ?? null);
    setTransactions(txJson);
    setExpiring(expiringJson);
    setError(null);
  } catch (err) {
    console.error(err);
    setError(t(lang, "header_error"));
  } finally {
    setLoading(false);
  }
};

  const handleInitialProfileSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileSetupError(null);

    if (!profilePinInput || !profilePinConfirmInput) {
      setProfileSetupError(t(lang, "pin_error_required"));
      return;
    }
    if (profilePinInput !== profilePinConfirmInput) {
      setProfileSetupError(t(lang, "pin_error_mismatch"));
      return;
    }

    try {
      const name = profileNameInput.trim() || (t(lang, "profile_default_name"));
      const summary = await createInitialProfile(name, profilePinInput);
      setActiveProfile(summary);
      const overview = getProfileOverview();
      setProfileOverview(overview);
      setProfileNameInput("");
      setProfilePinInput("");
      setProfilePinConfirmInput("");
      setProfileSetupError(null);
    } catch (err) {
      console.error("Failed to create initial profile", err);
      setProfileSetupError(
        t(lang, "profile_error_create_failed"),
      );
    }
  };

  const handleProfileLoginSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError(null);

    if (!loginProfileId) {
      setLoginError(t(lang, "profile_login_error_select_profile"));
      return;
    }
    if (!loginPinInput) {
      setLoginError(t(lang, "pin_error_required"));
      return;
    }

    try {
      const summary = await loginProfile(loginProfileId, loginPinInput);
      setActiveProfile(summary);
      const overview = getProfileOverview();
      setProfileOverview(overview);
      setLoginPinInput("");
      setLoginError(null);
      setIsProfileLoginOverlayOpen(false);
    } catch (err) {
      console.error("Failed to log into profile", err);
      setLoginError(t(lang, "pin_error_invalid"));
    }
  };

  const handleCreateProfileSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreateProfileError(null);

    if (!createProfilePinInput || !createProfilePinConfirmInput) {
      setCreateProfileError(t(lang, "pin_error_required"));
      return;
    }
    if (createProfilePinInput !== createProfilePinConfirmInput) {
      setCreateProfileError(
        t(lang, "pin_error_mismatch"),
      );
      return;
    }

    try {
      const name = createProfileNameInput.trim() || (t(lang, "profile_section_title"));
      const summary = await createAdditionalProfile(name, createProfilePinInput);
      setActiveProfile(summary);
      const overview = getProfileOverview();
      setProfileOverview(overview);
      setCreateProfileNameInput("");
      setCreateProfilePinInput("");
      setCreateProfilePinConfirmInput("");
      setIsCreateProfileOverlayOpen(false);
      setCreateProfileError(null);
    } catch (err) {
      console.error("Failed to create additional profile", err);
      setCreateProfileError(
        t(lang, "profile_error_create_failed"),
      );
    }
  };

  const handleRenameProfileSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setRenameProfileError(null);

    if (!activeProfile) {
      return;
    }

    const name = renameProfileNameInput.trim();
    if (!name) {
      setRenameProfileError(
        t(lang, "profile_name_error_required"),
      );
      return;
    }

    try {
      renameActiveProfile(name);
      const updated = getActiveProfileSummary();
      if (updated) {
        setActiveProfile(updated);
      }
      const overview = getProfileOverview();
      setProfileOverview(overview);
      setIsRenameProfileOverlayOpen(false);
    } catch (err) {
      console.error("Failed to rename profile", err);
      setRenameProfileError(
        t(lang, "profile_error_rename_failed"),
      );
    }
  };

  const handlePinChangeSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPinChangeError(null);

    if (!pinChangeCurrentPinInput) {
      setPinChangeError(
        t(lang, "pin_change_error_current_required"),
      );
      return;
    }

    if (!pinChangeNewPinInput || !pinChangeNewPinConfirmInput) {
      setPinChangeError(
        t(lang, "pin_change_error_new_required"),
      );
      return;
    }

    if (pinChangeNewPinInput !== pinChangeNewPinConfirmInput) {
      setPinChangeError(
        t(lang, "pin_error_mismatch"),
      );
      return;
    }

    try {
      await changeActiveProfilePin(pinChangeCurrentPinInput, pinChangeNewPinInput);
      setPinChangeCurrentPinInput("");
      setPinChangeNewPinInput("");
      setPinChangeNewPinConfirmInput("");
      setIsPinChangeOverlayOpen(false);
    } catch (err) {
      console.error("Failed to change profile PIN", err);
      setPinChangeError(
        t(lang, "pin_change_error_current_invalid"),
      );
    }
  };

  const handleResetProfileData = async () => {
    if (!activeProfile) {
      return;
    }
    try {
      await resetActiveProfileData();
    } catch (err) {
      console.error("Failed to reset profile data", err);
    }
    window.location.reload();
  };

  const handleDeleteProfile = async () => {
    if (!activeProfile) {
      return;
    }
    setProfileDeleteError(null);

    if (profileDeleteConfirmInput !== "DELETE") {
      return;
    }

    if (!profileDeletePinInput) {
      setProfileDeleteError(t(lang, "pin_error_required_own"));
      return;
    }

    try {
      const valid = await verifyActiveProfilePin(profileDeletePinInput);
      if (!valid) {
        setProfileDeleteError(t(lang, "pin_error_invalid"));
        return;
      }

      deleteActiveProfile();
      setProfileDeleteConfirmInput("");
      setProfileDeletePinInput("");
      setShowProfileDeleteConfirmation(false);

      const overview = getProfileOverview();
      setProfileOverview(overview);
      setActiveProfile(null);

      if (overview.profiles.length > 0) {
        setLoginProfileId(overview.profiles[0].id);
      } else {
        setLoginProfileId(null);
      }
    } catch (err) {
      console.error("Failed to delete profile", err);
      setProfileDeleteError(
        t(lang, "profile_error_delete_failed"),
      );
    }

  };
  useEffect(() => {
    // Optimistically load local transactions and holdings from storage
    // so that something is visible immediately while price/fiat enrichment
    // is still running in the background.
    if (auth.mode !== "local-only" || !activeProfile) {
      return;
    }
    try {
      const rawTxs = loadLocalTransactions();
      setTransactions(rawTxs);
      const holdingsResp = computeLocalHoldings(rawTxs);
      setHoldings(holdingsResp.items ?? []);
    } catch (err) {
      console.error("Failed to optimistically load local data", err);
    }
    // We intentionally do not depend on functions here to avoid re-running
    // this effect unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.mode, activeProfile?.id]);

  useEffect(() => {
    if (!activeProfile) {
      return;
    }
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.mode, activeProfile?.id]);

  useEffect(() => {
    const profileId = activeProfile?.id;
    if (!profileId) {
      setLastExportAt(null);
      return;
    }
    setLastExportAt(readProfileLastExportAt(profileId));
  }, [activeProfile?.id]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const resetForm = () => {
    setForm({
      asset_symbol: "IOTA",
      tx_type: "BUY",
      amount: "",
      price_fiat: "",
      fiat_currency: "EUR",
      timestamp: toLocalInputValue(new Date()),
      source: "",
      note: "",
      tx_id: "",
      linked_tx_prev_id: "",
      linked_tx_next_id: "",
    });
    setEditingId(null);
  };


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);

      const rawAmount = (form.amount ?? "").toString().trim();
      if (!rawAmount) {
        setError(t(lang, "tx_error_amount_required"));
        return;
      }

      const parsedAmount = parseFloat(rawAmount.replace(",", "."));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        setError(t(lang, "tx_error_amount_positive"));
        return;
      }

      const rawAsset = (form.asset_symbol ?? "").toString().trim();
      if (!rawAsset) {
        setError(t(lang, "tx_error_asset_required"));
        return;
      }

      const meta = getAssetMetadata(rawAsset);
      if (!meta) {
        setError(t(lang, "tx_error_asset_unknown"));
        return;
      }

      const upperSymbol = meta.symbol;
      const amount = parsedAmount;

      let priceFiat: number | null = null;
      if (form.price_fiat) {
        priceFiat = parseFloat(form.price_fiat);
      } else {
        try {
          const fiatForHistory = form.fiat_currency === "USD" ? "USD" : "EUR";
          const hist = await fetchHistoricalPriceForSymbol(
            upperSymbol,
            fiatForHistory,
            form.timestamp,
          );
          if (hist) {
            if (form.fiat_currency === "USD" && hist.usd != null) {
              priceFiat = hist.usd;
            } else if (hist.eur != null) {
              priceFiat = hist.eur;
            }
          }
        } catch (err) {
          console.warn("Failed to fetch historical price for transaction", err);
        }
      }

      let linkedPrevId: number | null = null;
      let linkedNextId: number | null = null;

      const rawPrev = (form.linked_tx_prev_id ?? "").toString().trim();
      if (rawPrev) {
        const parsedPrev = parseInt(rawPrev, 10);
        if (!Number.isFinite(parsedPrev) || parsedPrev <= 0) {
          setError(t(lang, "tx_error_link_invalid"));
          return;
        }
        if (editingId != null && parsedPrev === editingId) {
          setError(t(lang, "tx_error_link_self"));
          return;
        }
        const prevExists = transactions.some((tx) => tx.id === parsedPrev);
        if (!prevExists) {
          setError(t(lang, "tx_error_link_not_found"));
          return;
        }
        linkedPrevId = parsedPrev;
      }

      const rawNext = (form.linked_tx_next_id ?? "").toString().trim();
      if (rawNext) {
        const parsedNext = parseInt(rawNext, 10);
        if (!Number.isFinite(parsedNext) || parsedNext <= 0) {
          setError(t(lang, "tx_error_link_invalid"));
          return;
        }
        if (editingId != null && parsedNext === editingId) {
          setError(t(lang, "tx_error_link_self"));
          return;
        }
        const nextExists = transactions.some((tx) => tx.id === parsedNext);
        if (!nextExists) {
          setError(t(lang, "tx_error_link_not_found"));
          return;
        }
        linkedNextId = parsedNext;
      }

      const payload = {
        id: editingId,
        asset_symbol: upperSymbol,
        tx_type: form.tx_type,
        amount,
        price_fiat: priceFiat,
        fiat_currency: form.fiat_currency,
        timestamp: form.timestamp,
        source: form.source || null,
        note: form.note || null,
        tx_id: form.tx_id || null,
        linked_tx_prev_id: linkedPrevId,
        linked_tx_next_id: linkedNextId,
      };

      await dataSource.saveTransaction(payload);

      resetForm();
      await fetchData();
      setShowTransactionForm(false);
    } catch (err) {
      console.error(err);
      setError(t(lang, "error_save_tx"));
    }
  };

  const handleDelete = async (txId: number) => {
  if (!window.confirm(t(lang, "tx_delete_confirm"))) {
    return;
  }
  try {
    setError(null);
    await dataSource.deleteTransaction(txId);
    await fetchData();
  } catch (err) {
    console.error(err);
    setError(t(lang, "error_delete_tx"));
  }
};

  const handleCsvChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  setCsvFileName(file.name);
  setCsvResult(null);
  setError(null);
  setCsvImporting(true);

  try {
    const json = await dataSource.importCsv(lang, file);
    setCsvResult(json);
    await fetchData();
  } catch (err) {
    console.error(err);
    setError(t(lang, "error_csv_import"));
  } finally {
    setCsvImporting(false);
    e.target.value = "";
  }
};

  const handleExternalFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setExternalFileName(file.name);
    setExternalImportResult(null);
    setError(null);
    setExternalImporting(true);

    try {
      if (externalImportSource === "binance_trade_xlsx") {
        const importer = dataSource.importBinanceSpotXlsx?.bind(dataSource);
        if (!importer) {
          setExternalImportResult({
            imported: 0,
            errors: [t(lang, "external_import_not_supported")],
          });
        } else {
          const json = await importer(lang, file);
          setExternalImportResult(json);
          await fetchData();
        }
      } else if (externalImportSource === "bitpanda_csv") {
        const importer = dataSource.importBitpandaCsv?.bind(dataSource);
        if (!importer) {
          setExternalImportResult({
            imported: 0,
            errors: [t(lang, "external_import_not_supported")],
          });
        } else {
          const json = await importer(lang, file);
          setExternalImportResult(json);
          await fetchData();
        }
      } else {
        setExternalImportResult({
          imported: 0,
          errors: [t(lang, "external_import_not_supported")],
        });
      }
    } catch (err) {
      console.error(err);
      setError(t(lang, "error_external_import"));
    } finally {
      setExternalImporting(false);
      e.target.value = "";
    }
  };
  const buildExportFileName = (ext: "pdf" | "csv") => {
    const profileNameRaw = (activeProfile?.name ?? "profile").trim();
    const profilePart =
      profileNameRaw.replace(/[^a-z0-9_-]+/gi, "_") || "profile";
    const stamp = new Date().toISOString().slice(0, 10);
    return `Traeky_${profilePart}_${stamp}.${ext}`;
  };

const handleExportCsv = () => {
  if (!transactions || transactions.length === 0) {
    return;
  }

  const exportedAt = new Date().toISOString();

  const headers = [
    "asset_symbol",
    "tx_type",
    "amount",
    "timestamp",
    "price_fiat",
    "fiat_currency",
    "fiat_value",
    "value_eur",
    "value_usd",
    "source",
    "note",
    "tx_id",
    "linked_tx_prev_id",
    "linked_tx_next_id",
    CSV_SCHEMA_VERSION_COLUMN,
    "holding_period_days",
    "base_currency",
    "traeky_exported_at",
  ];

  const rows = transactions.map((tx) => [
    tx.asset_symbol ?? "",
    tx.tx_type ?? "",
    tx.amount != null ? String(tx.amount) : "",
    tx.timestamp ?? "",
    tx.price_fiat != null ? String(tx.price_fiat) : "",
    tx.fiat_currency ?? "",
    tx.fiat_value != null ? String(tx.fiat_value) : "",
    tx.value_eur != null ? String(tx.value_eur) : "",
    tx.value_usd != null ? String(tx.value_usd) : "",
    tx.source ?? "",
    tx.note ?? "",
    tx.tx_id ?? "",
    tx.linked_tx_prev_id != null ? String(tx.linked_tx_prev_id) : "",
    tx.linked_tx_next_id != null ? String(tx.linked_tx_next_id) : "",
    String(CURRENT_CSV_SCHEMA_VERSION),
    String(config?.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS),
    config?.base_currency ?? "EUR",
    exportedAt,
  ]);

  const escapeCell = (value: string) =>
    `"${value.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const csvLines = [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCell).join(",")),
  ];

  const blob = new Blob([csvLines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = buildExportFileName("csv");
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);

  if (activeProfile) {
    writeProfileLastExportAt(activeProfile.id, exportedAt);
    setLastExportAt(exportedAt);
  }
};

  // Save all settings in one coherent write.
  // NOTE: Previously, the UI called multiple save functions back-to-back.
  // Because React state updates are async, the second save could overwrite
  // fields (e.g. holding_period_days) with stale config values, which looked
  // like "Save" resetting the user's changes.
  const handleSaveSettings = () => {
    if (!config) {
      return;
    }

    // Holding period
    const rawHolding = holdingPeriodInput.trim();
    let holdingDays = config.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS;
    if (rawHolding.length > 0) {
      const parsed = parseInt(rawHolding, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        alert(t(lang, "holding_config_invalid"));
        return;
      }
      holdingDays = parsed;
    }

    // API key
    const apiKey = coingeckoApiKeyInput.trim();

    const nextConfig: AppConfig = {
      holding_period_days: holdingDays,
      upcoming_holding_window_days:
        config.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS,
      base_currency: config.base_currency ?? "EUR",
      price_fetch_enabled: priceFetchEnabledInput,
      coingecko_api_key: apiKey.length > 0 ? apiKey : null,
    };

    setConfig(nextConfig);

    if (auth.mode === "local-only") {
      saveLocalAppConfig(nextConfig);
      const expiringNext = computeLocalExpiring(transactions, nextConfig);
      setExpiring(expiringNext);
    }
  };

const handleResetHoldingConfigToDefault = () => {
  const nextConfig: AppConfig = {
    holding_period_days: DEFAULT_HOLDING_PERIOD_DAYS,
    upcoming_holding_window_days:
      config?.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS,
    base_currency: config?.base_currency ?? "EUR",
    price_fetch_enabled: config?.price_fetch_enabled !== false,
    coingecko_api_key: config?.coingecko_api_key ?? null,
  };

  setConfig(nextConfig);

  if (auth.mode === "local-only") {
    saveLocalAppConfig(nextConfig);
    const expiringNext = computeLocalExpiring(transactions, nextConfig);
    setExpiring(expiringNext);
  }
};

  const handleTogglePriceFetchEnabled = (nextEnabled: boolean) => {
    setPriceFetchEnabledInput(nextEnabled);

    if (!config) {
      return;
    }

    const nextConfig: AppConfig = {
      holding_period_days:
        config.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS,
      upcoming_holding_window_days:
        config.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS,
      base_currency: config.base_currency ?? "EUR",
      price_fetch_enabled: nextEnabled,
      coingecko_api_key: config.coingecko_api_key ?? null,
    };

    setConfig(nextConfig);

    if (auth.mode === "local-only") {
      saveLocalAppConfig(nextConfig);
      const expiringNext = computeLocalExpiring(transactions, nextConfig);
      setExpiring(expiringNext);
    }
  };

  const handleExportPdf = async () => {
  try {
    const blob = await dataSource.exportPdf(lang, filteredTransactions);
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildExportFileName("pdf");
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    setError(t(lang, "error_pdf_export"));
  }
};
const handleReloadHoldingPrices = async () => {
  if (!holdings || holdings.length === 0) {
    return;
  }
  if (!config || config.price_fetch_enabled === false) {
    return;
  }
  if (pricesRefreshing) {
    return;
  }
  setPricesRefreshing(true);
  try {
    setCoingeckoApiKey(config.coingecko_api_key ?? null);
    const resp: HoldingsResponse = {
      items: holdings,
      portfolio_value_eur: null,
      portfolio_value_usd: null,
      fx_rate_eur_usd: null,
      fx_rate_usd_eur: null,
    };
    const updated = await applyPricesToHoldings(resp);
    setHoldings(updated.items ?? []);
    setHoldingsPortfolioEur(updated.portfolio_value_eur ?? null);
    setHoldingsPortfolioUsd(updated.portfolio_value_usd ?? null);
    setFxRateEurUsd(updated.fx_rate_eur_usd ?? null);
  } catch (err) {
    console.error("Failed to reload holding prices", err);
  } finally {
    setPricesRefreshing(false);
  }
};





  const holdingDays = config?.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS;
  const upcomingWindowDays =
    config?.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS;

  const portfolioEurRaw =
    holdingsPortfolioEur ??
    holdings.reduce(
      (sum, h) => sum + (h.value_eur != null ? h.value_eur : 0),
      0
    );

  const portfolioEur =
    portfolioEurRaw != null && Math.abs(portfolioEurRaw) > 0.000001
      ? portfolioEurRaw
      : 0;

  let portfolioUsd: number | null =
    holdingsPortfolioUsd ??
    holdings.reduce(
      (sum, h) => sum + (h.value_usd != null ? h.value_usd : 0),
      0
    );

  if (
    (portfolioUsd == null || Math.abs(portfolioUsd) <= 0.000001) &&
    fxRateEurUsd != null &&
    Math.abs(portfolioEur) > 0.000001
  ) {
    portfolioUsd = portfolioEur * fxRateEurUsd;
  }

  const lastChangeAtMs = activeProfile?.updatedAt
    ? new Date(activeProfile.updatedAt).getTime()
    : 0;
  const lastExportAtMs = lastExportAt ? new Date(lastExportAt).getTime() : 0;
  const hasUnsavedExport =
    !!activeProfile &&
    (lastExportAt == null || lastChangeAtMs > lastExportAtMs + 1000);

  const syncLevel = (() => {
    if (!activeProfile) {
      return "sync" as const;
    }
    if (!hasUnsavedExport) {
      return "sync" as const;
    }
    const age = Date.now() - lastChangeAtMs;
    if (age >= SYNC_DANGER_MS) {
      return "danger" as const;
    }
    return "warning" as const;
  })();

  const syncTitle = (() => {
    if (!activeProfile) {
      return t(lang, "header_sync_status_no_profile");
    }
    if (!hasUnsavedExport) {
      return `${t(lang, "header_sync_status_synced")}: ${lastExportAt ?? "-"}`;
    }
    const exportedLabel = lastExportAt ?? t(lang, "header_sync_status_never_exported");
    if (syncLevel === "danger") {
      return `${t(lang, "header_sync_status_stale")} (${exportedLabel})`;
    }
    return `${t(lang, "header_sync_status_pending")} (${exportedLabel})`;
  })();

  return (
    <div className="layout">
      {profileOverview &&
        (profileOverview.profiles.length === 0 ||
          (profileOverview.profiles.length > 0 && (!activeProfile || isProfileLoginOverlayOpen))) && (
        <div className="modal-backdrop">
          <div className="modal">
            {profileOverview.profiles.length === 0 ? (
              <>
                <h2>Traeky</h2>
                <p className="muted">{t(lang, "profile_setup_security_info")}</p>
                <h3>{t(lang, "profile_setup_title")}</h3>
                <p className="muted">{t(lang, "profile_setup_description")}</p>
                {profileOverview.hasLegacyData && (
                  <p className="muted" style={{ marginTop: "0.5rem" }}>
                    {t(lang, "profile_setup_description_migrate")}
                  </p>
                )}
                {profileSetupError && (
                  <p className="error-text modal-error">{profileSetupError}</p>
                )}
                <form
                  onSubmit={handleInitialProfileSubmit}
                  style={{ marginTop: "1rem" }}
                >
                  <div className="form-row">
                    <label className="form-label">
                      <span className="form-label-text">{t(lang, "profile_name_label")}</span>
                      <input
                        type="text"
                        className="input"
                        value={profileNameInput}
                        onChange={(e) => setProfileNameInput(e.target.value)}
                        placeholder={t(lang, "profile_name_placeholder")}
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="form-label">
                      <span className="form-label-text">{t(lang, "profile_pin_label")}</span>
                      <input
                        type="password"
                        className="input"
                        value={profilePinInput}
                        onChange={(e) => setProfilePinInput(e.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="form-label">
                      <span className="form-label-text">{t(lang, "profile_pin_confirm_label")}</span>
                      <input
                        type="password"
                        className="input"
                        value={profilePinConfirmInput}
                        onChange={(e) => setProfilePinConfirmInput(e.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                  <div className="modal-actions">
                    <button type="submit" className="btn-primary">
                      {t(lang, "profile_setup_submit")}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <h2>Traeky</h2>
                <p className="muted">{t(lang, "profile_login_description")}</p>
                {loginError && <p className="error-text modal-error">{loginError}</p>}
                <form
                  onSubmit={handleProfileLoginSubmit}
                  style={{ marginTop: "1rem" }}
                >
                  <div className="form-row">
                    <label className="form-label">
                      <span className="form-label-text">{t(lang, "profile_login_select_label")}</span>
                      <select
                        className="input"
                        value={loginProfileId ?? ""}
                        onChange={(e) =>
                          setLoginProfileId(e.target.value ? e.target.value : null)
                        }
                      >
                        <option value="">
                          {t(lang, "profile_select_placeholder")}
                        </option>
                        {profileOverview.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="form-label">
                      <span className="form-label-text">{t(lang, "profile_login_pin_label")}</span>
                      <input
                        type="password"
                        className="input"
                        value={loginPinInput}
                        onChange={(e) => setLoginPinInput(e.target.value)}
                        autoComplete="current-password"
                      />
                    </label>
                  </div>
                  <div className="modal-actions">
                    {activeProfile && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setIsProfileLoginOverlayOpen(false);
                          setLoginPinInput("");
                          setLoginError(null);
                        }}
                      >
                        {t(lang, "form_cancel")}
                      </button>
                    )}
                    <button type="submit" className="btn-primary">
                      {t(lang, "profile_login_submit")}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
          <div className="modal-footer-brand">
            <p>
              <a
                href="https://github.com/pandabytelabs/traeky"
                target="_blank"
                rel="noreferrer"
              >
                {t(lang, "footer_copyright_brand")}
              </a>
              <span> {t(lang, "footer_madewith")} </span>
              <a
                href="https://pandabyte.net"
                target="_blank"
                rel="noreferrer"
              >
                PANDABYTE
              </a>
            </p>
            <p className="modal-footer-version">Version {APP_VERSION}</p>
          </div>
        </div>
      )}

      

      
        {isAuthModalOpen && (
          <div className="modal-backdrop">
            <div className="modal">
              <h2>{t(lang, "login_title")}</h2>
              <p>{t(lang, "login_description")}</p>
              <p className="muted">{t(lang, "login_encryption_notice")}</p>
              <div style={{ marginTop: "1rem" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={closeAuthModal}
                >
                  {t(lang, "login_close")}
                </button>
              </div>
            </div>
          </div>
        )}

      {isSettingsOpen && (
        <div
          className="settings-overlay-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <div className="settings-overlay" role="dialog" aria-modal="true">
            <section className="settings-section" id="settings-section">

        <div className="settings-header-row">
          <div className="settings-header-text">
            <h2 className="settings-section-title">
              {t(lang, "settings_title")}
            </h2>
            <p className="muted">
              {t(lang, "settings_description")}
            </p>
          </div>
          <button
            type="button"
            className="settings-close-icon"
            onClick={() => setIsSettingsOpen(false)}
            aria-label={t(lang, "settings_close_aria")}
          >
            ×
          </button>
        </div>

        <div className="settings-grid">
<div className="card settings-card">
<div className="sidebar-section">
          <h2>{t(lang, "settings_language_title")}</h2>
          <div className="lang-switch form-row">
            <select
              className="lang-select"
              value={lang}
              onChange={(e) => setLang(e.target.value as Language)}
              aria-label={t(lang, "settings_language_aria")}
            >
              <option value="en">🇬🇧 English</option>
              <option value="de">🇩🇪 Deutsch</option>
            </select>
            <p className="muted settings-field-help">
              {t(lang, "settings_language_info")}
            </p>
          </div>
        </div>
          </div>
          <div className="card settings-card">
<div className="sidebar-section">
          <h2>{t(lang, "base_currency_title")}</h2>
          <div className="form-row">
            <label>{t(lang, "base_currency_label")}</label>
            <select
              value={config?.base_currency ?? "EUR"}
              onChange={(e) => {
                const value = e.target.value === "USD" ? "USD" : "EUR";
                const nextConfig: AppConfig = {
                  holding_period_days:
                    config?.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS,
                  upcoming_holding_window_days:
                    config?.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS,
                  base_currency: value,
                  price_fetch_enabled: config?.price_fetch_enabled !== false,
                  coingecko_api_key: config?.coingecko_api_key ?? null,
                };

                setConfig(nextConfig);

                if (auth.mode === "local-only") {
                  saveLocalAppConfig(nextConfig);
                  const expiringNext = computeLocalExpiring(transactions, nextConfig);
                  setExpiring(expiringNext);
                }
              }}
            >
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
            <p className="muted">{t(lang, "base_currency_hint")}</p>
          </div>
        </div>

        
          </div>
          <div className="card settings-card">
<div className="sidebar-section">
          <h2>{t(lang, "holding_config_title")}</h2>
          <p className="muted">
            {t(lang, "holding_config_description")}
          </p>
          <div className="form-row" style={{ marginTop: "0.5rem" }}>
            <label>{t(lang, "holding_config_days_label")}</label>
            <input
              type="number"
              min={0}
              step={1}
              value={holdingPeriodInput}
              onChange={(e) => {
                const next = e.target.value;
                if (/^\d*$/.test(next)) {
                  setHoldingPeriodInput(next);
                }
              }}
            />
          </div>
          <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
            {t(lang, "holding_config_hint")}
          </p>
          <div style={{ marginTop: "0.5rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "center" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleResetHoldingConfigToDefault}
            >
              {t(lang, "holding_config_reset_button")}
            </button>
          </div>
        </div>

        
          </div>
          <div className="card settings-card">
<div className="sidebar-section">
          <h2>{t(lang, "price_config_section_title")}</h2>
          <p className="muted">
            {t(lang, "price_config_description")}
          </p>
          <div className="form-row" style={{ marginTop: "0.5rem" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.5rem",
              }}
            >
              <span>{t(lang, "price_config_enable_label")}</span>
              <span
                style={{
                  position: "relative",
                  display: "inline-block",
                  width: "40px",
                  height: "20px",
                  borderRadius: "999px",
                  backgroundColor: priceFetchEnabledInput ? "#22c55e" : "#cbd5e1",
                  transition: "background-color 0.2s ease",
                  cursor: "pointer",
                }}
                onClick={() => {
                  handleTogglePriceFetchEnabled(!priceFetchEnabledInput);
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: "2px",
                    left: priceFetchEnabledInput ? "22px" : "2px",
                    width: "16px",
                    height: "16px",
                    borderRadius: "999px",
                    backgroundColor: "#ffffff",
                    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
                    transition: "left 0.2s ease",
                  }}
                />
                <input
                  type="checkbox"
                  checked={priceFetchEnabledInput}
                  onChange={(e) => {
                    handleTogglePriceFetchEnabled(e.target.checked);
                  }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    opacity: 0,
                    margin: 0,
                    cursor: "pointer",
                  }}
                />
              </span>
            </label>
          </div>
          <div className="form-row" style={{ marginTop: "0.5rem" }}>
            <label>{t(lang, "price_config_api_key_label")}</label>
            <input
              type="text"
              value={coingeckoApiKeyInput}
              onChange={(e) => {
                setCoingeckoApiKeyInput(e.target.value);
              }}
              placeholder="CoinGecko API key (optional)"
            />
            <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
              {t(lang, "price_config_api_key_hint")}
            </p>
            {config && config.price_fetch_enabled !== false && getPriceApiStatus().hasError && (
              <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                {t(lang, "price_config_api_warning")}
              </p>
            )}
          </div>
        </div>


          </div>
          <div className="card settings-card">
<div className="sidebar-section" id="csv-section">
          <h2>{t(lang, "csv_title")}</h2>
          <p className="muted">
            {t(lang, "csv_expected")}
            <br />
            {t(lang, "csv_required")}
          </p>
          <p className="muted">
            {t(lang, "csv_version_info")}
            <br />
            {t(lang, "csv_dedup_info")}
          </p>
          <div className="form-row file-row" style={{ marginTop: "0.5rem" }}>
            <div className="file-row-main">
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvChange}
                disabled={csvImporting}
                style={{ display: "none" }}
              />
              <button
                type="button"
                className="btn-secondary export-button"
                onClick={() => {
                  const input = document.getElementById("csv-file") as HTMLInputElement | null;
                  if (input && !input.disabled) {
                    input.click();
                  }
                }}
              >
                {t(lang, "csv_import_button")}
              </button>
              <button
                type="button"
                className="btn-secondary export-button"
                onClick={handleExportCsv}
                disabled={transactions.length === 0}
              >
                {t(lang, "csv_export_button")}
              </button>
            </div>
            {csvFileName && (
              <span className="file-name">{csvFileName}</span>
            )}
          </div>
          {csvImporting && (
            <>
              <p className="muted">{t(lang, "csv_running")}</p>
              <progress />
            </>
          )}
          {csvResult && (
            <div className="csv-result">
              <p className="muted">
                {t(lang, "csv_result_prefix")} {csvResult.imported}
              </p>
              {csvResult.errors && csvResult.errors.length > 0 && (
                <div className="csv-errors">
                  <p className="muted">
                    {t(lang, "csv_result_errors_title")}
                  </p>
                  <ul>
                    {csvResult.errors.map((err, index) => (
                      <li key={index}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

        </div>

        
        
          </div>

 
         <div className="card settings-card">
            <div className="sidebar-section">
              <h2>{t(lang, "reset_local_title")}</h2>
              <p className="muted">{t(lang, "reset_local_description")}</p>
              {activeProfile ? (
                <>
                  {showResetConfirmation ? (
                    <div className="reset-confirm">
                      <p className="muted">
                        {t(lang, "reset_local_confirm_hint")} <code>{RESET_CONFIRMATION_WORD}</code>
                      </p>
                      <div className="form-row" style={{ marginTop: "0.5rem" }}>
                        <input
                          type="text"
                          value={resetConfirmationInput}
                          onChange={(e) => setResetConfirmationInput(e.target.value)}
                          placeholder={RESET_CONFIRMATION_WORD}
                        />
                      </div>
                      <div className="reset-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setShowResetConfirmation(false);
                            setResetConfirmationInput("");
                          }}
                        >
                          {t(lang, "reset_local_cancel")}
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          disabled={resetConfirmationInput !== RESET_CONFIRMATION_WORD}
                          onClick={handleResetProfileData}
                        >
                          {t(lang, "reset_local_confirm_button")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="reset-actions reset-actions-single">
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => {
                          setShowResetConfirmation(true);
                          setResetConfirmationInput("");
                        }}
                      >
                        {t(lang, "reset_local_button_label")}
                      </button>
                    </div>
                  )}

                  <hr style={{ margin: "1.5rem 0", borderColor: "rgba(148, 163, 184, 0.35)" }} />

                  <h2 style={{ marginTop: 0 }}>
                    {t(lang, "profile_delete_button")}
                  </h2>
                  <p className="muted">
                    {t(lang, "profile_delete_description")}
                  </p>
                  {showProfileDeleteConfirmation ? (
                    <div className="reset-confirm" style={{ marginTop: "0.75rem" }}>
                      <p className="muted">
                        {t(lang, "profile_delete_confirmation_hint")}
                      </p>
                      <div className="form-row" style={{ marginTop: "0.5rem" }}>
                        <input
                          type="text"
                          value={profileDeleteConfirmInput}
                          onChange={(e) => setProfileDeleteConfirmInput(e.target.value)}
                          placeholder="DELETE"
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: "0.5rem" }}>
                        <input
                          type="password"
                          value={profileDeletePinInput}
                          onChange={(e) => setProfileDeletePinInput(e.target.value)}
                          placeholder={t(lang, "profile_delete_pin_placeholder")}
                          autoComplete="current-password"
                        />
                      </div>
                      {profileDeleteError && (
                        <p className="error-text" style={{ marginTop: "0.5rem" }}>
                          {profileDeleteError}
                        </p>
                      )}
                      <div className="reset-actions" style={{ marginTop: "0.75rem" }}>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setShowProfileDeleteConfirmation(false);
                            setProfileDeleteConfirmInput("");
                            setProfileDeletePinInput("");
                            setProfileDeleteError(null);
                          }}
                        >
                          {t(lang, "reset_local_cancel")}
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          disabled={
                            profileDeleteConfirmInput !== "DELETE" || !profileDeletePinInput
                          }
                          onClick={handleDeleteProfile}
                        >
                          {t(lang, "profile_delete_button")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="reset-actions reset-actions-single" style={{ marginTop: "0.75rem" }}>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => {
                          setShowProfileDeleteConfirmation(true);
                          setProfileDeleteConfirmInput("");
                          setProfileDeletePinInput("");
                          setProfileDeleteError(null);
                        }}
                      >
                        {t(lang, "profile_delete_button")}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="muted">
                  {t(lang, "no_active_profile_message")}
                </p>
              )}
            </div>

          </div>
        </div>

<div className="settings-actions">
                <button
                  type="button"
                  className={isSettingsDirty ? "btn-primary" : "btn-secondary"}
                  onClick={() => {
                    if (isSettingsDirty) {
                      if (config) {
                        handleSaveSettings();
                      }

                      // Do not force-set isSettingsDirty here.
                      // The dirty-state should be derived from (config vs inputs),
                      // so that failed validations keep the button as "Save".
                    } else {
                      setIsSettingsOpen(false);
                    }
                  }}
                  disabled={isSettingsDirty && !config}
                >
                  {isSettingsDirty
                    ? t(lang, "settings_save_button")
                    : t(lang, "common_close")}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
<main className="main">
        <header className="header">
          <div>
            <div className="header-title-row">
              <h2>Traeky</h2>
              <span className="version-badge">v{APP_VERSION}</span>
            </div>
            <p className="header-mode-explainer">
                            {t(lang, "header_mode_explainer_local")}
            </p>
          </div>
          <div className="header-right">
            {auth.isAuthenticated && (
              <span
                className="pill pill-small"
                title={t(lang, "header_mode_pill_local_hint")}
              >
                {t(lang, "login_status_cloud")}
              </span>
            )}
            {auth.isAuthenticated && (
              <button
                type="button"
                className="btn-secondary"
                onClick={logout}
              >
                {t(lang, "header_logout_button")}
              </button>
            )}
            <button
              type="button"
              className={`icon-circle-button sync-indicator sync-indicator--${syncLevel}`}
              onClick={() => {
                setIsProfileMenuOverlayOpen(false);
                handleExportCsv();
              }}
              aria-label={t(lang, "header_sync_button")}
              title={syncTitle}
              disabled={!activeProfile}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                focusable="false"
              >
                <path
                  d="M12 2C7.6 2 4 3.8 4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6c0-2.2-3.6-4-8-4zm0 2c3.9 0 6 .9 6 2s-2.1 2-6 2-6-.9-6-2 2.1-2 6-2zm0 6c3.9 0 6-.9 6-2v3c0 1.1-2.1 2-6 2s-6-.9-6-2V8c0 1.1 2.1 2 6 2zm0 5c3.9 0 6-.9 6-2v3c0 1.1-2.1 2-6 2s-6-.9-6-2v-3c0 1.1 2.1 2 6 2z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <button
              type="button"
              className="icon-circle-button"
              onClick={() => {
                setIsSettingsOpen(true);
                setIsProfileMenuOverlayOpen(false);
              }}
              aria-label={t(lang, "header_settings_button")}
            >
              <span aria-hidden="true">⚙</span>
            </button>
            <div className="profile-dropdown" ref={profileDropdownRef}>
              <button
                type="button"
                className="icon-circle-button"
                onClick={() => {
                  setIsProfileMenuOverlayOpen((open) => !open);
                }}
                aria-label={t(lang, "header_profile_button")}
              >
                <span aria-hidden="true" className="icon-user" />
              </button>
              {isProfileMenuOverlayOpen && activeProfile && (
                <div className="profile-dropdown-menu">
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setRenameProfileNameInput(activeProfile!.name);
                      setRenameProfileError(null);
                      setIsRenameProfileOverlayOpen(true);
                      setIsProfileMenuOverlayOpen(false);
                    }}
                  >
                    {t(lang, "profile_menu_rename")}
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setPinChangeCurrentPinInput("");
                      setPinChangeNewPinInput("");
                      setPinChangeNewPinConfirmInput("");
                      setPinChangeError(null);
                      setIsPinChangeOverlayOpen(true);
                      setIsProfileMenuOverlayOpen(false);
                    }}
                  >
                    {t(lang, "profile_menu_change_pin")}
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setCreateProfileNameInput("");
                      setCreateProfilePinInput("");
                      setCreateProfilePinConfirmInput("");
                      setCreateProfileError(null);
                      setIsCreateProfileOverlayOpen(true);
                      setIsProfileMenuOverlayOpen(false);
                    }}
                  >
                    {t(lang, "profile_menu_add_profile")}
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="icon-circle-button"
              onClick={() => {
                if (!activeProfile) return;
                logoutActiveProfileSession();
                setActiveProfile(null);
                setProfileOverview(null);
                setHoldings([]);
                setHoldingsPortfolioEur(null);
                setHoldingsPortfolioUsd(null);
                setFxRateEurUsd(null);
                setTransactions([]);
                setExpiring([]);
                setError(null);
                setTxFilterYear("");
                setTxFilterAsset("");
                setTxFilterType("");
                setTxSearch("");
                setIsProfileMenuOverlayOpen(false);
                const overview = getProfileOverview();
                setProfileOverview(overview);
                if (overview.profiles.length > 0) {
                  setLoginProfileId(overview.profiles[0].id);
                } else {
                  setLoginProfileId("");
                }
                setLoginPinInput("");
                setLoginError(null);
                setIsProfileLoginOverlayOpen(true);
              }}
              aria-label={t(lang, "profile_menu_logout")}
              disabled={!activeProfile}
            >
              <span aria-hidden="true">⏻</span>
            </button>
          </div>

        </header>

        <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
              <h3 style={{ margin: 0 }}>{t(lang, "holdings_title")}</h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setShowTransactionForm(true)}
                >
                  {t(lang, "tx_new_open_button")}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowExternalImport(true)}
                >
                  {t(lang, "external_import_open_button")}
                </button>
              </div>
            {loading && (
              <p className="muted">{t(lang, "holdings_price_loading")}</p>
            )}
            </div>
            {displayHoldings.length === 0 ? (
              <p className="muted">{t(lang, "holdings_empty")}</p>
            ) : (
              <>
                                
                <div className="holdings-summary">
                  <div className="holdings-summary-item">
                    <div className="holdings-summary-label">
                      {t(lang, "holdings_portfolio_value")}
                    </div>
                    <div className="holdings-summary-value">
                      {(() => {
                        const baseIsUsd = config?.base_currency === "USD";
                        const primaryRaw = baseIsUsd
                          ? portfolioUsd ?? null
                          : portfolioEur ?? null;
                        const primarySymbol = baseIsUsd ? "$" : "€";
                        const fallbackRaw = baseIsUsd
                          ? portfolioEur ?? null
                          : portfolioUsd ?? null;
                        const fallbackSymbol = baseIsUsd ? "€" : "$";

                        const fmt = (
                          value: number | null | undefined,
                          symbol: string,
                        ): string | null => {
                          if (value == null || Math.abs(value) <= 0.000001)
                            return null;
                          return `${value.toLocaleString(currentLocale, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })} ${symbol}`;
                        };

                        return (
                          fmt(primaryRaw, primarySymbol) ??
                          fmt(fallbackRaw, fallbackSymbol) ??
                          "-"
                        );
                      })()}
                    </div>
                  </div>
                  <div className="holdings-summary-item">
                    <div className="holdings-summary-label">
                      {t(lang, "holdings_portfolio_assets_count")}
                    </div>
                    <div className="holdings-summary-value">
                      {displayHoldings.length}
                    </div>
                  </div>
                </div>
                <div className="holdings-grid">
                  {displayHoldings.map((h) => {
                    const baseIsUsd = config?.base_currency === "USD";
                    const primaryRaw = baseIsUsd
                      ? h.value_usd ?? null
                      : h.value_eur ?? null;
                    const primarySymbol = baseIsUsd ? "$" : "€";

                    const value =
                      primaryRaw != null
                        ? `${primaryRaw.toLocaleString(currentLocale, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })} ${primarySymbol}`
                        : null;

                    return (
                      <div key={h.asset_symbol} className="holding-card">
                        <div className="holding-card-header">
                          <span
                            className="holding-asset"
                            title={
                              getAssetMetadata(h.asset_symbol)?.name ||
                              h.asset_symbol ||
                              undefined
                            }
                          >
                            {getAssetMetadata(h.asset_symbol)?.symbol ?? h.asset_symbol}
                          </span>
                        </div>
                        <div className="holding-card-body">
                          <div className="holding-row">
                            <span className="holding-label">
                              {t(lang, "holdings_col_amount")}
                            </span>
                            <span className="holding-value">
                              {h.total_amount.toLocaleString(currentLocale, {
                                maximumFractionDigits: 8,
                              })}
                            </span>
                          </div>
                          <div className="holding-row">
                            <span className="holding-label">
                              {config?.base_currency === "USD"
                                ? t(lang, "holdings_col_value_usd")
                                : t(lang, "holdings_col_value_eur")}
                            </span>
                            <span className="holding-value">
                              {value ?? (
                                <>
                                  <span className="holding-value-na">N/A</span>
                                  <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t(
                                      lang,
                                      "holdings_price_reload",
                                    )}
                                    title={t(lang, "holdings_price_reload")}
                                    disabled={pricesRefreshing}
                                    onClick={handleReloadHoldingPrices}
                                  >
                                    {pricesRefreshing ? "…" : "⟳"}
                                  </button>
                                </>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
        </section>
<section className="card">
          <div className="card-header-row">
            <h3>{t(lang, "table_tx_title")}</h3>
            <button
              type="button"
              className="btn-secondary export-button"
              onClick={handleExportPdf}
              disabled={filteredTransactions.length === 0}
            >
              {t(lang, "action_export_pdf")}
            </button>
          </div>
          <div className="tx-filters">
          <div className="tx-filter-group form-row">
            <label>{t(lang, "tx_filter_year_label")}</label>
            <select
              value={txFilterYear}
              onChange={(e) => {
                setTxFilterYear(e.target.value);
                setTxPage(1);
              }}
            >
              <option value="">{t(lang, "tx_filter_year_all")}</option>
              {Array.from(
                new Set(
                  transactions
                    .map((tx) => (tx.timestamp ? tx.timestamp.slice(0, 4) : ""))
                    .filter((y) => y),
                ),
              )
                .sort()
                .map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
            </select>
          </div>
          <div className="tx-filter-group form-row">
            <label>{t(lang, "tx_filter_asset_label")}</label>
            <input
              type="text"
              value={txFilterAsset}
              onChange={(e) => {
                setTxFilterAsset(e.target.value);
                setTxPage(1);
              }}
              placeholder={t(lang, "tx_filter_asset_placeholder")}
            />
          </div>
          <div className="tx-filter-group form-row">
            <label>{t(lang, "tx_filter_type_label")}</label>
            <select
              value={txFilterType}
              onChange={(e) => {
                setTxFilterType(e.target.value);
                setTxPage(1);
              }}
            >
              <option value="">{t(lang, "tx_filter_type_all")}</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="TRANSFER_IN">TRANSFER (IN)</option>
              <option value="TRANSFER_INTERNAL">TRANSFER (INTERNAL)</option>
              <option value="TRANSFER_OUT">TRANSFER (OUT)</option>
              <option value="STAKING_REWARD">STAKING REWARD</option>
              <option value="AIRDROP">AIRDROP</option>
            </select>
          </div>
          <div className="tx-filter-group tx-filter-search form-row">
            <label>{t(lang, "tx_filter_search_label")}</label>
            <input
              type="text"
              value={txSearch}
              onChange={(e) => {
                setTxSearch(e.target.value);
                setTxPage(1);
              }}
              placeholder={t(lang, "tx_filter_search_placeholder")}
            />
          </div>
        </div>

        {txChainFilterRootId != null && (
          <div className="tx-chain-filter-info">
            <span>
              {t(lang, "tx_chain_filter_label")} {txChainFilterRootId}
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setTxChainFilterRootId(null);
                setTxPage(1);
              }}
            >
              {t(lang, "tx_chain_filter_clear")}
            </button>
          </div>
        )}

        {filteredTransactions.length === 0 ? (
            <p className="muted">{t(lang, "table_tx_empty")}</p>
          ) : (
            <>
            <table className="table table-striped tx-table">
              <thead>
                <tr>
                  <th>{t(lang, "table_col_id")}</th>
                  <th>{t(lang, "table_col_chain")}</th>
                  <th>{t(lang, "table_col_time")}</th>
                  <th>{t(lang, "table_col_asset")}</th>
                  <th>{t(lang, "table_col_type")}</th>
                  <th>{t(lang, "table_col_amount")}</th>
                  <th>{t(lang, "table_col_price")}</th>
                  <th>{t(lang, "table_col_value")}</th>
                  <th>{t(lang, "table_col_tx_id")}</th>
                  <th>{t(lang, "table_col_source")}</th>
                  <th>{t(lang, "table_col_holding")}</th>
                  <th>{t(lang, "table_col_note")}</th>
                  <th>{t(lang, "table_col_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {paginatedTransactions.map((tx, index) => {
                  const reached = isHoldingPeriodReached(tx, holdingDays);
                  const endDate = holdingPeriodEndDate(tx, holdingDays);

                  return (
                    <tr key={tx.id ?? `tx-${index}`}>
                      <td>{tx.id}</td>
                      <td>
                        {(() => {
                          const hasNext = typeof tx.linked_tx_next_id === "number";
                          const hasPrev = typeof tx.linked_tx_prev_id === "number";
                          if (!hasNext && !hasPrev) {
                            return "–";
                          }
                          return (
                            <div className="tx-chain-links">
                              {hasNext && (
                                <button
                                  type="button"
                                  className="tx-chain-link"
                                  onClick={() => {
                                    if (typeof tx.linked_tx_next_id === "number") {
                                      setTxChainFilterRootId(tx.linked_tx_next_id);
                                      setTxFilterYear("");
                                      setTxFilterAsset("");
                                      setTxFilterType("");
                                      setTxSearch("");
                                      setTxPage(1);
                                    }
                                  }}
                                >
                                  <span className="tx-chain-label">Next:</span>
                                  {tx.linked_tx_next_id}
                                </button>
                              )}
                              {hasPrev && (
                                <button
                                  type="button"
                                  className="tx-chain-link"
                                  onClick={() => {
                                    if (typeof tx.linked_tx_prev_id === "number") {
                                      setTxChainFilterRootId(tx.linked_tx_prev_id);
                                      setTxFilterYear("");
                                      setTxFilterAsset("");
                                      setTxFilterType("");
                                      setTxSearch("");
                                      setTxPage(1);
                                    }
                                  }}
                                >
                                  <span className="tx-chain-label">Prev:</span>
                                  {tx.linked_tx_prev_id}
                                </button>
                              )}
                            </div>
                          );
                        })()}                      </td>
                      <td>
  {(() => {
    const formatted = dateTimeFormatter.format(new Date(tx.timestamp));
    const parts = formatted.split(",");
    const datePart = parts[0]?.trim() ?? formatted;
    const timePart = parts[1]?.trim();

    // Render date and time on separate lines, breaking after the comma
    if (!timePart) {
      return formatted;
    }

    return (
      <>
        {datePart}
        {","}
        <br />
        {timePart}
      </>
    );
  })()}
</td>
                      <td
  title={
    getAssetMetadata(tx.asset_symbol)?.name ||
    tx.asset_symbol ||
    undefined
  }
>
  {getAssetMetadata(tx.asset_symbol)?.symbol ?? tx.asset_symbol}
</td>
                      <td>{formatTxTypeLabel(tx.tx_type)}</td>
                      <td>{tx.amount}</td>
                                            <td>
                        {(() => {
                          const baseCurrency = config?.base_currency === "USD" ? "USD" : "EUR";
                          const amount = typeof tx.amount === "number" ? tx.amount : 0;

                          let totalValue: number | null = null;

                          if (baseCurrency === "USD") {
                            if (typeof tx.value_usd === "number" && Number.isFinite(tx.value_usd)) {
                              totalValue = tx.value_usd;
                            } else if (
                              tx.fiat_currency === "USD" &&
                              typeof tx.fiat_value === "number" &&
                              Number.isFinite(tx.fiat_value)
                            ) {
                              totalValue = tx.fiat_value;
                            }
                          } else {
                            if (typeof tx.value_eur === "number" && Number.isFinite(tx.value_eur)) {
                              totalValue = tx.value_eur;
                            } else if (
                              tx.fiat_currency === "EUR" &&
                              typeof tx.fiat_value === "number" &&
                              Number.isFinite(tx.fiat_value)
                            ) {
                              totalValue = tx.fiat_value;
                            }
                          }

                          if (totalValue == null) {
                            return "-";
                          }

                          if (!Number.isFinite(amount) || amount === 0) {
                            return "-";
                          }

                          const unitPrice = totalValue / amount;

                          return `${unitPrice.toLocaleString(currentLocale, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })} ${baseCurrency}`;
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const baseCurrency = config?.base_currency === "USD" ? "USD" : "EUR";

                          let totalValue: number | null = null;

                          if (baseCurrency === "USD") {
                            if (typeof tx.value_usd === "number" && Number.isFinite(tx.value_usd)) {
                              totalValue = tx.value_usd;
                            } else if (
                              tx.fiat_currency === "USD" &&
                              typeof tx.fiat_value === "number" &&
                              Number.isFinite(tx.fiat_value)
                            ) {
                              totalValue = tx.fiat_value;
                            }
                          } else {
                            if (typeof tx.value_eur === "number" && Number.isFinite(tx.value_eur)) {
                              totalValue = tx.value_eur;
                            } else if (
                              tx.fiat_currency === "EUR" &&
                              typeof tx.fiat_value === "number" &&
                              Number.isFinite(tx.fiat_value)
                            ) {
                              totalValue = tx.fiat_value;
                            }
                          }

                          if (totalValue == null) {
                            return "-";
                          }

                          return `${totalValue.toLocaleString(currentLocale, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })} ${baseCurrency}`;
                        })()}
                      </td>

                      <td>
  {tx.tx_id ? (
    (() => {
      const url = getTxExplorerUrl(tx.asset_symbol, tx.tx_id);
      if (!url) {
        return tx.tx_id;
      }
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="txid-link">
          {tx.tx_id}
        </a>
      );
    })()
  ) : (
    "-"
  )}
</td>
                      <td>{tx.source || "-"}</td>
                      <td>
                        {!isTaxRelevant(tx) ? (
                          "-"
                        ) : reached ? (
                          <span className="pill pill-success">
                            {t(lang, "holding_reached")}
                          </span>
                        ) : endDate ? (
                          <span className="pill pill-warning">
                            {dateFormatter.format(endDate)}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>{tx.note || "-"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setEditingId(tx.id);
                            setForm({
                              asset_symbol: tx.asset_symbol,
                              tx_type: tx.tx_type,
                              amount: tx.amount.toString(),
                              price_fiat:
                                tx.price_fiat != null
                                  ? tx.price_fiat.toString()
                                  : "",
                              fiat_currency: tx.fiat_currency,
                              timestamp: timestampToLocalInputValue(tx.timestamp),
                              source: tx.source || "",
                              note: tx.note || "",
                              tx_id: tx.tx_id || "",
                              linked_tx_prev_id:
                                tx.linked_tx_prev_id != null
                                  ? String(tx.linked_tx_prev_id)
                                  : "",
                              linked_tx_next_id:
                                tx.linked_tx_next_id != null
                                  ? String(tx.linked_tx_next_id)
                                  : "",
                            });
                            setShowTransactionForm(true);
                          }}
                        >
                          {t(lang, "action_edit")}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => handleDelete(tx.id)}
                          style={{ marginLeft: "0.5rem" }}
                        >
                          {t(lang, "action_delete")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="tx-pagination">
              <div className="tx-page-size">
                <div className="form-row">
                  <label>{t(lang, "tx_pagination_page_size_label")}</label>
                  <select
                    value={txPageSize}
                    onChange={(e) => {
                      const newSize = parseInt(e.target.value, 10);
                      const safeSize = Number.isFinite(newSize) && newSize > 0 ? newSize : 25;
                      setTxPageSize(safeSize);
                      setTxPage(1);
                    }}
                  >
                    {[10, 25, 50, 100].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="tx-page-controls">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={currentPage <= 1}
                  onClick={() => setTxPage((prev) => Math.max(1, prev - 1))}
                >
                  {t(lang, "tx_pagination_prev")}
                </button>
                <span className="tx-page-info">
                  {t(lang, "tx_pagination_page_label")} {currentPage} {t(lang, "tx_pagination_of")} {totalPages}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={currentPage >= totalPages || totalTransactions === 0}
                  onClick={() => setTxPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  {t(lang, "tx_pagination_next")}
                </button>
              </div>
            </div>
            </>
          )}
        </section>

        
        {holdingDays > 0 && (
<section className="card" style={{ marginTop: "0.5rem" }}>
          <h3>
            {t(lang, "expiring_title")}
            {upcomingWindowDays && (
              <span className="pill pill-info" style={{ marginLeft: "0.5rem" }}>
                {t(lang, "expiring_window_prefix")}: {upcomingWindowDays}{" "}
                {t(lang, "holding_period_days_suffix")}
              </span>
            )}
          </h3>
          {expiring.length === 0 ? (
            <p className="muted">{t(lang, "expiring_empty")}</p>
          ) : (
            <>
            <table className="table table-striped">
              <thead>
                <tr>
                  <th>{t(lang, "expiring_col_buy_time")}</th>
                  <th>{t(lang, "expiring_col_asset")}</th>
                  <th>{t(lang, "expiring_col_amount")}</th>
                  <th>{t(lang, "expiring_col_end")}</th>
                  <th>{t(lang, "expiring_col_days_left")}</th>
                  <th>{t(lang, "table_col_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {expiring.map((e, index) => (
                  <tr key={e.transaction_id ?? `exp-${index}`}>
                    <td>{dateTimeFormatter.format(new Date(e.timestamp))}</td>
                    <td>{e.asset_symbol}</td>
                    <td>{e.amount}</td>
                    <td>{dateFormatter.format(new Date(e.holding_period_end))}</td>
                    <td>{e.days_remaining}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          const tx = transactions.find(
                            (t) => t.id === e.transaction_id
                          );
                          if (!tx) return;

                          setEditingId(tx.id);
                          setForm({
                            asset_symbol: tx.asset_symbol,
                            tx_type: tx.tx_type,
                            amount: tx.amount.toString(),
                            price_fiat:
                              tx.price_fiat != null
                                ? tx.price_fiat.toString()
                                : "",
                            fiat_currency: tx.fiat_currency,
                            timestamp: timestampToLocalInputValue(tx.timestamp),
                            source: tx.source || "",
                            note: tx.note || "",
                            tx_id: tx.tx_id || "",
                            linked_tx_prev_id:
                              tx.linked_tx_prev_id != null
                                ? String(tx.linked_tx_prev_id)
                                : "",
                            linked_tx_next_id:
                              tx.linked_tx_next_id != null
                                ? String(tx.linked_tx_next_id)
                                : "",
                          });
                          setShowTransactionForm(true);
                        }}
                      >
                        {t(lang, "action_edit")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="tx-pagination">
              <div className="tx-page-size">
                <div className="form-row">
                  <label>{t(lang, "tx_pagination_page_size_label")}</label>
                  <select
                    value={txPageSize}
                    onChange={(e) => {
                      const newSize = parseInt(e.target.value, 10);
                      const safeSize = Number.isFinite(newSize) && newSize > 0 ? newSize : 25;
                      setTxPageSize(safeSize);
                      setTxPage(1);
                    }}
                  >
                    {[10, 25, 50, 100].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="tx-page-controls">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={currentPage <= 1}
                  onClick={() => setTxPage((prev) => Math.max(1, prev - 1))}
                >
                  {t(lang, "tx_pagination_prev")}
                </button>
                <span className="tx-page-info">
                  {t(lang, "tx_pagination_page_label")} {currentPage} {t(lang, "tx_pagination_of")} {totalPages}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={currentPage >= totalPages || totalTransactions === 0}
                  onClick={() => setTxPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  {t(lang, "tx_pagination_next")}
                </button>
              </div>
            </div>
            </>
          )}
        </section>
        )}

      
      {showTransactionForm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            className="card"
            style={{
              position: "relative",
              maxWidth: "720px",
              width: "100%",
              maxHeight: "80vh",
              overflow: "auto",
            }}
          >
            <button
              type="button"
              className="btn-icon-close"
              onClick={() => {
                resetForm();
                setShowTransactionForm(false);
              }}
              aria-label={t(lang, "close_overlay")}
              title={t(lang, "close_overlay")}
            >
              ×
            </button>
            <h3>
              {editingId ? t(lang, "form_title_edit") : t(lang, "form_title_new")}
            </h3>
            {error && (
              <p className="error-text" style={{ marginTop: "0.5rem" }}>
                {error}
              </p>
            )}
            <form className="form" onSubmit={handleSubmit}>
              <div className="form-row">
                <label>{t(lang, "form_asset")}</label>
                <input
                  name="asset_symbol"
                  value={form.asset_symbol}
                  onChange={handleChange}
                  placeholder="IOTA, BTC, ETH..."
                  required
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_type")}</label>
                <select name="tx_type" value={form.tx_type} onChange={handleChange}>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                  <option value="TRANSFER_IN">TRANSFER (IN)</option>
                  <option value="TRANSFER_OUT">TRANSFER (OUT)</option>
                  <option value="STAKING_REWARD">STAKING REWARD</option>
                  <option value="AIRDROP">AIRDROP</option>
                  <option value="TRANSFER_INTERNAL">TRANSFER (INTERNAL)</option>
                </select>
              </div>
              <div className="form-row">
                <label>{t(lang, "form_amount")}</label>
                <input
                  type="number"
                  step="0.00000001"
                  name="amount"
                  value={form.amount}
                  onChange={handleChange}
                  placeholder="0"
                  required
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_price")}</label>
                <input
                  type="number"
                  step="0.00000001"
                  name="price_fiat"
                  value={form.price_fiat}
                  onChange={handleChange}
                  placeholder={t(lang, "form_price_placeholder")}
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_pair_currency")}</label>
                <input
                  name="fiat_currency"
                  value={form.fiat_currency}
                  onChange={handleChange}
                  placeholder={t(lang, "form_pair_currency_placeholder")}
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_timestamp")}</label>
                <input
                  type="datetime-local"
                  name="timestamp"
                  value={form.timestamp}
                  onChange={handleChange}
                  required
                  lang={currentLocale}
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_source")}</label>
                <input
                  name="source"
                  value={form.source}
                  onChange={handleChange}
                  placeholder={t(lang, "form_source_placeholder")}
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_tx_id")}</label>
                <input
                  name="tx_id"
                  value={form.tx_id}
                  onChange={handleChange}
                  placeholder="optional"
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_linked_prev_tx")}</label>
                <input
                  name="linked_tx_prev_id"
                  value={form.linked_tx_prev_id}
                  onChange={handleChange}
                  placeholder={t(lang, "form_linked_prev_tx_placeholder")}
                  type="number"
                  min="1"
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_linked_next_tx")}</label>
                <input
                  name="linked_tx_next_id"
                  value={form.linked_tx_next_id}
                  onChange={handleChange}
                  placeholder={t(lang, "form_linked_next_tx_placeholder")}
                  type="number"
                  min="1"
                />
              </div>
              <div className="form-row">
                <label>{t(lang, "form_note")}</label>
                <textarea
                  name="note"
                  value={form.note}
                  onChange={handleChange}
                  rows={2}
                  placeholder={t(lang, "form_note_placeholder")}
                />
              </div>

              <div className="form-actions">
                <button type="submit" className="btn-primary">
                  {editingId ? t(lang, "form_update") : t(lang, "form_save")}
                </button>
                {editingId && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={resetForm}
                  >
                    {t(lang, "close_overlay")}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {showExternalImport && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            className="card"
            style={{
              position: "relative",
              maxWidth: "720px",
              width: "100%",
              maxHeight: "80vh",
              overflow: "auto",
            }}
          >
            <button
              type="button"
              className="btn-icon-close"
              onClick={() => {
                setShowExternalImport(false);
                setExternalImportResult(null);
                setExternalFileName(null);
                setExternalImportSource("binance_trade_xlsx");
              }}
              aria-label={t(lang, "close_overlay")}
              title={t(lang, "close_overlay")}
            >
              ×
            </button>
            <h3>{t(lang, "external_import_title")}</h3>
            <p className="muted">
              {t(lang, "external_import_description")}
            </p>

            <div className="form">
              <div className="form-row">
                <label>{t(lang, "external_import_source_label")}</label>
                <select
                  value={externalImportSource}
                  onChange={(e) => {
                    setExternalImportSource(e.target.value);
                    setExternalImportResult(null);
                    setExternalFileName(null);
                  }}
                >
                  <option value="binance_trade_xlsx">
                    {t(lang, "external_import_source_binance_xlsx")}
                  </option>
                  <option value="bitpanda_csv">
                    {t(lang, "external_import_source_bitpanda_csv")}
                  </option>
                </select>
              </div>

              <div className="form-row file-row">
                <label>{t(lang, "external_import_file_label")}</label>
                <div className="file-input-wrapper">
                  <input
                    type="file"
                    accept={
                      externalImportSource === "binance_trade_xlsx"
                        ? ".xlsx"
                        : ".csv"
                    }
                    onChange={handleExternalFileChange}
                    disabled={externalImporting}
                  />
                  <span className="file-name">
                    {externalFileName || t(lang, "external_import_no_file")}
                  </span>
                </div>
              </div>
            </div>

            {externalImporting && (
              <>
                <p className="muted">{t(lang, "external_import_running")}</p>
                <progress />
              </>
            )}

            {externalImportResult && (
              <div className="csv-result">
                <p className="muted">
                  {t(lang, "csv_result_prefix")} {externalImportResult.imported}
                </p>
                {externalImportResult.errors &&
                  externalImportResult.errors.length > 0 && (
                    <div className="csv-errors">
                      <p className="muted">
                        {t(lang, "csv_result_errors_title")}
                      </p>
                      <ul>
                        {externalImportResult.errors.map((err, index) => (
                          <li key={index}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  )}
              </div>
            )}

            <div
              style={{
                marginTop: "1rem",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowExternalImport(false)}
              >
                {t(lang, externalImportResult ? "external_import_done_button" : "form_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}



      {false && isProfileMenuOverlayOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-header">
              <h2>{t(lang, "profile_section_title")}</h2>
              <button
                type="button"
                className="icon-button modal-close-button"
                onClick={() => setIsProfileMenuOverlayOpen(false)}
                aria-label={t(lang, "form_cancel")}
              >
                ×
              </button>
            </div>
            <p className="muted">
              {t(lang, "profile_active_description")}
            </p>
            <div className="profile-menu-active">
              {activeProfile ? (
                <>
                  <p className="muted" style={{ marginTop: "0.75rem" }}>
                    {t(lang, "profile_active_label")}
                  </p>
                  <p style={{ fontWeight: 600, marginTop: "0.25rem" }}>
                    {activeProfile!.name}
                  </p>
                </>
              ) : (
                <p className="muted" style={{ marginTop: "0.75rem" }}>
                  {t(lang, "profile_active_empty_message")}
                </p>
              )}
            </div>
            {activeProfile && (
              <div className="profile-menu-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    if (!activeProfile) return;
                    setRenameProfileNameInput(activeProfile!.name);
                    setRenameProfileError(null);
                    setIsRenameProfileOverlayOpen(true);
                    setIsProfileMenuOverlayOpen(false);
                  }}
                >
                  {t(lang, "profile_rename_title")}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setPinChangeCurrentPinInput("");
                    setPinChangeNewPinInput("");
                    setPinChangeNewPinConfirmInput("");
                    setPinChangeError(null);
                    setIsPinChangeOverlayOpen(true);
                    setIsProfileMenuOverlayOpen(false);
                  }}
                >
                  {t(lang, "pin_change_title")}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setCreateProfileNameInput("");
                    setCreateProfilePinInput("");
                    setCreateProfilePinConfirmInput("");
                    setCreateProfileError(null);
                    setIsCreateProfileOverlayOpen(true);
                    setIsProfileMenuOverlayOpen(false);
                  }}
                >
                  {t(lang, "profile_add_another")}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    const overview = getProfileOverview();
                    setProfileOverview(overview);
                    if (overview.profiles.length > 0 && !loginProfileId) {
                      setLoginProfileId(overview.profiles[0].id);
                    }
                    setLoginPinInput("");
                    setLoginError(null);
                    setIsProfileLoginOverlayOpen(true);
                    setIsProfileMenuOverlayOpen(false);
                  }}
                >
                  {t(lang, "profile_switch")}
                </button>
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsProfileMenuOverlayOpen(false)}
              >
                {t(lang, "form_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {isRenameProfileOverlayOpen && activeProfile && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{t(lang, "profile_rename_title")}</h2>
            <p className="muted">
              {t(lang, "profile_rename_description")}
            </p>
            {renameProfileError && (
              <p className="error-text modal-error">{renameProfileError}</p>
            )}
            <form
              onSubmit={handleRenameProfileSubmit}
              style={{ marginTop: "1rem" }}
            >
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">
                    {t(lang, "profile_rename_new_name_label")}
                  </span>
                  <input
                    type="text"
                    className="input"
                    value={renameProfileNameInput}
                    onChange={(e) => setRenameProfileNameInput(e.target.value)}
                  />
                </label>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setIsRenameProfileOverlayOpen(false);
                    setRenameProfileError(null);
                  }}
                >
                  {t(lang, "form_cancel")}
                </button>
                <button type="submit" className="btn-primary">
                  {t(lang, "common_save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isPinChangeOverlayOpen && activeProfile && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{t(lang, "pin_change_title")}</h2>
            <p className="muted">
              {t(lang, "pin_change_description")}
            </p>
            {pinChangeError && (
              <p className="error-text modal-error">{pinChangeError}</p>
            )}
            <form
              onSubmit={handlePinChangeSubmit}
              style={{ marginTop: "1rem" }}
            >
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">
                    {t(lang, "pin_change_current_label")}
                  </span>
                  <input
                    type="password"
                    className="input"
                    value={pinChangeCurrentPinInput}
                    onChange={(e) => setPinChangeCurrentPinInput(e.target.value)}
                    autoComplete="current-password"
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">
                    {t(lang, "pin_change_new_label")}
                  </span>
                  <input
                    type="password"
                    className="input"
                    value={pinChangeNewPinInput}
                    onChange={(e) => setPinChangeNewPinInput(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">
                    {t(lang, "pin_change_repeat_label")}
                  </span>
                  <input
                    type="password"
                    className="input"
                    value={pinChangeNewPinConfirmInput}
                    onChange={(e) => setPinChangeNewPinConfirmInput(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setIsPinChangeOverlayOpen(false);
                    setPinChangeCurrentPinInput("");
                    setPinChangeNewPinInput("");
                    setPinChangeNewPinConfirmInput("");
                    setPinChangeError(null);
                  }}
                >
                  {t(lang, "form_cancel")}
                </button>
                <button type="submit" className="btn-primary">
                  {t(lang, "pin_change_submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isCreateProfileOverlayOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{t(lang, "profile_add_another")}</h2>
            <p className="muted">
              {t(lang, "profile_add_another_description")}
            </p>
            {createProfileError && (
              <p className="error-text modal-error">{createProfileError}</p>
            )}
            <form
              onSubmit={handleCreateProfileSubmit}
              style={{ marginTop: "1rem" }}
            >
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">{t(lang, "profile_name_label")}</span>
                  <input
                    type="text"
                    className="input"
                    value={createProfileNameInput}
                    onChange={(e) => setCreateProfileNameInput(e.target.value)}
                    placeholder={t(lang, "profile_name_placeholder")}
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">{t(lang, "profile_pin_label")}</span>
                  <input
                    type="password"
                    className="input"
                    value={createProfilePinInput}
                    onChange={(e) => setCreateProfilePinInput(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="form-label">
                  <span className="form-label-text">{t(lang, "profile_pin_confirm_label")}</span>
                  <input
                    type="password"
                    className="input"
                    value={createProfilePinConfirmInput}
                    onChange={(e) => setCreateProfilePinConfirmInput(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setIsCreateProfileOverlayOpen(false);
                    setCreateProfileError(null);
                  }}
                >
                  {t(lang, "form_cancel")}
                </button>
                <button type="submit" className="btn-primary">
                  {t(lang, "create_profile_submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      </main>
      <footer className="app-footer">
        <div className="app-footer-content">
          <div className="app-footer-section">
            <h4>{t(lang, "disclaimer_title")}</h4>
            <p className="muted">
              {t(lang, "disclaimer_line1")}
              <br />
              {t(lang, "disclaimer_line2")}
            </p>
          </div>
          <div className="app-footer-section">
            <h4>{t(lang, "footer_privacy_encryption_heading")}</h4>
            <p className="muted">
                            {t(lang, "encryption_local_only")}
            </p>
            <p className="muted">
              {t(lang, "encryption_key_hint")}
            </p>
          </div>
        </div>
      </footer>
      <div className="app-footer-bottom">
        <p>
          <a
            href="https://github.com/pandabytelabs/traeky"
            target="_blank"
            rel="noreferrer"
          >
            {t(lang, "footer_copyright_brand")}
          </a>
          <span> {t(lang, "footer_madewith")} </span>
          <a
            href="https://pandabyte.net"
            target="_blank"
            rel="noreferrer"
          >
            PANDABYTE
          </a>
        </p>
      </div>

    </div>
  );
};

export default App;