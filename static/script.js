// ---------------------------------------------------------------------------
// Sift dashboard
//
// Data flow:
//   - liveCoins    the top ~750 coins by market cap, refreshed every 15s.
//                   This is what the table / Top Movers / Noise Alert /
//                   Watchlist actually render from.
//   - extraCoins    coins outside that live pool — either found via search
//                   (/api/search) or looked up individually
//                   (/api/coin/<id>) for a watchlisted coin that isn't in
//                   liveCoins. Search itself is server-side (queries a
//                   SQLite index of every coin CoinGecko tracks, built by a
//                   slow background job — see refresh_full_coin_index() in
//                   server.py) instead of shipping the entire multi-thousand
//                   coin list to every browser tab, which is what caused the
//                   earlier memory limit outage.
//   - coinsById     a merged lookup (extraCoins first, liveCoins overwrites
//                   on overlap since it's fresher) so any coin can be found
//                   by id regardless of which source it came from.
// ---------------------------------------------------------------------------
 
const TABLE_SIZE = 50;
const TIERS = {
  basic: { label: "Basic", limit: 3 },
  premium: { label: "Premium", limit: 10 },
  super: { label: "Super", limit: Infinity },
};
 
let extraCoins = new Map(); // id -> coin, for search results / watchlisted coins outside liveCoins
let liveCoins = [];
let coinsById = new Map();
let currentFilter = null;   // coin id when the table is filtered to a search result
let activeTf = "24h";       // Top Movers timeframe
let sortColumn = "market_cap";  // Top Coins table: which column is currently sorted
let sortDirection = "desc";     // "asc" | "desc"
let signalFilter = "all";       // Top Coins table: "all" | "validated" | "mixed" | "unvalidated"
 
let watchlist = getWatchlist();
let userTier = getTier();
 
// signalBaseline remembers the last Signal status we saw for each watchlisted
// coin (persisted, so it survives a reload); signalAlerts is the current,
// session-only list of un-dismissed "your coin's Signal changed" notices.
let signalBaseline = getSignalBaseline();
let signalAlerts = [];
 
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
function getSignalBaseline() {
  try {
    const raw = localStorage.getItem("sift_signal_baseline");
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function setSignalBaseline(obj) {
  try { localStorage.setItem("sift_signal_baseline", JSON.stringify(obj)); } catch (e) {}
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
    // Most of these logos are PNGs with a transparent background (a circle on a
    // transparent square), so the letter fallback can't just sit behind the img
    // and rely on it being opaque — it bleeds through the transparent corners.
    // Instead the letter stays in the DOM but visibility:hidden, and onerror
    // reveals it (and drops the broken img) only if the logo actually fails to load.
    return `<div class="${cls}"><img src="${coin.image}" alt="" onerror="this.parentElement.classList.add('${tint}'); this.nextElementSibling.style.visibility='visible'; this.remove();"><span class="dot-letter" style="visibility:hidden">${letter}</span></div>`;
  }
  return `<div class="${cls} ${tint}"><span class="dot-letter">${letter}</span></div>`;
}
 
const SIGNAL_LABELS = { validated: "Validated", mixed: "Mixed", unvalidated: "Unvalidated" };
 
function signalBadgeHTML(coin) {
  const sig = coin.signal;
  if (!sig) return "";
  const label = SIGNAL_LABELS[sig.status] || "Unvalidated";
  // "Source: none found" used to read like the whole Signal had nothing
  // behind it, when really it just means the NEWS half of the check came up
  // empty — the volume half (already spelled out in tt-reason above this)
  // still has real CoinGecko data driving the status either way. Swapping
  // the label to "News:" and, when empty, saying so explicitly instead of
  // the bare "none found" keeps that distinction clear at a glance.
  const sourceLineHTML = sig.source
    ? `<div class="tt-source">News: <a href="${sig.source_link || "#"}" target="_blank" rel="noopener">${sig.source}</a></div>`
    : `<div class="tt-source tt-source-empty">No matching news coverage — Signal is based on trading volume</div>`;
  return `
    <span class="signal-badge ${sig.status}"><span class="signal-dot"></span>${label}
      <div class="signal-tooltip">
        <div class="tt-reason">${sig.reason}</div>
        ${sourceLineHTML}
        <div class="tt-more">Click for full breakdown &rarr;</div>
      </div>
    </span>`;
}
 
function rebuildCoinIndex() {
  coinsById = new Map();
  extraCoins.forEach((c, id) => coinsById.set(id, c));
  liveCoins.forEach(c => coinsById.set(c.id, c)); // liveCoins is fresher, wins on overlap
}
 
// A watchlisted coin might be outside liveCoins (the top ~750). Those still
// need to render in the Watchlist panel, so fetch them individually from the
// server's full coin index — cheap, since it's a local SQLite lookup, not a
// CoinGecko call.
async function ensureWatchlistCoinsLoaded() {
  const missing = watchlist.filter(id => !coinsById.has(id));
  if (missing.length === 0) return;
  await Promise.all(missing.map(async id => {
    try {
      const res = await fetch(`/api/coin/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const coin = await res.json();
      if (coin && coin.id) extraCoins.set(coin.id, coin);
    } catch (err) { /* a watchlisted coin that can't be found stays hidden until it can */ }
  }));
  rebuildCoinIndex();
}
 
// ---------------------------------------------------------------------------
// Render: Top Coins table
//
// Sorting + the Validated/Mixed/Unvalidated filter both operate on liveCoins
// (the top-300-by-market-cap pool already being polled every 3s) — same pool
// Top Movers/Noise Alert/etc. already draw from, so "sort by price ascending"
// means cheapest among the coins we're actively tracking, not literally every
// coin that exists. A search match (currentFilter) still wins outright, same
// as before, and shows just that one coin regardless of sort/filter state.
// ---------------------------------------------------------------------------
const SORT_ACCESSORS = {
  name: c => (c.name || "").toLowerCase(),
  price: c => c.current_price,
  market_cap: c => c.market_cap,
  change24h: c => c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
  signal: c => (c.signal ? SIGNAL_ORDER[c.signal.status] : null),
};
 
// Coins missing the sorted field always sink to the bottom, regardless of
// sort direction — otherwise ascending sorts would shove nulls to the top.
function compareForSort(av, bv, direction) {
  const aNull = av == null, bNull = bv == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (av < bv) return direction === "asc" ? -1 : 1;
  if (av > bv) return direction === "asc" ? 1 : -1;
  return 0;
}
 
function getTableCoins() {
  if (currentFilter) {
    // The filtered coin might be a search result outside liveCoins (that's
    // the whole point of server-side search — finding long-tail coins), so
    // resolve it through the merged index rather than liveCoins alone.
    const coin = coinsById.get(currentFilter);
    return coin ? [coin] : [];
  }
 
  let coins = liveCoins;
  if (signalFilter !== "all") {
    coins = coins.filter(c => c.signal && c.signal.status === signalFilter);
  }
 
  const accessor = SORT_ACCESSORS[sortColumn] || SORT_ACCESSORS.market_cap;
  coins = coins.slice().sort((a, b) => compareForSort(accessor(a), accessor(b), sortDirection));
 
  return coins.slice(0, TABLE_SIZE);
}
 
function renderTable() {
  const tbody = document.getElementById("coinTableBody");
  const coins = getTableCoins();
 
  if (liveCoins.length === 0) {
    tbody.innerHTML = `<tr class="table-loading"><td colspan="6">Loading coins&hellip;</td></tr>`;
    return;
  }
  if (coins.length === 0) {
    const msg = (!currentFilter && signalFilter !== "all")
      ? `No coins are currently flagged ${SIGNAL_LABELS[signalFilter]}.`
      : "No coins match your search.";
    tbody.innerHTML = `<tr class="table-loading"><td colspan="6">${msg}</td></tr>`;
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
      <div class="mover-row" data-id="${coin.id}">
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
      <div class="mover-row" data-id="${coin.id}">
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
// Signal-change alerts — the thing every other tracker only does for price.
// A coin's Signal status (Validated/Mixed/Unvalidated) is the actual
// evidence-backed read on whether a move is real; when a coin on your
// Watchlist flips between those, that's a materially different, more useful
// notice than "price moved X%". Entirely client-side: it just diffs each
// poll's status against the last one we saw, per watchlisted coin.
// ---------------------------------------------------------------------------
const SIGNAL_ORDER = { unvalidated: 0, mixed: 1, validated: 2 };
 
function checkSignalChanges() {
  watchlist.forEach(id => {
    const coin = coinsById.get(id);
    if (!coin || !coin.signal) return;
    const current = coin.signal.status;
    const prev = signalBaseline[id];
    if (prev && prev !== current) {
      const alreadyPending = signalAlerts.some(a => a.id === id && a.to === current && a.from === prev);
      if (!alreadyPending) {
        signalAlerts.unshift({ key: `${id}_${Date.now()}`, id, name: coin.name, from: prev, to: current });
        signalAlerts = signalAlerts.slice(0, 6); // cap so a busy session doesn't pile these up forever
      }
    }
    signalBaseline[id] = current;
  });
  setSignalBaseline(signalBaseline);
}
 
function renderSignalAlerts() {
  const box = document.getElementById("signalAlertsList");
  if (!box) return;
  if (signalAlerts.length === 0) { box.innerHTML = ""; return; }
 
  box.innerHTML = signalAlerts.map(a => {
    const dir = SIGNAL_ORDER[a.to] > SIGNAL_ORDER[a.from] ? "up" : "down";
    return `
      <div class="signal-alert ${dir}" data-key="${a.key}">
        <span class="signal-alert-text"><strong>${a.name}</strong> ${SIGNAL_LABELS[a.from]} &rarr; ${SIGNAL_LABELS[a.to]}</span>
        <button class="signal-alert-dismiss" data-key="${a.key}" title="Dismiss">&#10005;</button>
      </div>`;
  }).join("");
}
 
document.getElementById("signalAlertsList").addEventListener("click", (e) => {
  const btn = e.target.closest(".signal-alert-dismiss");
  if (!btn) return;
  signalAlerts = signalAlerts.filter(a => a.key !== btn.dataset.key);
  renderSignalAlerts();
});
 
// ---------------------------------------------------------------------------
// Render: Quiet Coverage — the mirror image of Noise Alert. Noise Alert
// catches a price moving with nothing behind it; this catches real news
// coverage (a matched article, same as the Signal badge uses) landing on a
// coin whose volume is still too thin to call it backed — coverage the
// market hasn't caught up to yet, worth knowing about either way.
// ---------------------------------------------------------------------------
function renderQuietCoverage() {
  const list = document.getElementById("quietList");
  if (!list) return;
  const flagged = liveCoins
    .filter(c => c.signal && c.signal.source && c.signal.vol_ratio < c.signal.threshold_low)
    .sort((a, b) => a.signal.vol_ratio - b.signal.vol_ratio)
    .slice(0, 4);
 
  document.getElementById("quietCount").textContent = `${flagged.length} flagged`;
 
  if (flagged.length === 0) {
    list.innerHTML = `<p class="loading-row">Nothing quiet right now.</p>`;
    return;
  }
 
  list.innerHTML = flagged.map(coin => {
    const pct = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h;
    const up = pct >= 0;
    return `
      <div class="mover-row" data-id="${coin.id}">
        <span class="mover-left">
          <span class="quiet-flag"></span>
          ${coinDotHTML(coin, "sm")}
          <span class="mover-name">${coin.name}</span><span class="mover-sym">${(coin.symbol || "").toUpperCase()}</span>
        </span>
        <span class="mover-change ${up ? "up" : "down"}">${pct != null ? (up ? "▲" : "▼") + " " + Math.abs(pct).toFixed(2) + "%" : "—"}</span>
      </div>`;
  }).join("");
}
 
// ---------------------------------------------------------------------------
// Render: Signal Track Record — the credibility check on the Signal system
// itself. The server periodically snapshots every coin's Signal status; this
// renders the comparison of each snapshot's price to the coin's price now,
// bucketed by what the Signal said at snapshot time. If "Validated" calls
// hold up better than "Unvalidated" ones over time, that's the proof the
// badge means something rather than just being a label.
// ---------------------------------------------------------------------------
function trackRecordBucketHTML(status, bucket) {
  if (!bucket) return "";
  const up = bucket.avg_change_pct >= 0;
  return `
    <div class="track-bucket">
      <span class="track-bucket-label ${status}">${SIGNAL_LABELS[status]}</span>
      <span class="track-bucket-value ${up ? "up" : "down"}">${up ? "+" : ""}${bucket.avg_change_pct.toFixed(2)}%</span>
      <span class="track-bucket-count">(${bucket.count})</span>
    </div>`;
}
 
function renderTrackRecord(data) {
  const box = document.getElementById("trackRecordBody");
  if (!box) return;
 
  if (!data || !data.ready) {
    const days = data ? data.oldest_snapshot_days : 0;
    box.innerHTML = `<p class="loading-row">Building track record&hellip; Signal history needs a few days to accumulate before a comparison is meaningful${days ? ` (${days}d of history so far)` : ""}.</p>`;
    return;
  }
 
  box.innerHTML = data.windows.map(w => `
    <div class="track-window">
      <div class="track-window-label">${w.days} DAYS LATER</div>
      ${["validated", "mixed", "unvalidated"].map(status => trackRecordBucketHTML(status, w[status])).join("")}
    </div>`).join("");
}
 
async function fetchTrackRecord() {
  try {
    const res = await fetch("/api/track-record");
    renderTrackRecord(await res.json());
  } catch (err) {
    console.error("Failed to load track record", err);
  }
}
 
// ---------------------------------------------------------------------------
// Render: Watchlist + plan badge/modal
// ---------------------------------------------------------------------------
function renderWatchlist() {
  const countEl = document.getElementById("watchCount");
  countEl.textContent = TIERS[userTier].label;
  countEl.className = `watch-count tier-${userTier}`;
 
  renderSignalAlerts();
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
    signalAlerts = signalAlerts.filter(a => a.id !== id);
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
// Search — server-side now (queries the full ~21,500-coin index on the
// server via /api/search), instead of filtering a full coin list already
// sitting in the browser. Debounced so rapid typing doesn't fire a request
// per keystroke, with a request-id guard so a slow earlier response can't
// clobber a faster, newer one.
// ---------------------------------------------------------------------------
let searchDebounceTimer = null;
let searchRequestId = 0;
 
function renderSuggestions(query) {
  const box = document.getElementById("suggestions");
  clearTimeout(searchDebounceTimer);
 
  if (!query) { box.style.display = "none"; box.innerHTML = ""; return; }
 
  const thisRequestId = ++searchRequestId;
  searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const matches = await res.json();
      if (thisRequestId !== searchRequestId) return; // a newer keystroke already superseded this
 
      if (matches.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }
 
      matches.forEach(c => extraCoins.set(c.id, c)); // cache so clicking a suggestion resolves instantly
      rebuildCoinIndex();
 
      box.innerHTML = matches.map(c => `
        <div class="suggestion-item" data-id="${c.id}">
          <span class="sugg-left">${coinDotHTML(c, "sm")}<span class="sugg-name">${c.name}</span></span>
          <span class="sym">${(c.symbol || "").toUpperCase()}</span>
        </div>`).join("");
      box.style.display = "block";
    } catch (err) {
      console.error("Search failed", err);
    }
  }, 200);
}
 
function applySearch(id) {
  currentFilter = id || null;
  renderTable();
}
 
// ---------------------------------------------------------------------------
// Fetching (see the big comment at the top of this file for the split
// between liveCoins / extraCoins)
// ---------------------------------------------------------------------------
async function fetchLivePrices() {
  try {
    const res = await fetch("/api/prices?limit=300");
    liveCoins = await res.json();
    rebuildCoinIndex();
    await ensureWatchlistCoinsLoaded();
    checkSignalChanges();
    renderTable();
    renderMovers();
    renderNoiseAlert();
    renderQuietCoverage();
    renderWatchlist();
    document.getElementById("lastUpdated").textContent = "Updated just now";
  } catch (err) {
    console.error("Failed to load live prices", err);
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
 
// ---------------------------------------------------------------------------
// Signal badge hover tooltip
//
// .signal-tooltip is position: fixed (see style.css for why — it used to be
// position: absolute, which put it inside the clipping box of the <table>
// and <td> ancestors above it, so it rendered almost entirely cut off,
// worst for rows near the top of the table where there wasn't room above
// the row for it to fit inside that box at all). Fixed positioning escapes
// that clipping, but it means the tooltip's position has to be computed and
// set here instead of anchored to the badge with CSS percentages.
//
// Delegated on #coinTableBody (rather than attached per-badge) because the
// table body's rows are fully replaced on every price refresh — listeners
// bound directly to a badge would be silently discarded a few seconds
// later. mouseover/mouseout are used instead of mouseenter/mouseleave
// because those don't bubble, so they can't be delegated from a parent.
// ---------------------------------------------------------------------------
function positionSignalTooltip(badge) {
  const tooltip = badge.querySelector(".signal-tooltip");
  if (!tooltip) return;
 
  const gap = 9;      // space between badge and tooltip, matches the old CSS
  const margin = 8;   // minimum distance kept from the viewport edge
  const badgeRect = badge.getBoundingClientRect();
  // The tooltip is already in the DOM (just invisible via opacity/visibility,
  // not display:none), so its real rendered size — which varies with how
  // long this particular coin's reason text is — is available to measure
  // directly rather than guessed at.
  const ttRect = tooltip.getBoundingClientRect();
  const ttWidth = ttRect.width || 210;
  const ttHeight = ttRect.height || 120;
 
  const fitsAbove = badgeRect.top - gap - ttHeight >= margin;
  tooltip.classList.toggle("tt-below", !fitsAbove);
  const top = fitsAbove ? (badgeRect.top - gap - ttHeight) : (badgeRect.bottom + gap);
 
  // Right-aligned to the badge's right edge by default (matches how this
  // looked before), then clamped so it never runs off either side of the
  // viewport — the Signal column sits at the far right of the table, so an
  // unclamped tooltip would routinely overflow off-screen to the right.
  let left = badgeRect.right - ttWidth;
  left = Math.max(margin, Math.min(left, window.innerWidth - ttWidth - margin));
 
  tooltip.style.top = `${Math.max(margin, top)}px`;
  tooltip.style.left = `${left}px`;
}
 
document.getElementById("coinTableBody").addEventListener("mouseover", (e) => {
  const badge = e.target.closest(".signal-badge");
  if (!badge || badge.contains(e.relatedTarget)) return; // already hovering this badge
  const tooltip = badge.querySelector(".signal-tooltip");
  if (!tooltip) return;
  positionSignalTooltip(badge);
  tooltip.classList.add("show");
});
 
document.getElementById("coinTableBody").addEventListener("mouseout", (e) => {
  const badge = e.target.closest(".signal-badge");
  if (!badge || badge.contains(e.relatedTarget)) return; // moved within the same badge/tooltip
  const tooltip = badge.querySelector(".signal-tooltip");
  if (tooltip) tooltip.classList.remove("show");
});
 
document.getElementById("watchlistList").addEventListener("click", (e) => {
  const btn = e.target.closest(".watch-remove");
  if (btn) { toggleWatch(btn.dataset.id); return; }
  const row = e.target.closest(".watch-row[data-id]");
  if (row) navigateToCoin(row.dataset.id);
});
 
// Top Movers / Noise Alert / Quiet Coverage all render the same .mover-row
// markup (see the big comment above .mover-row in style.css), so they share
// one click-to-navigate handler each — same behavior as clicking a row in
// the Top Coins table.
["moverList", "noiseList", "quietList"].forEach(id => {
  document.getElementById(id).addEventListener("click", (e) => {
    const row = e.target.closest(".mover-row[data-id]");
    if (row) navigateToCoin(row.dataset.id);
  });
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
 
// Top Coins table: sortable column headers. Click sorts by that column;
// clicking the same column again flips direction. Text columns default to
// A→Z, numeric columns default to biggest-first, since that's what people
// expect on first click (e.g. clicking "Market Cap" shouldn't surface the
// smallest coins first).
function updateSortHeaderUI() {
  document.querySelectorAll("thead th.sortable").forEach(th => {
    const arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sort === sortColumn) {
      th.classList.add("sort-active");
      if (arrow) arrow.textContent = sortDirection === "asc" ? " ▲" : " ▼";
    } else {
      th.classList.remove("sort-active");
      if (arrow) arrow.textContent = "";
    }
  });
}
 
document.querySelectorAll("thead th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortColumn === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortColumn = key;
      sortDirection = key === "name" ? "asc" : "desc";
    }
    updateSortHeaderUI();
    renderTable();
  });
});
updateSortHeaderUI(); // reflect the default (Market Cap, desc) on first paint
 
// Top Coins table: Validated/Mixed/Unvalidated filter tabs.
document.getElementById("tableFilters").addEventListener("click", (e) => {
  const tab = e.target.closest(".sf-tab");
  if (!tab) return;
  signalFilter = tab.dataset.filter;
  document.querySelectorAll("#tableFilters .sf-tab").forEach(t => t.classList.toggle("active", t === tab));
  renderTable();
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
 
document.getElementById("searchBtn").addEventListener("click", async () => {
  const q = document.getElementById("searchInput").value.trim();
  if (!q) { applySearch(null); return; }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=1`);
    const matches = await res.json();
    if (matches.length > 0) {
      extraCoins.set(matches[0].id, matches[0]);
      rebuildCoinIndex();
    }
    applySearch(matches.length > 0 ? matches[0].id : null);
  } catch (err) {
    console.error("Search failed", err);
    applySearch(null);
  }
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
    const res = await fetch(`/api/coin/${encodeURIComponent(id)}`);
    if (!res.ok) { renderCoinNotFound(id); return; }
    const coin = await res.json();
    if (!coin) { renderCoinNotFound(id); return; }
    renderCoinDetail(coin);
    fetchCoinTrackRecord(id);
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
}
 
// ---------------------------------------------------------------------------
// Render: per-coin Signal History — the single-coin version of the Track
// Record card. Rather than an average across many coins (which needs a
// minimum sample size to not just be noise), this shows exactly what
// happened for THIS coin: what its Signal read at each past checkpoint, and
// what its price has done since. Makes the Signal badge on this one page
// feel backed by evidence rather than an abstract system-wide claim.
// ---------------------------------------------------------------------------
function coinTrackWindowHTML(w) {
  const up = w.change_pct >= 0;
  return `
    <div class="track-bucket">
      <span class="track-bucket-label ${w.status}">${w.days}d ago: ${SIGNAL_LABELS[w.status]}</span>
      <span class="track-bucket-value ${up ? "up" : "down"}">${up ? "+" : ""}${w.change_pct.toFixed(2)}%</span>
    </div>`;
}
 
function renderCoinTrackRecord(data) {
  const box = document.getElementById("coinTrackRecordBody");
  if (!box) return;
 
  if (!data || !data.has_history) {
    box.innerHTML = `<p class="loading-row">No Signal history recorded yet for this coin &mdash; check back in a few days as it accumulates.</p>`;
    return;
  }
 
  const pct = data.status_pct || {};
  const checkWord = data.total_snapshots === 1 ? "check" : "checks";
  const breakdownHTML = ["validated", "mixed", "unvalidated"]
    .filter(s => pct[s] != null)
    .map(s => `
      <div class="track-bucket">
        <span class="track-bucket-label ${s}">${SIGNAL_LABELS[s]}</span>
        <span class="track-bucket-count">${pct[s]}% of ${data.total_snapshots} ${checkWord} (${data.oldest_snapshot_days}d tracked)</span>
      </div>`).join("");
 
  const windowsHTML = data.windows.length
    ? data.windows.map(coinTrackWindowHTML).join("")
    : `<p class="loading-row">Not enough history yet to compare price since a past Signal.</p>`;
 
  box.innerHTML = `
    <div class="track-window">
      <div class="track-window-label">SIGNAL READING, OVER TIME</div>
      ${breakdownHTML}
    </div>
    <div class="track-window">
      <div class="track-window-label">PRICE SINCE THAT SIGNAL</div>
      ${windowsHTML}
    </div>`;
}
 
async function fetchCoinTrackRecord(id) {
  try {
    const res = await fetch(`/api/track-record/${encodeURIComponent(id)}`);
    renderCoinTrackRecord(await res.json());
  } catch (err) {
    console.error("Failed to load coin track record", err);
  }
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
// Init — routes to either the live dashboard or a single coin's detail page
// based on the URL, since both share this one script.js / index.html.
// ---------------------------------------------------------------------------
function initDashboard() {
  fetchLivePrices();
  fetchNewsList();
  fetchTrackRecord();
 
  // Search no longer needs a periodic full-list fetch at all — it queries
  // the server on demand instead (see the Search section above). Prices
  // don't move fast enough on a research dashboard to need a 3-second
  // refresh, so that's backed off too.
  setInterval(fetchLivePrices, 15000);
  setInterval(fetchNewsList, 300000);
  setInterval(fetchTrackRecord, 300000); // changes slowly — snapshots are only taken every few hours
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
 