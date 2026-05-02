const APP_VERSION = "2.1.0";
const LOCAL_VAULT_KEY = "traeky:v2:vault";
const CSV_SCHEMA_VERSION = 5;
const PBKDF2_ITERATIONS = 600000;
const DEVICE_ID_KEY = "traeky:v2:device-id";
const COLOR_SET = ["#69b7ff", "#d7ff72", "#70e59c", "#ffca69", "#ff6b7a", "#b692ff", "#67e8f9", "#f0abfc"];

const ASSET_META = {
  BTC: { name: "Bitcoin", coingecko: "bitcoin" },
  ETH: { name: "Ethereum", coingecko: "ethereum" },
  BNB: { name: "BNB", coingecko: "binancecoin" },
  SOL: { name: "Solana", coingecko: "solana" },
  ADA: { name: "Cardano", coingecko: "cardano" },
  XRP: { name: "XRP", coingecko: "ripple" },
  DOT: { name: "Polkadot", coingecko: "polkadot" },
  MATIC: { name: "Polygon", coingecko: "matic-network" },
  LINK: { name: "Chainlink", coingecko: "chainlink" },
  LTC: { name: "Litecoin", coingecko: "litecoin" },
  DOGE: { name: "Dogecoin", coingecko: "dogecoin" },
  AVAX: { name: "Avalanche", coingecko: "avalanche-2" },
  USDT: { name: "Tether", coingecko: "tether" },
  USDC: { name: "USD Coin", coingecko: "usd-coin" },
  EUR: { name: "Euro" },
  USD: { name: "US Dollar" }
};

const TX_TYPES = [
  ["BUY", "Kauf"],
  ["SELL", "Verkauf"],
  ["AIRDROP", "Airdrop"],
  ["STAKING_REWARD", "Staking Reward"],
  ["TRANSFER_IN", "Transfer rein"],
  ["TRANSFER_OUT", "Transfer raus"],
  ["TRANSFER_INTERNAL", "Interner Transfer"]
];

let session = {
  unlocked: false,
  passphrase: "",
  envelope: null,
  data: null,
  lastRemoteRevision: null,
  filter: { query: "", asset: "", type: "" },
  route: "overview"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function fmtMoney(value, currency = "EUR") {
  const n = Number(value || 0);
  return new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function fmtNum(value, digits = 8) {
  const n = Number(value || 0);
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: digits }).format(n);
}

function fmtDate(value) {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function nowISO() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function defaultData(name = "Default") {
  return {
    schema_version: 2,
    app_version: APP_VERSION,
    created_at: nowISO(),
    updated_at: nowISO(),
    profile: { id: uuid(), name },
    config: {
      holding_period_days: 365,
      upcoming_holding_window_days: 30,
      base_currency: "EUR",
      price_fetch_enabled: true,
      coingecko_api_key: "",
      cloud_url: "",
      cloud_key: randomCloudKey(),
      cloud_auth_secret: randomCloudAuthSecret(),
      last_sync_at: "",
      last_remote_revision: 0,
      last_remote_auth_secret: ""
    },
    prices: {},
    transactions: [],
    next_transaction_id: 1,
    audit: []
  };
}

function normalizeData(input, fallbackName = "Default") {
  const base = defaultData(fallbackName);
  const d = input && typeof input === "object" ? input : {};
  const config = { ...base.config, ...(d.config || {}) };
  if (!config.cloud_key && config.cloud_vault_id) config.cloud_key = String(config.cloud_vault_id);
  if (config.cloud_auth_secret == null) config.cloud_auth_secret = randomCloudAuthSecret();
  if (config.last_remote_auth_secret == null) config.last_remote_auth_secret = "";
  delete config.cloud_vault_id;
  delete config.cloud_token;
  const transactions = Array.isArray(d.transactions) ? d.transactions.map(normalizeTx).filter(Boolean) : [];
  const maxID = transactions.reduce((m, tx) => Math.max(m, Number(tx.id) || 0), 0);
  return {
    ...base,
    ...d,
    schema_version: 2,
    app_version: APP_VERSION,
    profile: { ...base.profile, ...(d.profile || {}), name: d.profile?.name || fallbackName },
    config,
    prices: d.prices && typeof d.prices === "object" ? d.prices : {},
    transactions,
    next_transaction_id: Math.max(Number(d.next_transaction_id) || 1, maxID + 1),
    audit: Array.isArray(d.audit) ? d.audit.slice(-100) : []
  };
}

function normalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  const symbol = String(tx.asset_symbol || tx.asset || "").trim().toUpperCase();
  const amount = Number(tx.amount);
  if (!symbol || !Number.isFinite(amount)) return null;
  const timestamp = tx.timestamp ? new Date(tx.timestamp).toISOString() : nowISO();
  return {
    id: Number(tx.id) || 0,
    asset_symbol: symbol,
    tx_type: String(tx.tx_type || tx.type || "BUY").trim().toUpperCase(),
    amount,
    price_fiat: tx.price_fiat === "" || tx.price_fiat == null ? null : Number(tx.price_fiat),
    fiat_currency: String(tx.fiat_currency || tx.currency || "EUR").trim().toUpperCase(),
    timestamp,
    source: tx.source ? String(tx.source) : "",
    note: tx.note ? String(tx.note) : "",
    tx_id: tx.tx_id ? String(tx.tx_id) : "",
    linked_tx_prev_id: tx.linked_tx_prev_id ? Number(tx.linked_tx_prev_id) : null,
    linked_tx_next_id: tx.linked_tx_next_id ? Number(tx.linked_tx_next_id) : null
  };
}

function randomID(bytes = 16) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes))).replace(/-/g, "").replace(/_/g, "").slice(0, Math.max(8, bytes * 2));
}

function randomCloudKey() { return `vault_${randomID(24)}`; }
function randomCloudAuthSecret() { return `auth_${randomID(32)}`; }

function b64url(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function base64ToBytes(value) {
  const bin = atob(value || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptVault(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...data, updated_at: nowISO(), app_version: APP_VERSION }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return {
    format: "traeky-vault",
    version: 2,
    algorithm: "AES-GCM",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    created_at: data.created_at || nowISO(),
    sealed_at: nowISO()
  };
}

async function decryptVault(envelope, passphrase) {
  if (!envelope || typeof envelope !== "object") throw new Error("Kein gültiger Vault.");
  if (envelope.format === "traeky-vault" && Number(envelope.version) === 2) {
    const salt = base64ToBytes(envelope.kdf?.salt);
    const key = await deriveKey(passphrase, salt, Number(envelope.kdf?.iterations) || PBKDF2_ITERATIONS);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
    return normalizeData(JSON.parse(new TextDecoder().decode(plaintext)));
  }
  if (Number(envelope.version) === 1 && envelope.algorithm === "AES-GCM") {
    return decryptLegacyPayload(envelope, passphrase);
  }
  throw new Error("Unbekanntes Vault-Format.");
}

async function decryptLegacyPayload(encrypted, passphrase) {
  const salt = base64ToBytes(encrypted.salt);
  const iv = base64ToBytes(encrypted.iv);
  const key = await deriveKey(passphrase, salt, 600000);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(encrypted.ciphertext));
  const legacy = JSON.parse(new TextDecoder().decode(plaintext));
  const migrated = normalizeData({
    profile: { name: "Migriertes Traeky-Profil" },
    config: legacy.config,
    transactions: legacy.transactions,
    next_transaction_id: legacy.nextTransactionId || legacy.next_transaction_id
  }, "Migriertes Traeky-Profil");
  addAudit(migrated, "Legacy-Profil lokal migriert");
  return migrated;
}

function validatePassphrase(value) {
  if (!value || value.length < 12) return "Die Passphrase muss mindestens 12 Zeichen lang sein.";
  const low = value.trim().toLowerCase();
  if (/^\d+$/.test(low) || /^(.)\1+$/.test(low) || ["password", "passwort", "qwertzuiop", "qwertyuiop", "letmein"].includes(low)) {
    return "Bitte eine stärkere Passphrase verwenden.";
  }
  return "";
}

function addAudit(data, message) {
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.audit.push({ at: nowISO(), message });
  data.audit = data.audit.slice(-100);
}

async function persist(message = "Änderung gespeichert") {
  if (!session.unlocked) return;
  session.data.updated_at = nowISO();
  addAudit(session.data, message);
  const envelope = await encryptVault(session.data, session.passphrase);
  localStorage.setItem(LOCAL_VAULT_KEY, JSON.stringify(envelope));
  session.envelope = envelope;
  render();
}

function loadLocalEnvelope() {
  try {
    const raw = localStorage.getItem(LOCAL_VAULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function detectLegacy() {
  const oldProfilesRaw = localStorage.getItem("traeky:profiles:index");
  let oldProfiles = [];
  try {
    const idx = oldProfilesRaw ? JSON.parse(oldProfilesRaw) : null;
    if (idx && Array.isArray(idx.profiles)) oldProfiles = idx.profiles;
  } catch {}
  const loose = Boolean(localStorage.getItem("traeky:transactions") || localStorage.getItem("traeky:app-config") || localStorage.getItem("traeky:next-tx-id"));
  return { hasLegacy: oldProfiles.length > 0 || loose, oldProfiles, loose };
}

function render() {
  const app = $("#app");
  if (!session.unlocked) {
    app.innerHTML = renderAuth();
    bindAuth();
    return;
  }
  app.innerHTML = renderDashboard();
  bindDashboard();
  requestAnimationFrame(drawCharts);
}

function renderAuth() {
  const hasVault = !!loadLocalEnvelope();
  const legacy = detectLegacy();
  const oldProfileOptions = legacy.oldProfiles.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name || p.id)}</option>`).join("");
  return `
    <main class="auth-layout">
      <section class="hero-card">
        <div class="brand"><img src="/icon.svg" alt=""/> Traeky</div>
        <div class="hero-copy">
          <div class="eyebrow">Local-first · E2E Sync · Self-hosted Cloud</div>
          <h1>Portfolio sicher tracken, ohne Daten preiszugeben.</h1>
          <p>Die neue Oberfläche läuft weiterhin vollständig im Browser. Transaktionen, Profile und Cloud-Backups werden clientseitig verschlüsselt. Der Cloud-Dienst speichert nur Ciphertext und besitzt keinen Masterkey.</p>
          <div class="feature-grid">
            <div class="feature-pill">AES-GCM Vault<span>Passphrase bleibt lokal</span></div>
            <div class="feature-pill">CSV & Migration<span>Altbestand übernehmen</span></div>
            <div class="feature-pill">Self-hosted Sync<span>Go-Binary oder Docker</span></div>
          </div>
        </div>
        <p class="smallprint">Sicherheitsmodell: Ohne starke Passphrase kann niemand den Vault entschlüsseln. Bewahre die Passphrase separat auf; sie kann nicht serverseitig wiederhergestellt werden.</p>
      </section>
      <section class="auth-card">
        <div class="tabs">
          <button class="tab-btn ${hasVault ? "active" : ""}" data-auth-tab="unlock">Entsperren</button>
          <button class="tab-btn ${!hasVault ? "active" : ""}" data-auth-tab="setup">Neu erstellen</button>
          <button class="tab-btn" data-auth-tab="legacy">Migration</button>
        </div>
        <div id="auth-unlock" class="auth-pane ${hasVault ? "" : "hidden"}">
          <h2>Vault entsperren</h2>
          <p>Gib deine lokale Passphrase ein. Sie verlässt diesen Browser nicht.</p>
          <form id="unlock-form" class="form-grid">
            <div class="form-row"><label>Passphrase</label><input type="password" name="passphrase" autocomplete="current-password" required /></div>
            <button class="btn" type="submit">Entsperren</button>
            <div id="unlock-msg"></div>
          </form>
        </div>
        <div id="auth-setup" class="auth-pane ${hasVault ? "hidden" : ""}">
          <h2>Neuen Vault erstellen</h2>
          <p>Der Vault wird verschlüsselt in localStorage gespeichert. Optional kannst du danach einen Cloud-Endpunkt konfigurieren.</p>
          <form id="setup-form" class="form-grid">
            <div class="form-row"><label>Profilname</label><input name="name" value="Default" maxlength="80" required /></div>
            <div class="form-row"><label>Passphrase</label><input type="password" name="passphrase" autocomplete="new-password" minlength="12" required /></div>
            <div class="form-row"><label>Passphrase wiederholen</label><input type="password" name="confirm" autocomplete="new-password" minlength="12" required /></div>
            ${legacy.loose ? `<label><input type="checkbox" name="migrateLoose" checked /> Alte unverschlüsselte Traeky-Daten automatisch übernehmen</label>` : ""}
            <button class="btn" type="submit">Sicheren Vault anlegen</button>
            <div id="setup-msg"></div>
          </form>
        </div>
        <div id="auth-legacy" class="auth-pane hidden">
          <h2>Altes Traeky migrieren</h2>
          ${legacy.hasLegacy ? `<p>Es wurden alte Traeky-Daten in diesem Browser gefunden. Verschlüsselte Profile können mit der bisherigen Passphrase migriert werden; CSV-Dateien kannst du später im Dashboard importieren.</p>` : `<p>Keine alten Browserdaten gefunden. Du kannst später CSV-Dateien im Dashboard importieren.</p>`}
          <form id="legacy-form" class="form-grid">
            <div class="form-row"><label>Altes Profil</label><select name="profileId" ${oldProfileOptions ? "" : "disabled"}>${oldProfileOptions || `<option>Kein altes Profil gefunden</option>`}</select></div>
            <div class="form-row"><label>Bisherige Passphrase</label><input type="password" name="oldPassphrase" ${oldProfileOptions ? "required" : "disabled"}/></div>
            <div class="form-row"><label>Neue Passphrase</label><input type="password" name="newPassphrase" minlength="12" ${oldProfileOptions ? "required" : "disabled"}/></div>
            <button class="btn" type="submit" ${oldProfileOptions ? "" : "disabled"}>Migrieren und neuen Vault erstellen</button>
            <div id="legacy-msg"></div>
          </form>
        </div>
      </section>
    </main>`;
}

function bindAuth() {
  $$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.auth-pane').forEach(p => p.classList.add('hidden'));
    $(`#auth-${btn.dataset.authTab}`).classList.remove('hidden');
  }));

  $('#unlock-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#unlock-msg');
    msg.innerHTML = `<div class="notice info">Entschlüssele lokal …</div>`;
    try {
      const passphrase = new FormData(e.currentTarget).get('passphrase');
      const data = await decryptVault(loadLocalEnvelope(), String(passphrase));
      session = { ...session, unlocked: true, passphrase: String(passphrase), data, envelope: loadLocalEnvelope(), lastRemoteRevision: Number(data.config.last_remote_revision || 0), route: 'overview' };
      render();
    } catch (err) {
      msg.innerHTML = `<div class="notice danger">Entsperren fehlgeschlagen: ${escapeHTML(err.message || err)}</div>`;
    }
  });

  $('#setup-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const passphrase = String(fd.get('passphrase') || '');
    const confirm = String(fd.get('confirm') || '');
    const err = validatePassphrase(passphrase) || (passphrase !== confirm ? 'Passphrasen stimmen nicht überein.' : '');
    if (err) { $('#setup-msg').innerHTML = `<div class="notice danger">${escapeHTML(err)}</div>`; return; }
    let data = defaultData(String(fd.get('name') || 'Default'));
    if (fd.get('migrateLoose')) data = migrateLooseLegacy(data);
    session = { ...session, unlocked: true, passphrase, data, route: 'overview' };
    await persist('Vault erstellt');
  });

  $('#legacy-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const msg = $('#legacy-msg');
    msg.innerHTML = `<div class="notice info">Migriere altes Profil …</div>`;
    try {
      const newPass = String(fd.get('newPassphrase') || '');
      const err = validatePassphrase(newPass);
      if (err) throw new Error(err);
      const profileID = String(fd.get('profileId'));
      const raw = localStorage.getItem(`traeky:profile:${profileID}:data`);
      if (!raw) throw new Error('Profildaten nicht gefunden.');
      const data = await decryptLegacyPayload(JSON.parse(raw), String(fd.get('oldPassphrase') || ''));
      const idx = JSON.parse(localStorage.getItem('traeky:profiles:index') || '{}');
      const meta = (idx.profiles || []).find(p => p.id === profileID);
      if (meta?.name) data.profile.name = `${meta.name} (migriert)`;
      session = { ...session, unlocked: true, passphrase: newPass, data, route: 'overview' };
      await persist('Legacy-Profil migriert');
    } catch (err) {
      msg.innerHTML = `<div class="notice danger">Migration fehlgeschlagen: ${escapeHTML(err.message || err)}</div>`;
    }
  });
}

function migrateLooseLegacy(data) {
  try {
    const tx = JSON.parse(localStorage.getItem('traeky:transactions') || '[]');
    const cfg = JSON.parse(localStorage.getItem('traeky:app-config') || '{}');
    data = normalizeData({ ...data, transactions: tx, config: { ...data.config, ...cfg } }, data.profile.name);
    addAudit(data, 'Alte unverschlüsselte localStorage-Daten migriert');
  } catch (err) {
    addAudit(data, `Migration alter localStorage-Daten fehlgeschlagen: ${err.message || err}`);
  }
  return data;
}

function renderDashboard() {
  const d = session.data;
  const summary = computeSummary(d);
  const syncState = d.config.cloud_url ? `Cloud: ${escapeHTML(URLSafe(d.config.cloud_url))}` : 'Cloud nicht konfiguriert';
  return `
    <div class="dashboard">
      <aside class="sidebar">
        <div class="brand"><img src="/icon.svg" alt=""/> Traeky</div>
        <nav>
          ${navButton('overview', '◆', 'Dashboard')}
          ${navButton('transactions', '↕', 'Transaktionen')}
          ${navButton('import', '⇩', 'Import / Export')}
          ${navButton('sync', '☁', 'Cloud Sync')}
          ${navButton('settings', '⚙', 'Sicherheit')}
        </nav>
        <div class="profile-chip"><b>${escapeHTML(d.profile.name)}</b><span>${escapeHTML(syncState)}</span></div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div><div class="eyebrow">E2E Portfolio Vault</div><h2>${sectionTitle(session.route)}</h2><p>Letzte lokale Änderung: ${fmtDate(d.updated_at)}</p></div>
          <div class="btn-row">
            <button class="btn secondary" id="lock-btn">Sperren</button>
            <button class="btn" id="add-tx-btn">+ Transaktion</button>
          </div>
        </div>
        ${renderOverview(summary)}
        ${renderTransactions(summary)}
        ${renderImportExport()}
        ${renderSync()}
        ${renderSettings()}
      </main>
      ${renderTxDialog()}
    </div>`;
}

function URLSafe(value) {
  try { return new URL(value).origin; } catch { return value || ''; }
}

function navButton(route, icon, label) {
  return `<button class="nav-btn ${session.route === route ? 'active' : ''}" data-route="${route}"><span>${icon}</span>${label}</button>`;
}

function sectionTitle(route) {
  return ({ overview: 'Dashboard', transactions: 'Transaktionen', import: 'Import / Export', sync: 'Cloud Sync', settings: 'Sicherheit & Profil' })[route] || 'Dashboard';
}

function computeSummary(data) {
  const holdings = new Map();
  let invested = 0;
  let realized = 0;
  for (const tx of data.transactions) {
    const sign = txSign(tx.tx_type);
    const price = Number(tx.price_fiat || 0);
    if (sign !== 0) holdings.set(tx.asset_symbol, (holdings.get(tx.asset_symbol) || 0) + sign * Number(tx.amount || 0));
    const value = Math.abs(Number(tx.amount || 0) * price);
    if (['BUY', 'AIRDROP', 'STAKING_REWARD'].includes(tx.tx_type)) invested += value;
    if (tx.tx_type === 'SELL') realized += value;
  }
  const items = Array.from(holdings.entries())
    .filter(([, amount]) => Math.abs(amount) > 1e-12)
    .map(([symbol, amount]) => {
      const current = currentPrice(data, symbol);
      return { symbol, amount, price: current, value: amount * current };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const unrealized = total + realized - invested;
  const expiring = computeExpiring(data);
  return { items, total, invested, realized, unrealized, expiring, txCount: data.transactions.length };
}

function txSign(type) {
  switch (String(type || '').toUpperCase()) {
    case 'BUY': case 'AIRDROP': case 'STAKING_REWARD': case 'TRANSFER_IN': return 1;
    case 'SELL': case 'TRANSFER_OUT': return -1;
    default: return 0;
  }
}

function currentPrice(data, symbol) {
  const cached = data.prices?.[symbol]?.[data.config.base_currency.toLowerCase()];
  if (Number.isFinite(Number(cached))) return Number(cached);
  const txs = [...data.transactions].filter(tx => tx.asset_symbol === symbol && Number(tx.price_fiat) > 0).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  return Number(txs[0]?.price_fiat || 0);
}

function computeExpiring(data) {
  const days = Number(data.config.holding_period_days || 365);
  const windowDays = Number(data.config.upcoming_holding_window_days || 30);
  const now = Date.now();
  return data.transactions
    .filter(tx => ['BUY', 'AIRDROP', 'STAKING_REWARD'].includes(tx.tx_type))
    .map(tx => {
      const end = new Date(new Date(tx.timestamp).getTime() + days * 86400000);
      return { tx, end, days_remaining: Math.ceil((end.getTime() - now) / 86400000) };
    })
    .filter(x => x.days_remaining >= 0 && x.days_remaining <= windowDays)
    .sort((a, b) => a.days_remaining - b.days_remaining);
}

function renderOverview(summary) {
  const c = session.data.config.base_currency;
  return `<section class="section ${session.route === 'overview' ? 'active' : ''}" id="section-overview">
    <div class="kpi-grid">
      ${kpi('Portfolio', fmtMoney(summary.total, c), `${summary.items.length} Assets`)}
      ${kpi('Investiert', fmtMoney(summary.invested, c), 'auf Basis erfasster Einstandspreise')}
      ${kpi('Realisiert', fmtMoney(summary.realized, c), 'Verkaufsvolumen')}
      ${kpi('PnL grob', fmtMoney(summary.unrealized, c), 'ohne steuerliche Beratung')}
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>Asset Allocation</h3><p>Wertverteilung nach Assets.</p></div></div><div class="chart-box"><canvas id="allocation-chart" height="260"></canvas></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Portfolio Timeline</h3><p>Historische Einstandswerte je Transaktionsdatum.</p></div></div><div class="chart-box"><canvas id="timeline-chart" height="260"></canvas></div></div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="panel"><div class="panel-head"><div><h3>Steuer-Haltefrist</h3><p>Positionen, die in deinem konfigurierten Fenster steuerlich auslaufen.</p></div></div>${renderExpiring(summary.expiring)}</div>
      <div class="panel"><div class="panel-head"><div><h3>Holdings</h3><p>Berechnet lokal aus deinen Transaktionen.</p></div><button class="btn secondary small" id="refresh-prices">Preise aktualisieren</button></div>${renderHoldingsTable(summary)}</div>
    </div>
  </section>`;
}

function kpi(label, value, delta) {
  return `<div class="tile"><span class="label">${escapeHTML(label)}</span><span class="value">${escapeHTML(value)}</span><div class="delta">${escapeHTML(delta)}</div></div>`;
}

function renderExpiring(items) {
  if (!items.length) return `<div class="empty">Keine auslaufenden Haltefristen im konfigurierten Fenster.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Asset</th><th>Menge</th><th>Ende</th><th>Resttage</th></tr></thead><tbody>${items.slice(0, 10).map(x => `<tr><td>${escapeHTML(x.tx.asset_symbol)}</td><td>${fmtNum(x.tx.amount)}</td><td>${fmtDate(x.end)}</td><td>${x.days_remaining}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderHoldingsTable(summary) {
  if (!summary.items.length) return `<div class="empty">Noch keine Holdings vorhanden.</div>`;
  const c = session.data.config.base_currency;
  return `<div class="table-wrap"><table><thead><tr><th>Asset</th><th>Menge</th><th>Preis</th><th>Wert</th></tr></thead><tbody>${summary.items.map(i => `<tr><td><b>${escapeHTML(i.symbol)}</b><br/><span class="smallprint">${escapeHTML(ASSET_META[i.symbol]?.name || '')}</span></td><td>${fmtNum(i.amount)}</td><td>${fmtMoney(i.price, c)}</td><td>${fmtMoney(i.value, c)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderTransactions() {
  const assets = Array.from(new Set(session.data.transactions.map(t => t.asset_symbol))).sort();
  const filtered = filteredTransactions();
  return `<section class="section ${session.route === 'transactions' ? 'active' : ''}" id="section-transactions">
    <div class="panel">
      <div class="panel-head"><div><h3>Transaktionsbuch</h3><p>Filter, Bearbeitung, Löschung und lokale Berechnung.</p></div><button class="btn secondary" id="export-filtered">Gefilterte CSV</button></div>
      <div class="filters">
        <input id="filter-query" placeholder="Suche nach Asset, Quelle, Note, Tx-ID" value="${escapeHTML(session.filter.query)}" />
        <select id="filter-asset"><option value="">Alle Assets</option>${assets.map(a => `<option ${a === session.filter.asset ? 'selected' : ''}>${escapeHTML(a)}</option>`).join('')}</select>
        <select id="filter-type"><option value="">Alle Typen</option>${TX_TYPES.map(([v,l]) => `<option value="${v}" ${v === session.filter.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn secondary" id="clear-filters">Reset</button>
      </div>
      ${renderTxTable(filtered)}
    </div>
  </section>`;
}

function filteredTransactions() {
  const q = session.filter.query.trim().toLowerCase();
  return [...session.data.transactions]
    .filter(tx => !session.filter.asset || tx.asset_symbol === session.filter.asset)
    .filter(tx => !session.filter.type || tx.tx_type === session.filter.type)
    .filter(tx => !q || [tx.asset_symbol, tx.source, tx.note, tx.tx_id, tx.fiat_currency].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function renderTxTable(items) {
  if (!items.length) return `<div class="empty">Keine Transaktionen für diese Auswahl.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Zeit</th><th>Typ</th><th>Asset</th><th>Menge</th><th>Preis</th><th>Quelle</th><th>Aktion</th></tr></thead><tbody>${items.map(tx => `
    <tr>
      <td>${fmtDate(tx.timestamp)}<br/><span class="smallprint">#${tx.id}</span></td>
      <td><span class="badge ${tx.tx_type.toLowerCase()}">${escapeHTML(tx.tx_type)}</span></td>
      <td><b>${escapeHTML(tx.asset_symbol)}</b><br/><span class="smallprint">${escapeHTML(tx.note || tx.tx_id || '')}</span></td>
      <td>${fmtNum(tx.amount)}</td>
      <td>${tx.price_fiat == null ? '–' : fmtMoney(tx.price_fiat, tx.fiat_currency)}</td>
      <td>${escapeHTML(tx.source || '–')}</td>
      <td><button class="btn secondary small" data-edit-tx="${tx.id}">Bearbeiten</button> <button class="btn danger small" data-delete-tx="${tx.id}">Löschen</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function renderImportExport() {
  return `<section class="section ${session.route === 'import' ? 'active' : ''}" id="section-import">
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>CSV importieren</h3><p>Unterstützt das alte Traeky-CSV-Schema und das neue Schema.</p></div></div>
        <div class="import-box"><input type="file" id="csv-file" accept=".csv,text/csv"/><p class="smallprint">Erwartete Spalten: <span class="code">csv_schema_version,id,asset_symbol,tx_type,amount,price_fiat,fiat_currency,timestamp,source,note,tx_id,linked_tx_prev_id,linked_tx_next_id</span></p><div id="import-msg"></div></div>
      </div>
      <div class="panel"><div class="panel-head"><div><h3>Export & Report</h3><p>Exportiere eine CSV oder lade einen echten PDF-Report herunter.</p></div></div>
        <div class="btn-row"><button class="btn" id="export-csv">CSV exportieren</button><button class="btn secondary" id="export-pdf">PDF-Report herunterladen</button><button class="btn secondary" id="print-report">Drucken</button></div>
        <p class="smallprint">Der CSV-Export enthält keine Passphrase, keinen Cloud-Sync-Key und keinen Cloud-Auth-Secret. Backups mit Cloud Sync sind verschlüsselte Vault-Dateien.</p>
      </div>
    </div>
    <div class="panel" style="margin-top:16px"><h3>Migration beim Aufruf</h3><p>Beim Start prüft Traeky automatisch auf alte localStorage-Schlüssel und alte verschlüsselte Profile. Falls vorhanden, wird im Startdialog eine Migration angeboten. CSV-Import bleibt als Fallback verfügbar.</p></div>
  </section>`;
}

function renderSync() {
  const cfg = session.data.config;
  const configured = cfg.cloud_url && cfg.cloud_key;
  const authConfigured = Boolean((cfg.cloud_auth_secret || cfg.last_remote_auth_secret || '').trim());
  return `<section class="section ${session.route === 'sync' ? 'active' : ''}" id="section-sync">
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>Self-hosted Cloud</h3><p>Kein Account, kein API-Login: Der Server speichert ausschließlich deinen verschlüsselten Vault unter einem zufälligen Sync-Key. Masterkey und Passphrase bleiben im Browser.</p></div></div>
        <form id="sync-form" class="form-grid">
          <div class="form-row"><label>Cloud URL</label><input name="cloud_url" placeholder="https://cloud.example.org" value="${escapeHTML(cfg.cloud_url || '')}" /></div>
          <div class="form-row"><label>Anonymer Sync-Key</label><input name="cloud_key" spellcheck="false" autocomplete="off" value="${escapeHTML(cfg.cloud_key || '')}" /></div>
          <div class="form-row"><label>Cloud Auth-Secret <span class="smallprint">optional, empfohlen</span></label><input name="cloud_auth_secret" spellcheck="false" autocomplete="off" value="${escapeHTML(cfg.cloud_auth_secret || '')}" /></div>
          <p class="smallprint">Der Sync-Key ist die Adresse für deinen Ciphertext. Der optionale Auth-Secret schützt zusätzlich den Zugriff auf diesen Ciphertext: Wer nur den Sync-Key kennt, kann dann nicht lesen, überschreiben oder löschen. Der Auth-Secret ist nicht deine Vault-Passphrase und wird vor dem Senden im Browser gehasht.</p>
          <div class="btn-row"><button class="btn" type="submit">Konfiguration speichern</button><button class="btn secondary" id="generate-sync-key" type="button">Neuen Sync-Key generieren</button><button class="btn secondary" id="generate-auth-secret" type="button">Neuen Auth-Secret generieren</button></div>
        </form>
      </div>
      <div class="panel"><div class="panel-head"><div><h3>Synchronisierung</h3><p>Der erste Push legt den Remote-Vault nur an, wenn der Sync-Key frei ist. Danach schützen Auth-Secret und Revision vor unbefugtem Zugriff und versehentlichem Überschreiben. Pull lädt Ciphertext und entschlüsselt lokal mit deiner Passphrase.</p></div></div>
        <div class="kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${kpi('Remote Revision', String(cfg.last_remote_revision || 0), 'lokal gemerkt')}${kpi('Letzter Sync', cfg.last_sync_at ? fmtDate(cfg.last_sync_at) : 'Nie', configured ? 'bereit' : 'nicht konfiguriert')}${kpi('Remote Zugriff', authConfigured ? 'Auth aktiv' : 'Nur Sync-Key', authConfigured ? 'zusätzlich geschützt' : 'weniger empfohlen')}</div>
        <div class="btn-row"><button class="btn" id="sync-push" ${configured ? '' : 'disabled'}>Verschlüsselt hochladen</button><button class="btn secondary" id="sync-pull" ${configured ? '' : 'disabled'}>Remote laden</button><button class="btn secondary" id="sync-test" ${cfg.cloud_url ? '' : 'disabled'}>Info testen</button></div>
        <div id="sync-msg" style="margin-top:12px"></div>
      </div>
    </div>
  </section>`;
}

function renderSettings() {
  const cfg = session.data.config;
  return `<section class="section ${session.route === 'settings' ? 'active' : ''}" id="section-settings">
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>Profil & Portfolio</h3><p>Lokale Einstellungen werden im verschlüsselten Vault gespeichert.</p></div></div>
        <form id="settings-form" class="form-grid">
          <div class="form-row"><label>Profilname</label><input name="profile_name" value="${escapeHTML(session.data.profile.name)}" /></div>
          <div class="form-row inline"><div><label>Basiswährung</label><select name="base_currency"><option ${cfg.base_currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${cfg.base_currency === 'USD' ? 'selected' : ''}>USD</option></select></div><div><label>Haltefrist in Tagen</label><input name="holding_period_days" type="number" min="1" value="${escapeHTML(cfg.holding_period_days)}" /></div></div>
          <div class="form-row inline"><div><label>Auslaufendes Fenster</label><input name="upcoming_holding_window_days" type="number" min="1" value="${escapeHTML(cfg.upcoming_holding_window_days)}" /></div><div><label>CoinGecko API Key optional</label><input name="coingecko_api_key" value="${escapeHTML(cfg.coingecko_api_key || '')}" /></div></div>
          <button class="btn" type="submit">Speichern</button>
        </form>
      </div>
      <div class="panel"><div class="panel-head"><div><h3>Vault-Sicherheit</h3><p>Passphrase ändern, lokalen Vault exportieren oder alles löschen.</p></div></div>
        <form id="pass-form" class="form-grid">
          <div class="form-row"><label>Neue Passphrase</label><input name="new_passphrase" type="password" minlength="12" /></div>
          <button class="btn secondary" type="submit">Passphrase ändern</button>
        </form>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0"/>
        <div class="btn-row"><button class="btn secondary" id="export-vault">Verschlüsselten Vault exportieren</button><button class="btn danger" id="delete-local">Lokalen Vault löschen</button></div>
      </div>
    </div>
    <div class="panel" style="margin-top:16px"><h3>Audit Trail</h3>${renderAudit()}</div>
  </section>`;
}

function renderAudit() {
  const audit = [...(session.data.audit || [])].reverse().slice(0, 12);
  if (!audit.length) return `<div class="empty">Noch keine Einträge.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Zeit</th><th>Ereignis</th></tr></thead><tbody>${audit.map(a => `<tr><td>${fmtDate(a.at)}</td><td>${escapeHTML(a.message)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderTxDialog() {
  return `<dialog class="dialog" id="tx-dialog"><div class="dialog-body"><button class="btn ghost close-x" id="close-tx-dialog" type="button">✕</button><h2 id="tx-dialog-title">Transaktion</h2><p>Alle Daten werden erst nach dem Speichern wieder verschlüsselt persistiert.</p>
    <form id="tx-form" class="form-grid">
      <input type="hidden" name="id" />
      <div class="form-row inline"><div><label>Asset</label><input name="asset_symbol" placeholder="BTC" required /></div><div><label>Typ</label><select name="tx_type">${TX_TYPES.map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select></div></div>
      <div class="form-row inline"><div><label>Menge</label><input name="amount" type="number" step="any" required /></div><div><label>Zeitpunkt</label><input name="timestamp" type="datetime-local" required /></div></div>
      <div class="form-row inline"><div><label>Preis je Asset</label><input name="price_fiat" type="number" step="any" /></div><div><label>Fiat</label><select name="fiat_currency"><option>EUR</option><option>USD</option><option>CHF</option><option>GBP</option><option>USDT</option><option>USDC</option></select></div></div>
      <div class="form-row inline"><div><label>Quelle/Börse</label><input name="source" placeholder="Binance, Bitpanda …" /></div><div><label>Tx-ID</label><input name="tx_id" /></div></div>
      <div class="form-row"><label>Notiz</label><textarea name="note"></textarea></div>
      <div class="btn-row"><button class="btn" type="submit">Speichern</button><button class="btn secondary" id="cancel-tx" type="button">Abbrechen</button></div>
    </form></div></dialog>`;
}

function bindDashboard() {
  $$('[data-route]').forEach(btn => btn.addEventListener('click', () => { session.route = btn.dataset.route; render(); }));
  $('#lock-btn')?.addEventListener('click', () => { session = { ...session, unlocked: false, passphrase: '', data: null }; render(); });
  $('#add-tx-btn')?.addEventListener('click', () => openTxDialog());
  $('#close-tx-dialog')?.addEventListener('click', closeTxDialog);
  $('#cancel-tx')?.addEventListener('click', closeTxDialog);
  $('#tx-form')?.addEventListener('submit', saveTxFromForm);
  $$('[data-edit-tx]').forEach(btn => btn.addEventListener('click', () => openTxDialog(Number(btn.dataset.editTx))));
  $$('[data-delete-tx]').forEach(btn => btn.addEventListener('click', async () => deleteTx(Number(btn.dataset.deleteTx))));
  $('#filter-query')?.addEventListener('input', e => { session.filter.query = e.target.value; render(); });
  $('#filter-asset')?.addEventListener('change', e => { session.filter.asset = e.target.value; render(); });
  $('#filter-type')?.addEventListener('change', e => { session.filter.type = e.target.value; render(); });
  $('#clear-filters')?.addEventListener('click', () => { session.filter = { query: '', asset: '', type: '' }; render(); });
  $('#export-csv')?.addEventListener('click', () => exportCSV(session.data.transactions, 'traeky-export.csv'));
  $('#export-filtered')?.addEventListener('click', () => exportCSV(filteredTransactions(), 'traeky-filtered.csv'));
  $('#export-pdf')?.addEventListener('click', () => exportPDFReport(filteredTransactions(), makeExportFilename('pdf')));
  $('#print-report')?.addEventListener('click', () => window.print());
  $('#csv-file')?.addEventListener('change', importCSVFile);
  $('#refresh-prices')?.addEventListener('click', refreshPrices);
  $('#sync-form')?.addEventListener('submit', saveSyncConfig);
  $('#generate-sync-key')?.addEventListener('click', () => { $('[name="cloud_key"]').value = randomCloudKey(); });
  $('#generate-auth-secret')?.addEventListener('click', () => { $('[name="cloud_auth_secret"]').value = randomCloudAuthSecret(); });
  $('#sync-push')?.addEventListener('click', syncPush);
  $('#sync-pull')?.addEventListener('click', syncPull);
  $('#sync-test')?.addEventListener('click', syncTest);
  $('#settings-form')?.addEventListener('submit', saveSettings);
  $('#pass-form')?.addEventListener('submit', changePassphrase);
  $('#export-vault')?.addEventListener('click', () => downloadJSON(session.envelope, 'traeky-vault.encrypted.json'));
  $('#delete-local')?.addEventListener('click', deleteLocalVault);
}

function openTxDialog(id = null) {
  const dialog = $('#tx-dialog');
  const form = $('#tx-form');
  form.reset();
  const tx = id ? session.data.transactions.find(t => t.id === id) : null;
  $('#tx-dialog-title').textContent = tx ? 'Transaktion bearbeiten' : 'Transaktion erfassen';
  field(form, 'id').value = tx?.id || '';
  field(form, 'asset_symbol').value = tx?.asset_symbol || '';
  field(form, 'tx_type').value = tx?.tx_type || 'BUY';
  field(form, 'amount').value = tx?.amount ?? '';
  field(form, 'timestamp').value = toLocalInput(tx?.timestamp || nowISO());
  field(form, 'price_fiat').value = tx?.price_fiat ?? '';
  field(form, 'fiat_currency').value = tx?.fiat_currency || session.data.config.base_currency || 'EUR';
  field(form, 'source').value = tx?.source || '';
  field(form, 'tx_id').value = tx?.tx_id || '';
  field(form, 'note').value = tx?.note || '';
  dialog.showModal();
}

function closeTxDialog() { $('#tx-dialog')?.close(); }
function field(form, name) { return form.elements.namedItem(name); }
function toLocalInput(iso) { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,16); }

async function saveTxFromForm(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const id = Number(field(f, 'id').value || 0);
  const tx = normalizeTx({
    id: id || session.data.next_transaction_id++,
    asset_symbol: field(f, 'asset_symbol').value,
    tx_type: field(f, 'tx_type').value,
    amount: field(f, 'amount').value,
    price_fiat: field(f, 'price_fiat').value || null,
    fiat_currency: field(f, 'fiat_currency').value,
    timestamp: new Date(field(f, 'timestamp').value).toISOString(),
    source: field(f, 'source').value,
    tx_id: field(f, 'tx_id').value,
    note: field(f, 'note').value
  });
  if (!tx) return;
  const existingIndex = session.data.transactions.findIndex(t => t.id === id);
  if (existingIndex >= 0) session.data.transactions[existingIndex] = tx; else session.data.transactions.push(tx);
  closeTxDialog();
  await persist(id ? 'Transaktion bearbeitet' : 'Transaktion erfasst');
}

async function deleteTx(id) {
  if (!confirm('Transaktion wirklich löschen?')) return;
  session.data.transactions = session.data.transactions.filter(t => t.id !== id);
  await persist('Transaktion gelöscht');
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i+1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i+1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

async function importCSVFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const msg = $('#import-msg');
  try {
    const rows = parseCSV(await file.text());
    const header = rows.shift().map(h => h.trim());
    const existing = new Set(session.data.transactions.map(dedupeKey));
    let imported = 0, skipped = 0;
    for (const r of rows) {
      const obj = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
      const tx = normalizeTx({ ...obj, amount: Number(obj.amount), price_fiat: obj.price_fiat === '' ? null : Number(obj.price_fiat), id: Number(obj.id) || session.data.next_transaction_id++ });
      if (!tx) { skipped++; continue; }
      if (!tx.id) tx.id = session.data.next_transaction_id++;
      if (existing.has(dedupeKey(tx))) { skipped++; continue; }
      existing.add(dedupeKey(tx));
      session.data.transactions.push(tx);
      imported++;
    }
    await persist(`CSV importiert: ${imported} neu, ${skipped} übersprungen`);
    msg.innerHTML = `<div class="notice success">${imported} Transaktionen importiert, ${skipped} übersprungen.</div>`;
  } catch (err) {
    msg.innerHTML = `<div class="notice danger">CSV-Import fehlgeschlagen: ${escapeHTML(err.message || err)}</div>`;
  }
}

function dedupeKey(tx) { return [tx.asset_symbol, tx.tx_type, Number(tx.amount).toFixed(12), tx.timestamp, tx.source || '', tx.tx_id || ''].join('|'); }

function exportCSV(items, filename) {
  const header = ['csv_schema_version','id','asset_symbol','tx_type','amount','price_fiat','fiat_currency','timestamp','source','note','tx_id','linked_tx_prev_id','linked_tx_next_id'];
  const lines = [header.join(',')];
  for (const tx of items) lines.push(header.map(h => csvCell(h === 'csv_schema_version' ? CSV_SCHEMA_VERSION : (tx[h] ?? ''))).join(','));
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), filename);
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function makeExportFilename(ext) {
  const date = new Date().toISOString().slice(0, 10);
  const profile = String(session.data?.profile?.name || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
  return `traeky-${profile}-${date}.${ext}`;
}

function exportPDFReport(items, filename) {
  const blob = buildPDFReport(session.data, items && items.length ? items : session.data.transactions);
  downloadBlob(blob, filename || makeExportFilename('pdf'));
}

function buildPDFReport(data, transactions) {
  const pageW = 842;
  const pageH = 595;
  const margin = 32;
  const font = 'F1';
  const pages = [];
  let ops = [];
  let y = pageH - margin;

  const line = (x1, y1, x2, y2, width = 0.6) => ops.push(`${width} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  const text = (value, x, yy, size = 9) => ops.push(`BT /${font} ${num(size)} Tf 1 0 0 1 ${num(x)} ${num(yy)} Tm ${pdfLiteral(value)} Tj ET`);
  const addPage = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = pageH - margin;
  };
  const ensure = (needed) => { if (y - needed < margin + 16) { footer(); addPage(); header(false); } };
  const footer = () => {
    line(margin, margin + 16, pageW - margin, margin + 16, 0.4);
    text('Traeky Report - keine steuerliche oder rechtliche Beratung', margin, margin, 7);
    text(`Seite ${pages.length + 1}`, pageW - margin - 42, margin, 7);
  };
  const header = (first) => {
    if (!first) {
      text('Traeky: Report', margin, y, 15);
      text(`Profil: ${data.profile?.name || 'Default'}`, pageW - 230, y, 9);
      y -= 22;
      line(margin, y + 8, pageW - margin, y + 8, 0.5);
    }
  };

  const summary = computeSummary(data);
  const txs = [...(transactions || [])].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const currency = data.config?.base_currency || 'EUR';
  const generated = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());

  text('Traeky: Report', margin, y, 22); y -= 20;
  text(`Erstellt am: ${generated}`, margin, y, 10); y -= 14;
  text(`Profil: ${data.profile?.name || 'Default'} | Transaktionen: ${txs.length} | Basiswaehrung: ${currency}`, margin, y, 10); y -= 18;
  line(margin, y, pageW - margin, y, 0.7); y -= 22;

  text('Uebersicht', margin, y, 14); y -= 16;
  text(`Portfoliowert: ${moneyPlain(summary.totalValue, currency)}`, margin, y, 10); y -= 12;
  text(`Assets: ${summary.items.length}`, margin, y, 10); y -= 12;
  text(`Auslaufende Haltefrist: ${summary.expiring.length}`, margin, y, 10); y -= 20;

  if (summary.items.length) {
    text('Holdings', margin, y, 13); y -= 12;
    line(margin, y, pageW - margin, y, 0.5); y -= 11;
    text('Asset', margin, y, 8); text('Menge', margin + 72, y, 8); text('Preis', margin + 190, y, 8); text('Wert', margin + 300, y, 8); text('Anteil', margin + 415, y, 8); y -= 8;
    line(margin, y, pageW - margin, y, 0.3); y -= 11;
    for (const item of summary.items.slice(0, 18)) {
      ensure(16);
      text(item.symbol, margin, y, 8);
      text(numPlain(item.amount, 8), margin + 72, y, 8);
      text(moneyPlain(item.price, currency), margin + 190, y, 8);
      text(moneyPlain(item.value, currency), margin + 300, y, 8);
      text(`${Math.round(item.share * 1000) / 10}%`, margin + 415, y, 8);
      y -= 12;
    }
    y -= 10;
  }

  ensure(80);
  text('Transaktionsbuch', margin, y, 14); y -= 13;
  const cols = [
    { title: 'ID', x: margin, w: 28 },
    { title: 'Chain', x: margin + 30, w: 58 },
    { title: 'Zeit', x: margin + 90, w: 78 },
    { title: 'Asset', x: margin + 170, w: 38 },
    { title: 'Typ', x: margin + 210, w: 76 },
    { title: 'Menge', x: margin + 288, w: 66 },
    { title: 'Preis', x: margin + 356, w: 66 },
    { title: 'Wert', x: margin + 424, w: 66 },
    { title: 'Waehr.', x: margin + 492, w: 36 },
    { title: 'Quelle', x: margin + 530, w: 70 },
    { title: 'TX-ID / Notiz', x: margin + 602, w: 205 }
  ];
  const tableHeader = () => {
    line(margin, y, pageW - margin, y, 0.5); y -= 10;
    cols.forEach(c => text(c.title, c.x, y, 7.5));
    y -= 7;
    line(margin, y, pageW - margin, y, 0.3); y -= 10;
  };
  tableHeader();
  if (!txs.length) {
    text('Keine Transaktionen vorhanden.', margin, y, 9); y -= 14;
  }
  for (const tx of txs) {
    ensure(22);
    if (y > pageH - margin - 42) tableHeader();
    const value = Number(tx.amount || 0) * Number(tx.price_fiat || 0);
    const row = [
      String(tx.id || ''),
      `N:${tx.linked_tx_next_id || '-'} P:${tx.linked_tx_prev_id || '-'}`,
      shortDate(tx.timestamp),
      tx.asset_symbol,
      formatTxType(tx.tx_type),
      numPlain(tx.amount, 8),
      tx.price_fiat == null ? '-' : numPlain(tx.price_fiat, 2),
      tx.price_fiat == null ? '-' : numPlain(value, 2),
      tx.fiat_currency || currency,
      tx.source || '-',
      tx.tx_id || tx.note || '-'
    ];
    row.forEach((value, i) => text(clip(value, cols[i].w), cols[i].x, y, 7));
    y -= 11;
  }

  y -= 8;
  ensure(44);
  line(margin, y, pageW - margin, y, 0.5); y -= 14;
  text('Hinweis: Dieser Report stellt keine steuerliche oder rechtliche Beratung dar. Die Berechnungen basieren ausschliesslich auf den in Traeky erfassten Daten und koennen unvollstaendig oder fehlerhaft sein.', margin, y, 7.5);
  y -= 10;
  text('Bitte pruefe alle Angaben sorgfaeltig und wende dich bei Bedarf an eine Steuerberaterin oder einen Steuerberater.', margin, y, 7.5);
  footer();
  addPage();

  return new Blob([makePDF(pages, pageW, pageH)], { type: 'application/pdf' });
}

function makePDF(pageStreams, pageW, pageH) {
  const encoder = new TextEncoder();
  const objects = [];
  const pageRefs = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pageStreams.length; i++) {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    pageRefs.push(`${pageObj} 0 R`);
    objects[pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const stream = pageStreams[i];
    objects[contentObj - 1] = `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageStreams.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return encoder.encode(pdf);
}

function pdfLiteral(value) {
  return `(${asciiPDF(value).replace(/[\\()]/g, '\\$&')})`;
}

function asciiPDF(value) {
  return String(value ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss').replace(/€/g, 'EUR')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

function clip(value, width) {
  const max = Math.max(4, Math.floor(width / 3.8));
  const s = asciiPDF(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 3))}...` : s;
}

function shortDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function moneyPlain(value, currency = 'EUR') {
  return `${numPlain(value, 2)} ${currency}`;
}

function numPlain(value, digits = 2) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(n);
}

function formatTxType(value) {
  return TX_TYPES.find(([code]) => code === value)?.[1] || value || '-';
}

function num(value) {
  return Number(value).toFixed(2).replace(/\.00$/, '');
}

async function refreshPrices() {
  const btn = $('#refresh-prices');
  btn.disabled = true;
  try {
    const symbols = computeSummary(session.data).items.map(i => i.symbol).filter(s => ASSET_META[s]?.coingecko);
    const ids = [...new Set(symbols.map(s => ASSET_META[s].coingecko))];
    if (!ids.length) return;
    const params = new URLSearchParams({ ids: ids.join(','), vs_currencies: 'eur,usd' });
    if (session.data.config.coingecko_api_key) params.set('x_cg_demo_api_key', session.data.config.coingecko_api_key);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?${params}`);
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const prices = await res.json();
    session.data.prices = session.data.prices || {};
    for (const sym of symbols) {
      const p = prices[ASSET_META[sym].coingecko];
      if (p) session.data.prices[sym] = { eur: p.eur, usd: p.usd, fetched_at: nowISO() };
    }
    await persist('Preise aktualisiert');
  } catch (err) { alert(`Preisupdate fehlgeschlagen: ${err.message || err}`); }
  finally { btn.disabled = false; }
}

async function saveSyncConfig(e) {
  e.preventDefault();
  const cfg = session.data.config;
  const fd = new FormData(e.currentTarget);
  const oldURL = String(cfg.cloud_url || '').replace(/\/$/, '');
  const oldKey = String(cfg.cloud_key || '').trim();
  const previousRemoteAuth = String(cfg.last_remote_auth_secret || cfg.cloud_auth_secret || '').trim();
  const newURL = String(fd.get('cloud_url') || '').replace(/\/$/, '');
  const newKey = String(fd.get('cloud_key') || '').trim();
  const newAuthSecret = String(fd.get('cloud_auth_secret') || '').trim();

  cfg.cloud_url = newURL;
  cfg.cloud_key = newKey;
  cfg.cloud_auth_secret = newAuthSecret;
  if (oldURL !== newURL || oldKey !== newKey) {
    cfg.last_remote_revision = 0;
    cfg.last_remote_auth_secret = '';
  } else if (cfg.last_remote_revision && previousRemoteAuth && newAuthSecret && previousRemoteAuth !== newAuthSecret) {
    cfg.last_remote_auth_secret = previousRemoteAuth;
  } else if (!newAuthSecret) {
    cfg.last_remote_auth_secret = '';
  }
  delete cfg.cloud_vault_id;
  delete cfg.cloud_token;
  await persist('Sync-Konfiguration gespeichert');
}

function cloudEndpoint() {
  const cfg = session.data.config;
  const base = String(cfg.cloud_url || '').replace(/\/$/, '');
  if (!base || !cfg.cloud_key) throw new Error('Cloud nicht vollständig konfiguriert.');
  return `${base}/api/v1/vaults/${encodeURIComponent(cfg.cloud_key)}`;
}

async function cloudAuthProof(secret) {
  const value = String(secret || '').trim();
  if (!value) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`traeky-cloud-auth-v1:${value}`));
  return `ta1_${b64url(new Uint8Array(digest))}`;
}

async function cloudAuthHeaders() {
  const cfg = session.data.config;
  const currentSecret = String(cfg.cloud_auth_secret || '').trim();
  const remoteSecret = String(cfg.last_remote_auth_secret || currentSecret).trim();
  const headers = {};
  if (remoteSecret) headers['X-Traeky-Vault-Auth'] = await cloudAuthProof(remoteSecret);
  if (cfg.last_remote_revision && remoteSecret && currentSecret && remoteSecret !== currentSecret) {
    headers['X-Traeky-New-Vault-Auth'] = await cloudAuthProof(currentSecret);
  }
  return headers;
}

async function syncPush() {
  const msg = $('#sync-msg');
  msg.innerHTML = `<div class="notice info">Verschlüssele und lade hoch …</div>`;
  try {
    const envelope = await encryptVault(session.data, session.passphrase);
    const cfg = session.data.config;
    const headers = { 'Content-Type': 'application/json', ...(await cloudAuthHeaders()) };
    if (cfg.last_remote_revision) headers['If-Match'] = String(cfg.last_remote_revision);
    else headers['If-None-Match'] = '*';
    const res = await fetch(cloudEndpoint(), { method: 'PUT', headers, body: JSON.stringify({ client_id: deviceID(), device_name: navigator.userAgent.slice(0, 120), body: envelope }) });
    const payload = await safeJSON(res);
    if (!res.ok) {
      if (res.status === 401) throw new Error('Cloud Auth-Secret fehlt oder ist falsch. Prüfe den im Dashboard gespeicherten Auth-Secret.');
      if (res.status === 409) throw new Error(payload.error === 'vault_occupied' ? 'Dieser Sync-Key ist bereits belegt. Generiere einen neuen Key oder lade den vorhandenen Remote-Vault.' : 'Remote-Konflikt: bitte zuerst Remote laden oder Revision zurücksetzen.');
      throw new Error(payload.message || `HTTP ${res.status}`);
    }
    session.data.config.last_sync_at = nowISO();
    session.data.config.last_remote_revision = Number(payload.revision || 0);
    session.data.config.last_remote_auth_secret = String(session.data.config.cloud_auth_secret || '').trim();
    session.envelope = envelope;
    localStorage.setItem(LOCAL_VAULT_KEY, JSON.stringify(envelope));
    await persist('Cloud Sync Push abgeschlossen');
    msg.innerHTML = `<div class="notice success">Upload abgeschlossen. Remote Revision ${payload.revision}${payload.auth_required ? ' · Auth aktiv' : ''}.</div>`;
  } catch (err) { msg.innerHTML = `<div class="notice danger">Sync fehlgeschlagen: ${escapeHTML(err.message || err)}</div>`; }
}

async function syncPull() {
  const msg = $('#sync-msg');
  if (!confirm('Remote-Vault laden und lokalen Stand ersetzen, wenn die Entschlüsselung erfolgreich ist?')) return;
  msg.innerHTML = `<div class="notice info">Lade verschlüsselten Remote-Vault …</div>`;
  try {
    const cfg = session.data.config;
    const res = await fetch(cloudEndpoint(), { headers: await cloudAuthHeaders() });
    const payload = await safeJSON(res);
    if (!res.ok) {
      if (res.status === 401) throw new Error('Cloud Auth-Secret fehlt oder ist falsch. Ohne diesen Secret gibt der Server den Ciphertext nicht heraus.');
      throw new Error(payload.message || `HTTP ${res.status}`);
    }
    const data = await decryptVault(payload.body, session.passphrase);
    const remoteAuthSecret = String(cfg.last_remote_auth_secret || cfg.cloud_auth_secret || '').trim();
    data.config = { ...data.config, cloud_url: cfg.cloud_url, cloud_key: cfg.cloud_key, cloud_auth_secret: String(cfg.cloud_auth_secret || '').trim(), last_sync_at: nowISO(), last_remote_revision: Number(payload.revision || 0), last_remote_auth_secret: remoteAuthSecret };
    delete data.config.cloud_vault_id;
    delete data.config.cloud_token;
    session.data = data;
    await persist('Cloud Sync Pull abgeschlossen');
    msg.innerHTML = `<div class="notice success">Remote-Vault geladen und lokal entschlüsselt.</div>`;
  } catch (err) { msg.innerHTML = `<div class="notice danger">Pull fehlgeschlagen: ${escapeHTML(err.message || err)}</div>`; }
}

async function syncTest() {
  const msg = $('#sync-msg');
  try {
    const base = String(session.data.config.cloud_url || '').replace(/\/$/, '');
    const res = await fetch(`${base}/api/v1/info`);
    const payload = await safeJSON(res);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    msg.innerHTML = `<div class="notice success">Cloud erreichbar: ${escapeHTML(payload.service)} · E2E=${payload.e2e ? 'ja' : 'unbekannt'} · Auth=${escapeHTML(payload.auth_mode || 'optional')} · Max ${Math.round(payload.max_payload_bytes/1024/1024)} MiB</div>`;
  } catch (err) { msg.innerHTML = `<div class="notice danger">Cloud-Test fehlgeschlagen: ${escapeHTML(err.message || err)}</div>`; }
}

async function safeJSON(res) { try { return await res.json(); } catch { return {}; } }
function deviceID() { let id = localStorage.getItem(DEVICE_ID_KEY); if (!id) { id = uuid(); localStorage.setItem(DEVICE_ID_KEY, id); } return id; }

async function saveSettings(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  session.data.profile.name = String(fd.get('profile_name') || session.data.profile.name).trim() || 'Default';
  session.data.config.base_currency = String(fd.get('base_currency') || 'EUR');
  session.data.config.holding_period_days = Math.max(1, Number(fd.get('holding_period_days') || 365));
  session.data.config.upcoming_holding_window_days = Math.max(1, Number(fd.get('upcoming_holding_window_days') || 30));
  session.data.config.coingecko_api_key = String(fd.get('coingecko_api_key') || '').trim();
  await persist('Einstellungen gespeichert');
}

async function changePassphrase(e) {
  e.preventDefault();
  const pass = String(new FormData(e.currentTarget).get('new_passphrase') || '');
  const err = validatePassphrase(pass);
  if (err) { alert(err); return; }
  session.passphrase = pass;
  await persist('Passphrase geändert');
  e.currentTarget.reset();
  alert('Passphrase geändert.');
}

function deleteLocalVault() {
  if (!confirm('Lokalen verschlüsselten Vault wirklich löschen? Cloud-Backups bleiben bestehen.')) return;
  localStorage.removeItem(LOCAL_VAULT_KEY);
  session = { unlocked: false, passphrase: '', envelope: null, data: null, lastRemoteRevision: null, filter: { query: '', asset: '', type: '' }, route: 'overview' };
  render();
}

function downloadJSON(value, filename) { downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), filename); }
function downloadBlob(blob, filename) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

function drawCharts() {
  if (!session.unlocked) return;
  const summary = computeSummary(session.data);
  drawAllocation($('#allocation-chart'), summary.items);
  drawTimeline($('#timeline-chart'), session.data.transactions);
}

function setupCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(Number(canvas.getAttribute('height') || 260) * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return { ctx, w: rect.width, h: Number(canvas.getAttribute('height') || 260) };
}

function drawAllocation(canvas, items) {
  const setup = setupCanvas(canvas); if (!setup) return;
  const { ctx, w, h } = setup;
  const cx = w * .34, cy = h * .52, r = Math.min(w, h) * .34;
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  if (!total) { drawEmptyChart(ctx, w, h, 'Keine Werte'); return; }
  let start = -Math.PI / 2;
  items.slice(0, 8).forEach((item, i) => {
    const angle = (Math.max(0, item.value) / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + angle); ctx.closePath(); ctx.fillStyle = COLOR_SET[i % COLOR_SET.length]; ctx.fill();
    start += angle;
  });
  ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(cx, cy, r * .58, 0, Math.PI*2); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#e7edf7'; ctx.font = '800 18px Inter, sans-serif'; ctx.fillText(fmtMoney(total, session.data.config.base_currency), cx - r * .5, cy + 6);
  items.slice(0, 6).forEach((item, i) => {
    const y = 42 + i * 30, x = w * .62;
    ctx.fillStyle = COLOR_SET[i % COLOR_SET.length]; ctx.fillRect(x, y - 10, 14, 14);
    ctx.fillStyle = '#dbe5f5'; ctx.font = '700 13px Inter, sans-serif'; ctx.fillText(item.symbol, x + 22, y);
    ctx.fillStyle = '#97a4ba'; ctx.font = '12px Inter, sans-serif'; ctx.fillText(`${Math.round((item.value/total)*100)}%`, x + 78, y);
  });
}

function drawTimeline(canvas, transactions) {
  const setup = setupCanvas(canvas); if (!setup) return;
  const { ctx, w, h } = setup;
  const points = buildTimeline(transactions);
  if (points.length < 2) { drawEmptyChart(ctx, w, h, 'Noch zu wenig Daten'); return; }
  const pad = 28;
  const max = Math.max(...points.map(p => p.value), 1);
  const minTime = points[0].time, maxTime = points[points.length - 1].time;
  ctx.strokeStyle = 'rgba(148,163,184,.24)'; ctx.lineWidth = 1;
  for (let i=0;i<4;i++){ const y = pad + i*(h-pad*2)/3; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(w-pad,y); ctx.stroke(); }
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + ((p.time - minTime) / Math.max(1, maxTime - minTime)) * (w - pad*2);
    const y = h - pad - (p.value / max) * (h - pad*2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#69b7ff'; ctx.lineWidth = 3; ctx.stroke();
  ctx.lineTo(w-pad, h-pad); ctx.lineTo(pad, h-pad); ctx.closePath(); ctx.fillStyle = 'rgba(105,183,255,.10)'; ctx.fill();
  ctx.fillStyle = '#97a4ba'; ctx.font = '12px Inter, sans-serif'; ctx.fillText(fmtMoney(max, session.data.config.base_currency), pad, 18);
}

function buildTimeline(transactions) {
  let value = 0;
  return [...transactions].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp)).map(tx => {
    if (['BUY', 'AIRDROP', 'STAKING_REWARD'].includes(tx.tx_type)) value += Math.abs(Number(tx.amount || 0) * Number(tx.price_fiat || 0));
    if (tx.tx_type === 'SELL') value -= Math.abs(Number(tx.amount || 0) * Number(tx.price_fiat || 0));
    return { time: new Date(tx.timestamp).getTime(), value: Math.max(0, value) };
  });
}

function drawEmptyChart(ctx, w, h, text) { ctx.fillStyle = '#97a4ba'; ctx.font = '700 15px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, w/2, h/2); ctx.textAlign = 'left'; }

window.addEventListener('resize', () => requestAnimationFrame(drawCharts));
render();
