import React, { useEffect, useState } from "react";
import {createPortfolioDataSource, type PortfolioDataSource, computeLocalHoldings, computeLocalExpiring, overwriteLocalTransactions, saveLocalAppConfig} from "./data/dataSource";
import { useAuth } from "./auth/AuthContext";
import { t, Language, getDefaultLanguage } from "./i18n";
import { createPortfolioSnapshot, encryptSnapshotForCloud, decryptSnapshotFromCloud } from "./data/cloudSync";
import { CURRENT_CSV_SCHEMA_VERSION, CSV_SCHEMA_VERSION_COLUMN } from "./data/csvSchema";
import { Transaction, HoldingsItem, HoldingsResponse, CsvImportResult, AppConfig, ExpiringHolding } from "./domain/types";
import { DEFAULT_HOLDING_PERIOD_DAYS, DEFAULT_UPCOMING_WINDOW_DAYS } from "./domain/config";
import { applyPricesToHoldings, getPriceCacheSnapshot, hydratePriceCache, fetchHistoricalPriceForSymbol } from "./data/priceService";
import packageJson from "../package.json";

const RESET_CONFIRMATION_WORD = "DELETE";

const APP_VERSION = packageJson.version;
const LOCAL_STORAGE_LANG_KEY = "eigenfolio_lang";

const CLOUD_CONNECT_ENABLED = import.meta.env.DISABLE_CLOUD_CONNECT === "true" ? false : true;

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

function isTaxRelevant(tx: Transaction): boolean {
  const t = (tx.tx_type || "").trim().toUpperCase();
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

const App: React.FC = () => {
  const { auth, openAuthModal, logout, isAuthModalOpen, loginWithPasskey, closeAuthModal, cloudClient } = useAuth();
  const dataSource: PortfolioDataSource = React.useMemo(
    () => createPortfolioDataSource(auth.mode),
    [auth.mode]
  );
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
const [txFilterYear, setTxFilterYear] = useState<string>("");
const [txFilterAsset, setTxFilterAsset] = useState<string>("");
const [txFilterType, setTxFilterType] = useState<string>("");
  const [txSearch, setTxSearch] = useState<string>("");
  const [txPage, setTxPage] = useState(1);
  const [txPageSize, setTxPageSize] = useState(25);
  const filteredTransactions = React.useMemo(
    () => {
      const filtered = transactions.filter((tx) => {
        // Year filter
        if (txFilterYear) {
          const year = tx.timestamp ? tx.timestamp.slice(0, 4) : "";
          if (year !== txFilterYear) {
            return false;
          }
        }
        // Asset filter
        if (txFilterAsset) {
          const needle = txFilterAsset.trim().toUpperCase();
          if (needle && !tx.asset_symbol.toUpperCase().includes(needle)) {
            return false;
          }
        }
        // Type filter
        if (txFilterType) {
          if ((tx.tx_type || "").toUpperCase() !== txFilterType.toUpperCase()) {
            return false;
          }
        }
        // Free-text search over asset, type, source, note, tx_id
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

      return filtered.slice().sort((a, b) => {
        const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        const safeATime = Number.isFinite(aTime) ? aTime : 0;
        const safeBTime = Number.isFinite(bTime) ? bTime : 0;
        return safeBTime - safeATime;
      });
    },
    [transactions, txFilterYear, txFilterAsset, txFilterType, txSearch],
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
    useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_STORAGE_LANG_KEY, lang);
      }
    } catch {
      // ignore
    }
  }, [lang]);

const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const [resetConfirmationInput, setResetConfirmationInput] = useState("");
  const [pricesRefreshing, setPricesRefreshing] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [expiring, setExpiring] = useState<ExpiringHolding[]>([]);
  const [holdingPeriodInput, setHoldingPeriodInput] = useState<string>("");

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
  });

  const currentLocale = lang === "de" ? "de-DE" : "en-US";

  useEffect(() => {
    if (config) {
      setHoldingPeriodInput(String(config.holding_period_days));
    }
  }, [config]);


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

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.mode]);

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
    });
    setEditingId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  try {
    setError(null);

    const rawAmount = (form.amount ?? "").toString().trim();
    if (!rawAmount) {
      setError(
        lang === "de"
          ? "Bitte einen Betrag eingeben."
          : "Please enter an amount."
      );
      return;
    }

    const parsedAmount = parseFloat(rawAmount.replace(",", "."));
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError(
        lang === "de"
          ? "Bitte einen gültigen Betrag größer als 0 eingeben."
          : "Please enter a valid amount greater than 0."
      );
      return;
    }

    const upperSymbol = form.asset_symbol.trim().toUpperCase();
    const amount = parsedAmount;

    let priceFiat: number | null = null;
if (form.price_fiat) {
  // User explicitly provided a price.
  priceFiat = parseFloat(form.price_fiat);
} else {
  // First try to resolve a historical price based on the transaction timestamp.
  try {
    const hist = await fetchHistoricalPriceForSymbol(
      upperSymbol,
      form.fiat_currency as any,
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

  // If we still have no price, fall back to the current price cache as a
  // best-effort approximation.
  if (priceFiat == null) {
    const snapshot = getPriceCacheSnapshot();
    const cached = snapshot[upperSymbol];
    if (cached) {
      if (form.fiat_currency === "USD" && cached.usd != null) {
        priceFiat = cached.usd;
      } else if (cached.eur != null) {
        priceFiat = cached.eur;
      }
    }
  }
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
    };

    await dataSource.saveTransaction(payload);

    resetForm();
    await fetchData();
  } catch (err) {
    console.error(err);
    setError(t(lang, "error_save_tx"));
  }
};

  const handleDelete = async (txId: number) => {
  if (!window.confirm(lang === "de" ? "Transaktion wirklich löschen?" : "Really delete this transaction?")) {
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

const handleExportCsv = () => {
  if (!transactions || transactions.length === 0) {
    return;
  }

  const headers = [
    "asset_symbol",
    "tx_type",
    "amount",
    "timestamp",
    "price_fiat",
    "fiat_currency",
    "source",
    "note",
    "tx_id",
    CSV_SCHEMA_VERSION_COLUMN,
    "holding_period_days",
  ];

  const rows = transactions.map((tx) => [
    tx.asset_symbol ?? "",
    tx.tx_type ?? "",
    tx.amount != null ? String(tx.amount) : "",
    tx.timestamp ?? "",
    tx.price_fiat != null ? String(tx.price_fiat) : "",
    tx.fiat_currency ?? "",
    tx.source ?? "",
    tx.note ?? "",
    tx.tx_id ?? "",
    String(CURRENT_CSV_SCHEMA_VERSION),
    String(config?.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS),
  ]);

  const escapeCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
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
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `eigenfolio-transactions-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};
const handleSaveHoldingConfig = () => {
  if (!config) {
    return;
  }

  const raw = holdingPeriodInput.trim();
  if (!raw.length) {
    return;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    alert(t(lang, "holding_config_invalid"));
    return;
  }

  const nextConfig: AppConfig = {
    holding_period_days: parsed,
    upcoming_holding_window_days:
      config.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS,
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
    a.download = "crypto-transactions.pdf";
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
  if (pricesRefreshing) {
    return;
  }
  setPricesRefreshing(true);
  try {
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
    setFxRateUsdEur(updated.fx_rate_usd_eur ?? null);
  } catch (err) {
    console.error("Failed to reload holding prices", err);
  } finally {
    setPricesRefreshing(false);
  }
};

const handleDownloadEncryptedBackup = async () => {
  try {
    if (!config) {
      alert(t(lang, "cloud_backup_error_no_config"));
      return;
    }
    if (!transactions || transactions.length === 0) {
      alert(t(lang, "cloud_backup_error_no_transactions"));
      return;
    }

    const passphrase = window.prompt(t(lang, "cloud_backup_prompt_passphrase"));
    if (!passphrase) {
      return;
    }

    const assetPrices = getPriceCacheSnapshot();
    const snapshot = createPortfolioSnapshot(config, transactions, assetPrices);
    const encrypted = await encryptSnapshotForCloud(snapshot, passphrase);

    const blob = new Blob([JSON.stringify(encrypted, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `eigenfolio-cloud-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Failed to create encrypted cloud backup", err);
    alert(t(lang, "cloud_backup_error_failed"));
  }
};
const handleRestoreEncryptedBackup = async () => {
  try {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";

    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const payload = JSON.parse(text);

        const passphrase = window.prompt(t(lang, "cloud_backup_prompt_passphrase"));
        if (!passphrase) {
          return;
        }

        const snapshot = await decryptSnapshotFromCloud(payload, passphrase);

    // If the snapshot contains historical asset prices, hydrate the local
    // price cache so that we can reuse these prices without additional
    // external API calls.
    if (snapshot.assetPrices && Object.keys(snapshot.assetPrices).length > 0) {
      hydratePriceCache(snapshot.assetPrices);
    }

        if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.transactions)) {
          alert(t(lang, "cloud_backup_error_invalid_file"));
          return;
        }

        const rawConfig = snapshot.config ?? {};
        const safeConfig: AppConfig = {
          holding_period_days:
            typeof rawConfig.holding_period_days === "number" &&
            Number.isFinite(rawConfig.holding_period_days) &&
            rawConfig.holding_period_days >= 0
              ? rawConfig.holding_period_days
              : DEFAULT_HOLDING_PERIOD_DAYS,
          upcoming_holding_window_days:
            typeof rawConfig.upcoming_holding_window_days === "number" &&
            Number.isFinite(rawConfig.upcoming_holding_window_days) &&
            rawConfig.upcoming_holding_window_days > 0
              ? rawConfig.upcoming_holding_window_days
              : DEFAULT_UPCOMING_WINDOW_DAYS,
        };

        const normalized: Transaction[] = snapshot.transactions
          .map((tx, index) => {
            const amount = Number((tx as Transaction).amount ?? 0);
            const ts = (tx as Transaction).timestamp;
            if (!ts || !Number.isFinite(amount) || amount === 0) {
              return null;
            }
            const id =
              typeof (tx as Transaction).id === "number" &&
              Number.isFinite((tx as Transaction).id) &&
              (tx as Transaction).id > 0
                ? (tx as Transaction).id
                : index + 1;

            return {
              id,
              asset_symbol: (tx as Transaction).asset_symbol || "UNKNOWN",
              tx_type: (tx as Transaction).tx_type || "BUY",
              amount,
              price_fiat:
                (tx as Transaction).price_fiat !== undefined
                  ? (tx as Transaction).price_fiat
                  : null,
              fiat_currency: (tx as Transaction).fiat_currency || "EUR",
              timestamp: ts,
              source:
                (tx as Transaction).source !== undefined
                  ? (tx as Transaction).source
                  : null,
              note:
                (tx as Transaction).note !== undefined ? (tx as Transaction).note : null,
              tx_id:
                (tx as Transaction).tx_id !== undefined ? (tx as Transaction).tx_id : null,
              fiat_value:
                (tx as Transaction).fiat_value !== undefined
                  ? (tx as Transaction).fiat_value
                  : null,
              value_eur:
                (tx as Transaction).value_eur !== undefined
                  ? (tx as Transaction).value_eur
                  : null,
              value_usd:
                (tx as Transaction).value_usd !== undefined
                  ? (tx as Transaction).value_usd
                  : null,
            };
          })
          .filter((tx): tx is Transaction => tx !== null);

        if (!normalized.length) {
          alert(t(lang, "cloud_backup_error_no_transactions"));
          return;
        }

        let holdings = computeLocalHoldings(normalized);
        try {
          holdings = await applyPricesToHoldings(holdings);
        } catch (priceErr) {
          console.warn("Failed to enrich holdings with prices for restored backup", priceErr);
        }

        const expiring = computeLocalExpiring(normalized, safeConfig);

        // Persist restored transactions to local storage so that the data
        // survives a page reload even before any cloud backend exists.
        overwriteLocalTransactions(normalized);

        setConfig(safeConfig);
        setTransactions(normalized);
        setHoldings(holdings.items ?? []);
        setHoldingsPortfolioEur(holdings.portfolio_value_eur ?? null);
        setHoldingsPortfolioUsd(holdings.portfolio_value_usd ?? null);
        setFxRateEurUsd(holdings.fx_rate_eur_usd ?? null);
        setExpiring(expiring);
        setError(null);
      } catch (err) {
        console.error("Failed to restore encrypted cloud backup", err);
        alert(t(lang, "cloud_backup_error_decrypt_failed"));
      } finally {
        fileInput.value = "";
      }
    };

    fileInput.click();
  } catch (err) {
    console.error("Failed to open encrypted backup file picker", err);
  }
};
  const handleCloudSyncPush = async () => {
    if (!auth.isAuthenticated || !cloudClient) {
      alert(t(lang, "cloud_sync_not_available_standalone"));
      return;
    }
    try {
      if (!config) {
        alert(t(lang, "cloud_backup_error_no_config"));
        return;
      }
      if (!transactions || transactions.length === 0) {
        alert(t(lang, "cloud_backup_error_no_transactions"));
        return;
      }

      const passphrase = window.prompt(t(lang, "cloud_sync_passphrase_prompt"));
      if (!passphrase) {
        return;
      }

      const assetPrices = getPriceCacheSnapshot();
      const snapshot = createPortfolioSnapshot(config, transactions, assetPrices);
      const encrypted = await encryptSnapshotForCloud(snapshot, passphrase);

      await cloudClient.uploadEncryptedSnapshot(encrypted);

      alert(t(lang, "cloud_sync_push_success_placeholder"));
    } catch (err) {
      console.error("Cloud sync push failed", err);
      alert(t(lang, "cloud_sync_push_error_placeholder"));
    }
  };

  const handleCloudSyncPull = async () => {
    if (!auth.isAuthenticated || !cloudClient) {
      alert(t(lang, "cloud_sync_not_available_standalone"));
      return;
    }
    try {
      const payload = await cloudClient.downloadLatestEncryptedSnapshot();
      if (!payload) {
        alert(t(lang, "cloud_sync_no_snapshot_placeholder"));
        return;
      }

      const passphrase = window.prompt(t(lang, "cloud_sync_passphrase_prompt"));
      if (!passphrase) {
        return;
      }

      const snapshot = await decryptSnapshotFromCloud(payload, passphrase);

      if (snapshot.assetPrices && Object.keys(snapshot.assetPrices).length > 0) {
        hydratePriceCache(snapshot.assetPrices);
      }

      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.transactions)) {
        alert(t(lang, "cloud_backup_error_invalid_file"));
        return;
      }

      const rawConfig = snapshot.config ?? {};
      const safeConfig: AppConfig = {
        holding_period_days:
          typeof rawConfig.holding_period_days === "number" &&
          Number.isFinite(rawConfig.holding_period_days) &&
          rawConfig.holding_period_days >= 0
            ? rawConfig.holding_period_days
            : DEFAULT_HOLDING_PERIOD_DAYS,
        upcoming_holding_window_days:
          typeof rawConfig.upcoming_holding_window_days === "number" &&
          Number.isFinite(rawConfig.upcoming_holding_window_days) &&
          rawConfig.upcoming_holding_window_days > 0
            ? rawConfig.upcoming_holding_window_days
            : DEFAULT_UPCOMING_WINDOW_DAYS,
      };

      const normalized: Transaction[] = snapshot.transactions
        .map((tx, index) => {
          const amount = typeof tx.amount === "number" && Number.isFinite(tx.amount) ? tx.amount : 0;
          const timestamp = typeof tx.timestamp === "string" ? tx.timestamp : "";
          if (!timestamp || amount === 0) {
            return null;
          }

          return {
            id: index + 1,
            asset_symbol: typeof tx.asset_symbol === "string" && tx.asset_symbol
              ? tx.asset_symbol.toUpperCase()
              : "UNKNOWN",
            tx_type: typeof tx.tx_type === "string" && tx.tx_type
              ? tx.tx_type.toUpperCase()
              : "BUY",
            amount,
            price_fiat:
              typeof tx.price_fiat === "number" && Number.isFinite(tx.price_fiat)
                ? tx.price_fiat
                : null,
            fiat_currency: typeof tx.fiat_currency === "string" && tx.fiat_currency
              ? tx.fiat_currency
              : "EUR",
            timestamp,
            source: typeof tx.source === "string" && tx.source ? tx.source : null,
            note: typeof tx.note === "string" && tx.note ? tx.note : null,
            tx_id: typeof tx.tx_id === "string" && tx.tx_id ? tx.tx_id : null,
            fiat_value:
              typeof (tx as any).fiat_value === "number" &&
              Number.isFinite((tx as any).fiat_value)
                ? (tx as any).fiat_value
                : null,
            value_eur:
              typeof (tx as any).value_eur === "number" &&
              Number.isFinite((tx as any).value_eur)
                ? (tx as any).value_eur
                : null,
            value_usd:
              typeof (tx as any).value_usd === "number" &&
              Number.isFinite((tx as any).value_usd)
                ? (tx as any).value_usd
                : null,
          };
        })
        .filter((tx): tx is Transaction => tx !== null);

      if (normalized.length === 0) {
        alert(t(lang, "cloud_backup_error_no_transactions"));
        return;
      }

      const holdingsSnapshot = computeLocalHoldings(normalized);
      let holdings = holdingsSnapshot;
      try {
        holdings = await applyPricesToHoldings(holdingsSnapshot);
      } catch (priceErr) {
        console.warn("Failed to enrich holdings with prices for cloud pull", priceErr);
      }

      const expiring = computeLocalExpiring(normalized, safeConfig);

      overwriteLocalTransactions(normalized);
      setConfig(safeConfig);
      setTransactions(normalized);
      setHoldings(holdings.items ?? []);
      setHoldingsPortfolioEur(holdings.portfolio_value_eur ?? null);
      setHoldingsPortfolioUsd(holdings.portfolio_value_usd ?? null);
      setFxRateEurUsd(holdings.fx_rate_eur_usd ?? null);
      setExpiring(expiring);
      setError(null);

      alert(t(lang, "cloud_sync_pull_success_placeholder"));
    } catch (err) {
      console.error("Cloud sync pull failed", err);
      alert(t(lang, "cloud_sync_pull_error_placeholder"));
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

  const holdingsValueHeader =
    lang === "de"
      ? t(lang, "holdings_col_value_eur")
      : t(lang, "holdings_col_value_usd");

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <h1 className="logo">
            {t(lang, "app_title")}
            <span className="logo-version">v{APP_VERSION}</span>
          </h1>
          <p className="sidebar-sub">{t(lang, "app_subtitle")}</p>
          </div>
          <div className="lang-switch form-row">
          <label>{lang === "de" ? "Sprache" : "Language"}</label>
          <select
            className="lang-select"
            value={lang}
            onChange={(e) => setLang(e.target.value as Language)}
            aria-label={lang === "de" ? "Sprache auswählen" : "Select language"}
          >
            <option value="en">🇬🇧 English</option>
            <option value="de">🇩🇪 Deutsch</option>
          </select>
        </div>
        </div>

        <div className="sidebar-section">
          <h2>{t(lang, "tips_title")}</h2>
          <ul>
            <li>{t(lang, "tips_line1")}</li>
            <li>{t(lang, "tips_line2")}</li>
            <li>{t(lang, "tips_line3")}</li>
            <li>
              {t(lang, "tips_line4_prefix")} <b>{holdingDays}</b>{" "}
              {t(lang, "tips_line4_suffix")}{" "}</li>
          </ul>
        </div>

        <div className="sidebar-section">
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
            <label>CSV</label>
            <div className="file-input-wrapper">
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvChange}
                disabled={csvImporting}
              />
              <span className="file-name">
                {csvFileName || t(lang, "csv_no_file")}
              </span>
            </div>
          </div>
          {csvImporting && <p className="muted">{t(lang, "csv_running")}</p>}
          {csvResult && (
            <div className="csv-result">
              <p className="muted">
                {t(lang, "csv_result_prefix")}: {csvResult.imported}
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

          <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn-secondary export-button"
              onClick={handleExportCsv}
              disabled={transactions.length === 0}
            >
              {t(lang, "csv_export_button")}
            </button>
            <button
              type="button"
              className="btn-secondary export-button"
              onClick={handleExportPdf}
            >
              {t(lang, "action_export_pdf")}
            </button>
          </div>
        </div>

        
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
          <div style={{ marginTop: "0.5rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleResetHoldingConfigToDefault}
            >
              {t(lang, "holding_config_reset_button")}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSaveHoldingConfig}
              disabled={!holdingPeriodInput.length || !config}
            >
              {t(lang, "holding_config_save_button")}
            </button>
          </div>
        </div>

<div className="sidebar-section">
          <h2>{t(lang, "encryption_section_title")}</h2>
          <p className="muted">
            {auth.mode === "local-only"
              ? t(lang, "encryption_local_only")
              : t(lang, "encryption_cloud_demo")}
          </p>
          <p className="muted">
            {t(lang, "encryption_key_hint")}
          </p>
        </div>
        {auth.mode === "cloud" && (
          <div className="sidebar-section">
            <h2>{t(lang, "cloud_backup_section_title")}</h2>
            <p className="muted">{t(lang, "cloud_backup_section_info")}</p>
            <p className="muted">{t(lang, "cloud_backup_prices_info")}</p>
            <div className="sidebar-actions-vertical">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleDownloadEncryptedBackup}
              >
                {t(lang, "cloud_backup_export_button")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleRestoreEncryptedBackup}
              >
                {t(lang, "cloud_backup_import_button")}
              </button>
            </div>

                    <p className="muted">
              {t(lang, "cloud_backup_import_info")}
            </p>
            <div className="sidebar-subsection" style={{ marginTop: "1rem" }}>
              <h3 className="sidebar-subtitle">
                {t(lang, "cloud_sync_preview_title")}
              </h3>
              <p className="muted">
                {t(lang, "cloud_sync_preview_info")}
              </p>
              <div className="sidebar-actions-vertical">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleCloudSyncPush}
                  disabled={!cloudClient}
                >
                  {t(lang, "cloud_sync_push_button")}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleCloudSyncPull}
                  disabled={!cloudClient}
                >
                  {t(lang, "cloud_sync_pull_button")}
                </button>
              </div>
              {!cloudClient && (
                <p className="muted">
                  {t(lang, "cloud_sync_client_missing_info")}
                </p>
              )}
            </div>
          </div>
        )}
        {auth.mode === "local-only" && (
          <>
            <div className="sidebar-section">
              <h2>{t(lang, "local_mode_title")}</h2>
              <p className="muted">{t(lang, "local_mode_notice")}</p>
            </div>

            <div className="sidebar-section">
              <h2>{t(lang, "reset_local_title")}</h2>
              <p className="muted">{t(lang, "reset_local_description")}</p>
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
                      onClick={() => {
                        try {
                          window.localStorage.clear();
                        } catch (err) {
                          console.error("Failed to clear localStorage", err);
                        }
                        window.location.reload();
                      }}
                    >
                      {t(lang, "reset_local_confirm_button")}
                    </button>
                  </div>
                </div>
              ) : (
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
              )}
            </div>
          </>
        )}

<div className="sidebar-footer">
  <p>
    <span>{t(lang, "footer_copyright_prefix")} </span>
    <a
      href="https://github.com/pandabytelabs/eigenfolio"
      target="_blank"
      rel="noreferrer"
    >
      {t(lang, "footer_copyright_brand")}
    </a>
  </p>
</div>
</aside>

      
        {CLOUD_CONNECT_ENABLED && isAuthModalOpen && (
          <div className="modal-backdrop">
            <div className="modal">
              <h2>{t(lang, "login_title")}</h2>
              <p>{t(lang, "login_description")}</p>
              <p className="muted">{t(lang, "login_encryption_notice")}</p>
              <p className="muted">{t(lang, "login_2fa_hint")}</p>
              <div style={{ marginTop: "1rem" }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={loginWithPasskey}
                >
                  {t(lang, "login_passkey_cta")}
                </button>
              </div>
              <div style={{ marginTop: "1rem" }}>
                <label className="form-label">
                  {t(lang, "login_2fa_label")}
                  <input
                    type="text"
                    className="input"
                    placeholder={t(lang, "login_2fa_placeholder")}
                    disabled
                  />
                </label>
              </div>
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
<main className="main">
        <header className="header">
          <div>
            <h2>{t(lang, "header_portfolio")}</h2>
            <p className="header-mode-explainer">
              {auth.isAuthenticated
                ? t(lang, "header_mode_explainer_cloud")
                : t(lang, "header_mode_explainer_local")}
            </p>
          </div>
          <div className="header-right">
            <span
              className="pill pill-small"
              title={
                auth.isAuthenticated
                  ? t(lang, "header_mode_pill_cloud_hint")
                  : t(lang, "header_mode_pill_local_hint")
              }
            >
              {auth.isAuthenticated
                ? t(lang, "login_status_cloud")
                : t(lang, "login_status_local")}
            </span>
            {auth.isAuthenticated ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={logout}
              >
                {t(lang, "header_logout_button")}
              </button>
            ) : CLOUD_CONNECT_ENABLED ? (
              <button
                type="button"
                className="btn-primary"
                onClick={openAuthModal}
              >
                {t(lang, "header_login_button")}
              </button>
            ) : null}
          </div>
        </header>

        <section className="cards">
          <div className="card">
            <h3>{t(lang, "holdings_title")}</h3>
            {holdings.length === 0 ? (
              <p className="muted">{t(lang, "holdings_empty")}</p>
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t(lang, "holdings_col_asset")}</th>
                      <th>{t(lang, "holdings_col_amount")}</th>
                      <th>{holdingsValueHeader}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h, index) => {
                      const primaryRaw =
                        lang === "de" ? h.value_eur ?? null : h.value_usd ?? null;
                      const secondaryRaw =
                        lang === "de" ? h.value_usd ?? null : h.value_eur ?? null;

                      const primarySymbol = lang === "de" ? "€" : "$";
                      const secondarySymbol = lang === "de" ? "$" : "€";

                      let valueDisplay: string | null = null;
                      if (primaryRaw != null) {
                        valueDisplay = `${primaryRaw.toLocaleString(currentLocale, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 3,
                        })} ${primarySymbol}`;
                        if (secondaryRaw != null) {
                          valueDisplay += ` (${secondaryRaw.toLocaleString(currentLocale, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 3,
                          })} ${secondarySymbol})`;
                        }
                      }

                      return (
                        <tr key={`${h.asset_symbol}-${index}`}>
                          <td>{h.asset_symbol}</td>
                          <td>
                            {h.total_amount.toLocaleString(currentLocale, {
                              maximumFractionDigits: 8,
                            })}
                          </td>
                          <td>
                            {valueDisplay ? (
                              valueDisplay
                            ) : (
                              <button
                                type="button"
                                className="btn-link"
                                disabled={pricesRefreshing}
                                onClick={handleReloadHoldingPrices}
                              >
                                {pricesRefreshing
                                  ? t(lang, "holdings_price_loading")
                                  : t(lang, "holdings_price_reload")}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                  <strong>{t(lang, "holdings_portfolio_value")}:</strong>{" "}
                  {(() => {
                    const hasEur =
                      portfolioEur != null &&
                      Math.abs(portfolioEur) > 0.000001;
                    const hasUsd =
                      portfolioUsd != null &&
                      Math.abs(portfolioUsd) > 0.000001;

                    if (lang === "de") {
                      if (hasEur) {
                        return (
                          <>
                            {portfolioEur!.toLocaleString(currentLocale, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 3,
                            })}{" "}
                            €
                            {hasUsd && (
                              <>
                                {" "}
                                (
                                {portfolioUsd!.toLocaleString(currentLocale, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 3,
                                })}{" "}
                                $)
                              </>
                            )}
                          </>
                        );
                      }
                      if (hasUsd) {
                        return (
                          <>
                            {portfolioUsd!.toLocaleString(currentLocale, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 3,
                            })}{" "}
                            $
                          </>
                        );
                      }
                      return "-";
                    } else {
                      if (hasUsd) {
                        return (
                          <>
                            {portfolioUsd!.toLocaleString(currentLocale, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 3,
                            })}{" "}
                            $
                            {hasEur && (
                              <>
                                {" "}
                                (
                                {portfolioEur!.toLocaleString(currentLocale, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 3,
                                })}{" "}
                                €)
                              </>
                            )}
                          </>
                        );
                      }
                      if (hasEur) {
                        return (
                          <>
                            {portfolioEur!.toLocaleString(currentLocale, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 3,
                            })}{" "}
                            €
                          </>
                        );
                      }
                      return "-";
                    }
                  })()}
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h3>
              {editingId ? t(lang, "form_title_edit") : t(lang, "form_title_new")}
            </h3>
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
                  <option value="TRANSFER_IN">TRANSFER_IN</option>
                  <option value="TRANSFER_OUT">TRANSFER_OUT</option>
                  <option value="STAKING_REWARD">STAKING_REWARD</option>
                  <option value="AIRDROP">AIRDROP</option>
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
                <label>{t(lang, "form_fiat_currency")}</label>
                <input
                  name="fiat_currency"
                  value={form.fiat_currency}
                  onChange={handleChange}
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
                    {t(lang, "form_cancel")}
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>

        <section className="card">
          <h3>{t(lang, "table_tx_title")}</h3>
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
              <option value="TRANSFER_IN">TRANSFER_IN</option>
              <option value="TRANSFER_OUT">TRANSFER_OUT</option>
              <option value="STAKING_REWARD">STAKING_REWARD</option>
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

        {filteredTransactions.length === 0 ? (
            <p className="muted">{t(lang, "table_tx_empty")}</p>
          ) : (
            <>
            <table className="table table-striped">
              <thead>
                <tr>
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
                      <td>{dateTimeFormatter.format(new Date(tx.timestamp))}</td>
                      <td>{tx.asset_symbol}</td>
                      <td>{tx.tx_type}</td>
                      <td>{tx.amount}</td>
                      <td>
                        {tx.price_fiat != null
                          ? `${tx.price_fiat.toLocaleString(currentLocale, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 3,
                            })} ${tx.fiat_currency}`
                          : "-"}
                      </td>
                      <td>
                        {tx.fiat_value != null
                          ? `${tx.fiat_value.toLocaleString(currentLocale, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 3,
                            })} ${tx.fiat_currency}`
                          : "-"}
                      </td>
                      <td>{tx.tx_id || "-"}</td>
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
                            {t(lang, "holding_until_prefix")}{" "}
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
                            });
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
                {lang === "de" ? "Tage" : "days"}
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
                          });
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

      </main>
    </div>
  );
};

export default App;
