// ---------------------------------------------------------------------------
// Sift dashboard
//
// Data flow:
//   - allCoins       full ~5000-coin list, refreshed every 60s. Used only for
//                     the search index (so search can find coins outside the
//                     top 300 shown live).
//   - liveCoins       top 300 coins by market cap, refreshed every 3s. This is
//                     what the table / Top Movers / Noise Alert / Watchlist
//                     actually render from — a much smaller, cheaper payload
//                     than re-downloading all ~5000 coins every 3 seconds.
//   - coinsById       a merged lookup (allCoins first, liveCoins overwrites)
//                     so any coin can be found by id regardless of which list
//                     it came from.
// ---------------------------------------------------------------------------

const TABLE_SIZE = 50;
const TIERS = {
  basic: { label: "Basic", limit: 3 },
  premium: { label: "Premium", limit: 10 },
  super: { label: "Super", limit: Infinity },
};

let allCoins = [];
let liveCoins = [];
let coinsById = new Map();
let globalStats = {};
let currentFilter = null;   // coin id when the table is filtered to a search result
let activeTf = "24h";       // Top Movers timeframe

let watchlist = getWatchlist();
let userTier = getTier();

// ---------------------------------------------------------------------------
// localStorage (watchlist + plan tier)
//
// There's no login system yet, so both of these live in the browser only —
// they won't follow you to another device, and "upgrading" a tier here is
// just a local UI toggle, not a real purchase. Once accounts + billing exist,
// this is the piece that gets swapped for a real API call.
// ---------------------------------------------------------------------------
function getTier() {
  try { return localStorage.getItem("sift_tier") || "basic"; }
  catch (e) { return "basic"; }
}
function setTier(t) {
  try { localStorage.setItem("sift_tier", t); } catch (e) {}
}
function getWatchlist() {
  try {
    const raw = localStorage.getItem("sift_watchlist");
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function setWatchlist(list) {
  try { localStorage.setItem("sift_watchlist", JSON.stringify(list)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatPrice(n) {
  if (n == null) return "—";
  if (n >= 1) return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 0.01) return "$" + n.toFixed(4);
  return "$" + n.toPrecision(3); // very small prices (memecoins etc.) keep a few significant digits
}

function formatCap(n) {
  if (n == null) return "—";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  return "$" + n.toLocaleString();
}

function getChangeForTf(coin, tf) {
  if (tf === "1h") return coin.price_change_percentage_1h_in_currency;
  if (tf === "7d") return coin.price_change_percentage_7d_in_currency;
  return coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h;
}

function changeHTML(pct) {
  if (pct == null) return '<span class="change">—</span>';
  const up = pct >= 0;
  return `<span class="change ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%</span>`;
}

// Deterministic tint for a coin with no logo yet — same coin always gets the
// same color, like a Slack/Discord initials avatar.
function tintClass(sym) {
  let sum = 0;
  for (const ch of sym.toUpperCase()) sum += ch.charCodeAt(0);
  return "c" + ((sum % 6) + 1);
}

function coinDotHTML(coin, sizeClass = "") {
  const sym = (coin.symbol || "?").toUpperCase();
  const letter = sym.charAt(0);
  const tint = tintClass(sym);
  const cls = `coin-dot ${sizeClass}`.trim();
  if (coin.image) {
    // Real logo, straight from CoinGecko's own data — no extra fetching needed.
    // If it 404s for some reason, onerror swaps in the tinted letter fallback.
    return `<div class="${cls}"><img src="${coin.image}" alt="" onerror="this.parentElement.classList.add('${tint}'); this.remove();">${letter}</div>`;
  }
  return `<div class="${cls} ${tint}">${letter}</div>`;
}

const SIGNAL_LABELS = { validated: "Validated", mixed: "Mixed", unvalidated: "Unvalidated" };

function signalBadgeHTML(coin) {
  const sig = coin.signal;
  if (!sig) return "";
  const label = SIGNAL_LABELS[sig.status] || "Unvalidated";
  const sourceHTML = sig.source
    ? `<a href="${sig.source_link || "#"}" target="_blank" rel="noopener">${sig.source}</a>`
    : "none found";
  return `
    <span class="signal-badge ${sig.status}"><span class="signal-dot"></span>${label}
      <div class="signal-tooltip">
        <div class="tt-reason">${sig.reason}</div>
        <div class="tt-source">Source: ${sourceHTML}</div>
        <div class="tt-more">Click for full breakdown &rarr;</div>
      </div>
    </span>`;
}

function rebuildCoinIndex() {
  coinsById = new Map();
  allCoins.forEach(c => coinsById.set(c.id, c));
  liveCoins.forEach(c => coinsById.set(c.id, c)); // liveCoins is fresher, wins on overlap
}

// ---------------------------------------------------------------------------
// Render: Top Coins table
// ---------------------------------------------------------------------------
function getTableCoins() {
  if (currentFilter) return liveCoins.filter(c => c.id === currentFilter);
  return liveCoins.slice(0, TABLE_SIZE);
}

function renderTable() {
  const tbody = document.getElementById("coinTableBody");
  const coins = getTableCoins();

  if (liveCoins.length === 0) {
    tbody.innerHTML = `<tr class="table-loading"><td colspan="6">Loading coins&hellip;</td></tr>`;
    return;
  }
  if (coins.length === 0) {
    tbody.innerHTML = `<tr class="table-loading"><td colspan="6">No coins match your search.</td></tr>`;
    return;
  }

  tbody.innerHTML = coins.map(coin => {
    const pinned = watchlist.includes(coin.id);
    return `
      <tr data-id="${coin.id}">
        <td class="watch-cell"><button class="watch-star ${pinned ? "pinned" : ""}" data-id="${coin.id}" title="${pinned ? "In your watchlist" : "Add to watchlist"}">&#9733;</button></td>
        <td><div class="coin-cell">${coinDotHTML(coin)}<span class="coin-name">${coin.name}</span><span class="coin-sym">${(coin.symbol || "").toUpperCase()}</span></div></td>
        <td class="price mono">${formatPrice(coin.current_price)}</td>
        <td class="cap-vol mono">${formatCap(coin.market_cap)}</td>
        <td>${changeHTML(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h)}</td>
        <td>${signalBadgeHTML(coin)}</td>
      </tr>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Render: Top Movers
// ---------------------------------------------------------------------------
function renderMovers() {
  const list = document.getElementById("moverList");
  const candidates = liveCoins
    .filter(c => getChangeForTf(c, activeTf) != null)
    .slice()
    .sort((a, b) => Math.abs(getChangeForTf(b, activeTf)) - Math.abs(getChangeForTf(a, activeTf)))
    .slice(0, 8);

  if (candidates.length === 0) {
    list.innerHTML = `<p class="loading-row">Loading&hellip;</p>`;
    return;
  }

  list.innerHTML = candidates.map((coin, i) => {
    const pct = getChangeForTf(coin, activeTf);
    const up = pct >= 0;
    return `
      <div class="mover-row">
        <span class="mover-left">
          <span class="mover-rank">${i + 1}</span>
          ${coinDotHTML(coin, "sm")}
          <span class="mover-name">${coin.name}</span><span class="mover-sym">${(coin.symbol || "").toUpperCase()}</span>
        </span>
        <span class="mover-change ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%</span>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Render: Noise Alert (Unvalidated coins, ranked by size of move)
// ---------------------------------------------------------------------------
function renderNoiseAlert() {
  const list = document.getElementById("noiseList");
  const flagged = liveCoins
    .filter(c => c.signal && c.signal.status === "unvalidated")
    .filter(c => (c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h) != null)
    .sort((a, b) => {
      const pa = Math.abs(a.price_change_percentage_24h_in_currency ?? a.price_change_percentage_24h);
      const pb = Math.abs(b.price_change_percentage_24h_in_currency ?? b.price_change_percentage_24h);
      return pb - pa;
    })
    .slice(0, 4);

  document.getElementById("noiseCount").textContent = `${flagged.length} flagged`;

  if (flagged.length === 0) {
    list.innerHTML = `<p class="loading-row">Nothing flagged right now.</p>`;
    return;
  }

  list.innerHTML = flagged.map(coin => {
    const pct = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h;
    const up = pct >= 0;
    return `
      <div class="mover-row">
        <span class="mover-left">
          <span class="noise-flag"></span>
          ${coinDotHTML(coin, "sm")}
          <span class="mover-name">${coin.name}</span><span class="mover-sym">${(coin.symbol || "").toUpperCase()}</span>
        </span>
        <span class="mover-change ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%</span>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Render: Watchlist + plan badge/modal
// ---------------------------------------------------------------------------
function renderWatchlist() {
  const countEl = document.getElementById("watchCount");
  countEl.textContent = TIERS[userTier].label;
  countEl.className = `watch-count tier-${userTier}`;

  renderTierGrid();

  const list = document.getElementById("watchlistList");
  const emptyMsg = `<p class="watchlist-empty">Tap the star on any coin in the table to pin it here for quick, live tracking.</p>`;

  if (watchlist.length === 0) {
    list.innerHTML = emptyMsg;
    return;
  }

  const rows = watchlist.map(id => {
    const coin = coinsById.get(id);
    if (!coin) return ""; // not loaded yet (e.g. right after first paint)
    const pct = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h;
    const up = pct >= 0;
    return `
      <div class="watch-row" data-id="${id}">
        <span class="mover-left">${coinDotHTML(coin, "sm")}<span class="mover-name">${coin.name}</span><span class="mover-sym">${(coin.symbol || "").toUpperCase()}</span></span>
        <span class="watch-row-right">
          <span class="watch-price ${up ? "up" : "down"}">${pct != null ? (up ? "+" : "") + pct.toFixed(2) + "%" : "—"}</span>
          <button class="watch-remove" data-id="${id}" title="Remove from watchlist">&#10005;</button>
        </span>
      </div>`;
  }).join("");

  list.innerHTML = rows || emptyMsg;
}

function renderTierGrid() {
  document.querySelectorAll(".tier-card").forEach(card => {
    const isCurrent = card.dataset.tier === userTier;
    card.classList.toggle("current", isCurrent);
    const btn = card.querySelector("[data-tier-btn]");
    btn.disabled = isCurrent;
    btn.textContent = isCurrent ? "Current plan" : "Upgrade";
  });
}

function setStarState(id, pinned) {
  document.querySelectorAll(`.watch-star[data-id="${id}"]`).forEach(btn => {
    btn.classList.toggle("pinned", pinned);
    btn.title = pinned ? "In your watchlist" : "Add to watchlist";
  });
}

function openUpgradeModal() { document.getElementById("upgradeOverlay").classList.add("open"); }
function closeUpgradeModal() { document.getElementById("upgradeOverlay").classList.remove("open"); }

function toggleWatch(id) {
  if (watchlist.includes(id)) {
    watchlist = watchlist.filter(s => s !== id);
    setWatchlist(watchlist);
    setStarState(id, false);
    renderWatchlist();
    return;
  }
  if (watchlist.length >= TIERS[userTier].limit) {
    openUpgradeModal();
    return;
  }
  watchlist.push(id);
  setWatchlist(watchlist);
  setStarState(id, true);
  renderWatchlist();
}

// ---------------------------------------------------------------------------
// Render: Market Overview
// ---------------------------------------------------------------------------
function renderMarketOverview() {
  if (!globalStats || globalStats.total_market_cap_usd == null) return;
  document.getElementById("statMarketCap").textContent = formatCap(globalStats.total_market_cap_usd);
  document.getElementById("statVolume").textContent = formatCap(globalStats.total_volume_usd);
  document.getElementById("statBtcDom").textContent =
    globalStats.btc_dominance != null ? globalStats.btc_dominance.toFixed(1) + "%" : "—";

  const capChange = globalStats.market_cap_change_24h;
  const el = document.getElementById("statCapChange");
  if (capChange != null) {
    const up = capChange >= 0;
    el.className = `stat-value mono ${up ? "up" : "down"}`;
    el.textContent = `${up ? "▲" : "▼"} ${Math.abs(capChange).toFixed(2)}%`;
  }
}

// ---------------------------------------------------------------------------
// Render: News
// ---------------------------------------------------------------------------
function renderNews(articles) {
  const list = document.getElementById("newsList");
  if (!articles || articles.length === 0) {
    list.innerHTML = `<p class="loading-row">No news right now.</p>`;
    return;
  }
  list.innerHTML = articles.map(a => `
    <a class="news-card" href="${a.link}" target="_blank" rel="noopener">
      <div class="news-title">${a.title}</div>
      <div class="news-meta"><span class="news-source">${a.source}</span><span>&middot;</span><span>${a.published || ""}</span></div>
    </a>`).join("");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function renderSuggestions(query) {
  const box = document.getElementById("suggestions");
  if (!query) { box.style.display = "none"; box.innerHTML = ""; return; }
  const q = query.toLowerCase();
  const matches = allCoins
    .filter(c => c.name.toLowerCase().includes(q) || (c.symbol || "").toLowerCase().includes(q))
    .slice(0, 8);

  if (matches.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }

  box.innerHTML = matches.map(c => `
    <div class="suggestion-item" data-id="${c.id}">
      <span class="sugg-left">${coinDotHTML(c, "sm")}${c.name}</span>
      <span class="sym">${(c.symbol || "").toUpperCase()}</span>
    </div>`).join("");
  box.style.display = "block";
}

function applySearch(id) {
  currentFilter = id || null;
  renderTable();
}

// ---------------------------------------------------------------------------
// Fetching (see the big comment at the top of this file for the split
// between allCoins / liveCoins)
// ---------------------------------------------------------------------------
async function fetchLivePrices() {
  try {
    const res = await fetch("/api/prices?limit=300");
    liveCoins = await res.json();
    rebuildCoinIndex();
    renderTable();
    renderMovers();
    renderNoiseAlert();
    renderWatchlist();
    document.getElementById("lastUpdated").textContent = "Updated just now";
  } catch (err) {
    console.error("Failed to load live prices", err);
  }
}

async function fetchAllCoinsIndex() {
  try {
    const res = await fetch("/api/prices");
    allCoins = await res.json();
    rebuildCoinIndex();
  } catch (err) {
    console.error("Failed to load full coin list", err);
  }
}

async function fetchGlobalStats() {
  try {
    const res = await fetch("/api/global");
    globalStats = await res.json();
    renderMarketOverview();
  } catch (err) {
    console.error("Failed to load global stats", err);
  }
}

async function fetchNewsList() {
  try {
    const res = await fetch("/api/news");
    renderNews(await res.json());
  } catch (err) {
    console.error("Failed to load news", err);
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
document.getElementById("coinTableBody").addEventListener("click", (e) => {
  const btn = e.target.closest(".watch-star");
  if (btn) { toggleWatch(btn.dataset.id); return; }
  if (e.target.closest("a")) return; // source link inside the Signal tooltip — let it open normally
  const row = e.target.closest("tr[data-id]");
  if (row) navigateToCoin(row.dataset.id);
});

document.getElementById("watchlistList").addEventListener("click", (e) => {
  const btn = e.target.closest(".watch-remove");
  if (btn) toggleWatch(btn.dataset.id);
});

document.getElementById("watchUpgradeLink").addEventListener("click", openUpgradeModal);
document.getElementById("upgradeClose").addEventListener("click", closeUpgradeModal);
document.getElementById("upgradeOverlay").addEventListener("click", (e) => {
  if (e.target.id === "upgradeOverlay") closeUpgradeModal();
});
document.querySelectorAll("[data-tier-btn]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    userTier = btn.dataset.tierBtn;
    setTier(userTier);
    renderWatchlist();
    closeUpgradeModal();
  });
});

document.querySelectorAll(".tf-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tf-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeTf = tab.dataset.tf;
    renderMovers();
  });
});

document.getElementById("searchInput").addEventListener("input", (e) => {
  renderSuggestions(e.target.value.trim());
});

document.getElementById("suggestions").addEventListener("click", (e) => {
  const item = e.target.closest(".suggestion-item");
  if (!item) return;
  const id = item.dataset.id;
  document.getElementById("searchInput").value = coinsById.get(id)?.name || "";
  document.getElementById("suggestions").style.display = "none";
  applySearch(id);
});

document.getElementById("searchBtn").addEventListener("click", () => {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  if (!q) { applySearch(null); return; }
  const exact = allCoins.find(c => c.name.toLowerCase() === q || (c.symbol || "").toLowerCase() === q);
  const partial = exact || allCoins.find(c => c.name.toLowerCase().includes(q) || (c.symbol || "").toLowerCase().includes(q));
  applySearch(partial ? partial.id : null);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) {
    document.getElementById("suggestions").style.display = "none";
  }
});

// ---------------------------------------------------------------------------
// Coin detail page (/coin/<id>) — a dedicated, shareable breakdown of exactly
// why a coin got the Signal it did: the real volume math plus the matching
// (or missing) news coverage, not just the short tooltip version.
// ---------------------------------------------------------------------------
function navigateToCoin(id) {
  window.location.href = "/coin/" + encodeURIComponent(id);
}

async function initCoinDetail(id) {
  try {
    const res = await fetch("/api/prices");
    const coins = await res.json();
    const coin = coins.find(c => c.id === id);
    if (!coin) { renderCoinNotFound(id); return; }
    renderCoinDetail(coin);
  } catch (err) {
    console.error("Failed to load coin detail", err);
    renderCoinNotFound(id);
  }
}

function renderCoinDetail(coin) {
  const sig = coin.signal || {};
  const status = sig.status || "unvalidated";
  const label = SIGNAL_LABELS[status] || "Unvalidated";

  document.getElementById("detailCoinDot").innerHTML = coinDotHTML(coin, "lg");
  document.getElementById("detailName").textContent = coin.name;
  document.getElementById("detailSym").textContent = (coin.symbol || "").toUpperCase();
  document.getElementById("detailPrice").textContent = formatPrice(coin.current_price);
  document.getElementById("detailBadgeWrap").innerHTML =
    `<span class="signal-badge lg ${status}"><span class="signal-dot"></span>${label}</span>`;
  document.getElementById("detailReason").textContent = sig.reason || "No signal computed yet.";

  const volume = sig.volume ?? coin.total_volume;
  const marketCap = sig.market_cap ?? coin.market_cap;
  document.getElementById("detailVolume").textContent = formatCap(volume);
  document.getElementById("detailMcap").textContent = formatCap(marketCap);

  const ratioPct = (sig.vol_ratio ?? 0) * 100;
  const lowPct = (sig.threshold_low ?? 0.02) * 100;
  const highPct = (sig.threshold_high ?? 0.08) * 100;
  document.getElementById("detailRatio").textContent = ratioPct.toFixed(2) + "%";

  // Bar scale caps at 15% so the two threshold markers stay visible even
  // though most coins fall well under that.
  const barMax = 15;
  document.getElementById("detailRatioFill").style.width = Math.min(100, (ratioPct / barMax) * 100) + "%";
  document.getElementById("detailThresholdLow").style.left = Math.min(100, (lowPct / barMax) * 100) + "%";
  document.getElementById("detailThresholdHigh").style.left = Math.min(100, (highPct / barMax) * 100) + "%";

  const newsCard = document.getElementById("detailNewsCard");
  newsCard.innerHTML = sig.source
    ? `<a class="news-card" href="${sig.source_link || "#"}" target="_blank" rel="noopener">
         <div class="news-title">${sig.source_title || "Matching article"}</div>
         <div class="news-meta"><span class="news-source">${sig.source}</span></div>
       </a>`
    : `<p class="loading-row">No matching coverage found in the current news cache.</p>`;

  document.title = `${coin.name} (${(coin.symbol || "").toUpperCase()}) — Sift`;

  renderContractCard(coin);
}

function renderCoinNotFound(id) {
  document.getElementById("coinDetailView").innerHTML = `
    <a href="/" class="detail-back">&larr; Back to dashboard</a>
    <div class="card" style="margin-top:16px;">
      <p class="card-title">Not found</p>
      <p class="loading-row">Couldn't find a coin matching "${id}". It may not be in our top-cap list, or the id in the link is off.</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Contract Address card — the Axiom/Fomo-style verification block. A coin's
// name or ticker can be spoofed by copycat tokens, but its on-chain contract
// address is the one thing that can't be faked, so we show it prominently
// with a one-click copy, right on the coin's detail page.
// ---------------------------------------------------------------------------
const CHAIN_LABELS = {
  ethereum: "Ethereum",
  "binance-smart-chain": "BNB Chain",
  "polygon-pos": "Polygon",
  solana: "Solana",
  "arbitrum-one": "Arbitrum",
  "optimistic-ethereum": "Optimism",
  avalanche: "Avalanche",
  fantom: "Fantom",
  base: "Base",
  tron: "TRON",
  "the-open-network": "TON",
};

function formatChainName(slug) {
  if (CHAIN_LABELS[slug]) return CHAIN_LABELS[slug];
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function truncateAddr(addr) {
  if (addr.length <= 16) return addr;
  return addr.slice(0, 8) + "…" + addr.slice(-6);
}

function renderContractCard(coin) {
  const body = document.getElementById("detailContractBody");
  if (!body) return;
  const platforms = coin.platforms || {};
  const entries = Object.entries(platforms);

  if (entries.length === 0) {
    body.innerHTML = `<p class="loading-row">${coin.name} is a native coin, not a token on another chain — there's no contract address to verify here.</p>`;
    return;
  }

  body.innerHTML = `
    <p class="contract-warning">Always double-check this address before pasting it into a wallet or DEX — scam tokens can copy a coin's name and logo, but not its contract address.</p>
    ${entries.map(([chain, addr]) => `
      <div class="contract-row">
        <span class="contract-chain">${formatChainName(chain)}</span>
        <span class="contract-addr mono" title="${addr}">${truncateAddr(addr)}</span>
        <button class="contract-copy-btn" data-addr="${addr}">Copy</button>
      </div>`).join("")}
  `;
}

document.getElementById("coinDetailView").addEventListener("click", (e) => {
  const btn = e.target.closest(".contract-copy-btn");
  if (!btn) return;
  const addr = btn.dataset.addr;
  const original = btn.textContent;
  const reset = () => { btn.textContent = original; btn.classList.remove("copied"); };
  navigator.clipboard.writeText(addr).then(() => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(reset, 1500);
  }).catch(() => {
    btn.textContent = "Copy failed";
    setTimeout(reset, 1500);
  });
});

// ---------------------------------------------------------------------------
// Init — routes to either the live dashboard or a single coin's detail page
// based on the URL, since both share this one script.js / index.html.
// ---------------------------------------------------------------------------
function initDashboard() {
  fetchAllCoinsIndex();
  fetchLivePrices();
  fetchGlobalStats();
  fetchNewsList();

  setInterval(fetchLivePrices, 3000);
  setInterval(fetchAllCoinsIndex, 60000);
  setInterval(fetchGlobalStats, 60000);
  setInterval(fetchNewsList, 300000);
}

function init() {
  const match = location.pathname.match(/^\/coin\/([^/]+)/);
  if (match) {
    document.getElementById("dashboardView").style.display = "none";
    document.getElementById("coinDetailView").style.display = "block";
    initCoinDetail(decodeURIComponent(match[1]));
  } else {
    initDashboard();
  }
}

document.addEventListener("DOMContentLoaded", init);