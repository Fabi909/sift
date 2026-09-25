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
  // Confidence is deliberately NOT in the badge label or the table — it's a
  // sub-metric of how strongly a coin clears its status (see
  // compute_confidence() in server.py), not a fourth status to scan for.
  // One quiet line in the tooltip is enough; it doesn't need its own column.
  const confidenceHTML = sig.confidence != null
    ? `<div class="tt-confidence">Confidence: <strong>${sig.confidence}</strong>/100</div>`
    : "";
  return `
    <span class="signal-badge ${sig.status}"><span class="signal-dot"></span>${label}
      <div class="signal-tooltip">
        <div class="tt-reason">${sig.reason}</div>
        ${confidenceHTML}
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
// Render: Source Reliability — the "By Source" tab inside the same Track
// Record card above, rather than its own sidebar card (the left column is
// already stacked deep, and this is the same kind of credibility check —
// average price change since a call was first made — just grouped by news
// source instead of by Signal status). Server-side, a "call" is recorded
// the first time an article matching a coin is seen (record_source_calls()
// in server.py); this renders the per-source, per-window average return
// since then.
// ---------------------------------------------------------------------------
function sourceReliabilityRowHTML(src) {
  const windowsHTML = src.windows.map(w => {
    const up = w.avg_change_pct >= 0;
    return `
      <div class="track-bucket">
        <span class="track-bucket-label plain">${w.days}d avg</span>
        <span class="track-bucket-value ${up ? "up" : "down"}">${up ? "+" : ""}${w.avg_change_pct.toFixed(2)}%</span>
        <span class="track-bucket-count">(${w.count})</span>
      </div>`;
  }).join("");
  const callWord = src.total_calls === 1 ? "call" : "calls";
  return `
    <div class="track-window">
      <div class="track-window-label">${src.source.toUpperCase()} &middot; ${src.total_calls} ${callWord} tracked</div>
      ${windowsHTML}
    </div>`;
}

function renderSourceReliability(data) {
  const box = document.getElementById("sourceReliabilityBody");
  if (!box) return;

  if (!data || !data.ready) {
    box.innerHTML = `<p class="loading-row">Building source reliability&hellip; a source needs at least 3 tracked calls old enough for a window before it shows up here.</p>`;
    return;
  }

  box.innerHTML = data.sources.map(sourceReliabilityRowHTML).join("");
}

async function fetchSourceReliability() {
  try {
    const res = await fetch("/api/source-reliability");
    renderSourceReliability(await res.json());
  } catch (err) {
    console.error("Failed to load source reliability", err);
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
// The server sends published_ts as UTC epoch seconds (see _fetch_one_news_
// source() in server.py) instead of formatting a display string itself,
// since the server has no way to know the viewer's timezone. toLocaleString()
// with no explicit timeZone option formats in whatever timezone the
// browser/OS is actually set to, so a reader in New York and one in Tokyo
// each see the article's real local time, not a UTC-labeled one. Falls back
// to the server's pre-formatted (UTC) "published" string only for the rare
// malformed feed entry with no parseable date at all.
function formatPublished(article) {
  if (article.published_ts != null) {
    const d = new Date(article.published_ts * 1000);
    return d.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }
  return article.published || "";
}

function renderNews(articles) {
  const list = document.getElementById("newsList");
  if (!articles || articles.length === 0) {
    list.innerHTML = `<p class="loading-row">No news right now.</p>`;
    return;
  }
  list.innerHTML = articles.map(a => `
    <a class="news-card" href="${a.link}" target="_blank" rel="noopener">
      <div class="news-title">${a.title}</div>
      <div class="news-meta"><span class="news-source">${a.source}</span><span>&middot;</span><span>${formatPublished(a)}</span></div>
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

// Signal Track Record card: "By Signal" / "By Source" toggle. Reuses the
// same .tf-tab styling as Top Movers above — this one just swaps which of
// the two bodies (#trackRecordBody / #sourceReliabilityBody) is visible
// instead of re-fetching or re-filtering anything.
const TRACK_RECORD_SUB_TEXT = {
  signal: "Average price change since each coin's Signal was recorded, grouped by what the Signal said at the time — the check on whether Validated calls actually hold up better than Unvalidated ones.",
  source: "Average price change since each news source's coverage first matched a coin, grouped by source — which outlets' calls have actually tended to precede real moves.",
};
const trackRecordTabsEl = document.getElementById("trackRecordTabs");
if (trackRecordTabsEl) {
  trackRecordTabsEl.addEventListener("click", (e) => {
    const tab = e.target.closest(".tf-tab");
    if (!tab) return;
    trackRecordTabsEl.querySelectorAll(".tf-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    document.getElementById("trackRecordBody").style.display = view === "source" ? "none" : "";
    document.getElementById("sourceReliabilityBody").style.display = view === "source" ? "" : "none";
    document.getElementById("trackRecordSub").textContent = TRACK_RECORD_SUB_TEXT[view] || TRACK_RECORD_SUB_TEXT.signal;
  });
}

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
    const cs = document.getElementById("compareSuggestions");
    if (cs) cs.style.display = "none";
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
    initChart(id);
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
  document.getElementById("detailConfidence").textContent = sig.confidence != null ? `${sig.confidence}/100` : "—";

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
// Price History chart (coin detail page)
//
// Real OHLC candles from /api/chart/<id>?range=1d|1m|1y, each one already
// tagged server-side with the Signal status that was in effect at that
// point in time (see attach_signal_history() in server.py) — rendered as
// shaded background bands behind the candlesticks, so you can see e.g. "this
// pump happened while Signal still read Unvalidated" at a glance instead of
// only knowing today's status.
//
// This started as a standalone demo (candlestick-preview.html, fake data,
// no Signal overlay) — the chart-drawing math below is carried over from
// that, with the fake data generator swapped for the real fetch and the
// overlay bands added.
// ---------------------------------------------------------------------------
const CHART_BAND_COLORS = { validated: "var(--up)", mixed: "#ffc94d", unvalidated: "var(--down)" };

let chartCoinId = null;
let chartRange = "1d";
let chartCandles = [];
let chartTimer = null;
let chartLastUpdatedAt = 0;

function formatAxisPrice(n) {
  // Whole dollars round every gridline label to "$0" for sub-$1 coins, so
  // below $1 the axis instead shows to the nearest millionth (6 decimals) —
  // still whole-number-only for anything priced $1 and up.
  if (Math.abs(n) < 1) return "$" + n.toFixed(6);
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatChartDate(ts, range) {
  const d = new Date(ts);
  if (range === "1d") return d.toLocaleTimeString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  if (range === "1m") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", year: "numeric" });
}

function setChartStatus(msg) {
  const el = document.getElementById("chartStatus");
  if (!el) return;
  if (msg) { el.textContent = msg; el.style.display = "flex"; }
  else { el.style.display = "none"; }
}

function renderChart(candles, range) {
  const svg = document.getElementById("chartSvg");
  const yAxis = document.getElementById("chartYAxis");
  const xAxis = document.getElementById("chartXAxis");
  if (!svg) return;

  if (!candles || candles.length === 0) {
    svg.innerHTML = "";
    yAxis.innerHTML = "";
    xAxis.innerHTML = "";
    document.getElementById("chartRangeStats").textContent = "—";
    setChartStatus("No chart data available for this coin.");
    return;
  }
  setChartStatus(null);

  const width = 600, height = 260, padY = 16, padX = 4;
  const n = candles.length;
  const slot = (width - padX * 2) / n;
  const bodyWidth = Math.max(1.5, slot * 0.6);

  const rawHighs = candles.map(c => c[2]);
  const rawLows = candles.map(c => c[3]);
  const rawMin = Math.min(...rawLows), rawMax = Math.max(...rawHighs);
  const rawSpan = (rawMax - rawMin) || 1;
  // Pad the scale a bit so candles don't touch the very top/bottom edge —
  // reads more like a real trading chart.
  const pad = rawSpan * 0.1;
  const minV = rawMin - pad, maxV = rawMax + pad;
  const spanV = maxV - minV;
  const yFor = v => height - padY - ((v - minV) / spanV) * (height - padY * 2);

  chartCandles = candles.map(([t, o, h, l, c, status], i) => ({
    x: padX + slot * i + slot / 2,
    xStart: padX + slot * i,
    xEnd: padX + slot * (i + 1),
    yOpen: yFor(o), yHigh: yFor(h), yLow: yFor(l), yClose: yFor(c),
    t, o, h, l, c, status: status || null,
  }));

  // ---- Signal-history overlay bands ----
  // Consecutive candles that share the same status are merged into one
  // rect instead of one-per-candle, so a multi-candle Validated stretch
  // reads as a single contiguous band rather than a row of separate
  // stripes. Candles with no recorded status (status: null — see the big
  // comment on attach_signal_history() in server.py for why that happens)
  // get no band at all; an unshaded stretch of chart just means "no Signal
  // history recorded for this period" rather than being colored as if it
  // meant something.
  const bands = [];
  for (const p of chartCandles) {
    const last = bands[bands.length - 1];
    if (last && last.status === p.status) last.xEnd = p.xEnd;
    else bands.push({ status: p.status, xStart: p.xStart, xEnd: p.xEnd });
  }
  const bandRectsHTML = bands
    .filter(b => b.status && CHART_BAND_COLORS[b.status])
    .map(b => `<rect x="${b.xStart.toFixed(2)}" y="0" width="${(b.xEnd - b.xStart).toFixed(2)}" height="${height}" fill="${CHART_BAND_COLORS[b.status]}" fill-opacity="0.14"></rect>`)
    .join("");

  // ---- Y-axis: 4 evenly spaced gridlines + price labels ----
  const gridLevels = [0, 1, 2, 3].map(i => minV + (spanV * i) / 3);
  const gridlinesHTML = gridLevels.map(v =>
    `<line class="chart-gridline" x1="0" y1="${yFor(v).toFixed(2)}" x2="${width}" y2="${yFor(v).toFixed(2)}"></line>`
  ).join("");
  yAxis.innerHTML = gridLevels.map(v =>
    `<span style="top:${((yFor(v) / height) * 100).toFixed(2)}%">${formatAxisPrice(v)}</span>`
  ).join("");

  const wicksHTML = chartCandles.map(p => {
    const color = p.c >= p.o ? "var(--up)" : "var(--down)";
    return `<line x1="${p.x.toFixed(2)}" y1="${p.yHigh.toFixed(2)}" x2="${p.x.toFixed(2)}" y2="${p.yLow.toFixed(2)}" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"></line>`;
  }).join("");

  const bodiesHTML = chartCandles.map(p => {
    const color = p.c >= p.o ? "var(--up)" : "var(--down)";
    const top = Math.min(p.yOpen, p.yClose);
    const h = Math.max(1, Math.abs(p.yClose - p.yOpen));
    return `<rect x="${(p.x - bodyWidth / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}"></rect>`;
  }).join("");

  svg.innerHTML = `${bandRectsHTML}${gridlinesHTML}${wicksHTML}${bodiesHTML}<line id="chartCrosshair" class="chart-crosshair" x1="0" y1="0" x2="0" y2="${height}"></line>`;

  // ---- X-axis: 5 evenly spaced date labels ----
  const idxs = [0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1];
  xAxis.innerHTML = idxs.map(i => {
    const p = chartCandles[i];
    const leftPct = (p.x / width) * 100;
    return `<span style="left:${leftPct.toFixed(2)}%">${formatChartDate(p.t, range)}</span>`;
  }).join("");

  document.getElementById("chartRangeStats").textContent = `Low ${formatPrice(rawMin)}  ·  High ${formatPrice(rawMax)}`;
  chartLastUpdatedAt = Date.now();
  document.getElementById("chartUpdated").textContent = "Updated just now";
}

async function loadChart() {
  if (!chartCoinId) return;
  try {
    const res = await fetch(`/api/chart/${encodeURIComponent(chartCoinId)}?range=${chartRange}`);
    if (!res.ok) { setChartStatus("Couldn't load chart data right now."); return; }
    const data = await res.json();
    renderChart(data.candles, data.range || chartRange);
  } catch (err) {
    console.error("Failed to load chart", err);
    setChartStatus("Couldn't load chart data right now.");
  }
}

function startChartAutoRefresh() {
  if (chartTimer) clearInterval(chartTimer);
  // Matches CHART_CACHE_TTL_SECONDS in server.py — refreshing faster than
  // that would just re-request the same cached response, and refreshing
  // much slower would mean sitting on stale-looking data for no reason.
  chartTimer = setInterval(loadChart, 60000);
}

// Ticks the "Updated Xs ago" label every second so it's visible time is
// actually passing between refreshes, not just a static "just now".
setInterval(() => {
  if (!chartCoinId) return;
  const el = document.getElementById("chartUpdated");
  if (!el) return;
  const secs = Math.round((Date.now() - chartLastUpdatedAt) / 1000);
  el.textContent = secs < 2 ? "Updated just now" : `Updated ${secs}s ago`;
}, 1000);

function initChart(id) {
  chartCoinId = id;
  chartRange = "1d";
  loadChart();
  startChartAutoRefresh();
}

function chartPointerMove(e) {
  if (chartCandles.length === 0) return;
  const svg = document.getElementById("chartSvg");
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const vbX = ((clientX - rect.left) / rect.width) * 600;

  let nearest = chartCandles[0];
  let bestDist = Math.abs(nearest.x - vbX);
  for (const p of chartCandles) {
    const d = Math.abs(p.x - vbX);
    if (d < bestDist) { bestDist = d; nearest = p; }
  }

  const crosshair = document.getElementById("chartCrosshair");
  const tooltip = document.getElementById("chartTooltip");
  const plot = document.getElementById("chartPlot");
  if (!crosshair || !tooltip || !plot) return;

  crosshair.setAttribute("x1", nearest.x);
  crosshair.setAttribute("x2", nearest.x);
  crosshair.style.opacity = "1";

  const up = nearest.c >= nearest.o;
  const signalStatus = nearest.status;
  const signalLabel = signalStatus ? SIGNAL_LABELS[signalStatus] : "No Signal history";
  tooltip.innerHTML = `
    <div class="chart-tt-date">${formatChartDate(nearest.t, chartRange)}</div>
    <div class="chart-tt-ohlc">
      <span>O ${formatPrice(nearest.o)}</span>
      <span>H ${formatPrice(nearest.h)}</span>
      <span>L ${formatPrice(nearest.l)}</span>
      <span class="${up ? "up" : "down"}">C ${formatPrice(nearest.c)}</span>
    </div>
    <div class="chart-tt-signal ${signalStatus || "none"}">Signal: ${signalLabel}</div>`;
  tooltip.style.opacity = "1";

  const plotRect = plot.getBoundingClientRect();
  const relX = (nearest.x / 600) * plotRect.width;
  const tooltipWidth = 165;
  const left = Math.max(4, Math.min(plotRect.width - tooltipWidth - 4, relX - tooltipWidth / 2));
  tooltip.style.left = left + "px";
}

function chartPointerLeave() {
  const crosshair = document.getElementById("chartCrosshair");
  const tooltip = document.getElementById("chartTooltip");
  if (crosshair) crosshair.style.opacity = "0";
  if (tooltip) tooltip.style.opacity = "0";
}

const chartPlotEl = document.getElementById("chartPlot");
if (chartPlotEl) {
  chartPlotEl.addEventListener("mousemove", chartPointerMove);
  chartPlotEl.addEventListener("mouseleave", chartPointerLeave);
  chartPlotEl.addEventListener("touchmove", chartPointerMove, { passive: true });
  chartPlotEl.addEventListener("touchend", chartPointerLeave);
}

const chartTfTabsEl = document.getElementById("chartTfTabs");
if (chartTfTabsEl) {
  chartTfTabsEl.addEventListener("click", (e) => {
    const tab = e.target.closest(".chart-tf-tab");
    if (!tab) return;
    document.querySelectorAll("#chartTfTabs .chart-tf-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    chartRange = tab.dataset.range;
    loadChart();
  });
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
// Coin Comparison (/compare) — frontend-only, reuses /api/coin/<id> and
// /api/search (no new backend). Pick 2-3 coins, see Price / 24h change /
// Market Cap / Volume / Volume-Mcap ratio / Signal / Confidence / Matched
// News side by side. Deliberately does NOT include the candlestick chart —
// the chart module above (renderChart(), initChart(), etc.) is built around
// a single global instance (one #chartSvg, one chartCoinId), and supporting
// 2-3 simultaneous charts would need a real refactor of that module rather
// than just reusing it here.
//
// Selected coins live in the URL (?coins=a,b,c) via history.replaceState,
// not localStorage — so a comparison is shareable as a link, and a page
// refresh keeps it, but it doesn't linger as hidden state on other visits.
// ---------------------------------------------------------------------------
let compareIds = [];

function updateCompareUrl() {
  const url = compareIds.length ? `/compare?coins=${compareIds.map(encodeURIComponent).join(",")}` : "/compare";
  history.replaceState(null, "", url);
}

function renderCompareChips() {
  const box = document.getElementById("compareChips");
  if (!box) return;
  if (compareIds.length === 0) {
    box.innerHTML = `<p class="compare-chips-empty">No coins added yet.</p>`;
    return;
  }
  box.innerHTML = compareIds.map(id => {
    const coin = coinsById.get(id);
    return `
      <div class="compare-chip">
        ${coin ? coinDotHTML(coin, "sm") : ""}
        <span>${coin ? coin.name : id}</span>
        <button class="compare-chip-remove" data-id="${id}" title="Remove">&#10005;</button>
      </div>`;
  }).join("");
}

function compareMetricRowHTML(label, cellsHTML) {
  return `
    <div class="compare-row">
      <div class="compare-row-label">${label}</div>
      ${cellsHTML}
    </div>`;
}

function renderCompareTable() {
  const wrap = document.getElementById("compareTableWrap");
  if (!wrap) return;

  if (compareIds.length < 2) {
    wrap.innerHTML = `<p class="loading-row">Add at least 2 coins above to compare.</p>`;
    return;
  }

  const coins = compareIds.map(id => coinsById.get(id)).filter(Boolean);
  if (coins.length < compareIds.length) {
    wrap.innerHTML = `<p class="loading-row">Loading&hellip;</p>`;
    return;
  }

  const headerCells = coins.map(c => `
    <div class="compare-col-head">
      ${coinDotHTML(c, "sm")}
      <div>
        <div class="compare-col-name">${c.name}</div>
        <div class="compare-col-sym">${(c.symbol || "").toUpperCase()}</div>
      </div>
    </div>`).join("");

  const priceCells = coins.map(c => `<div class="compare-cell mono">${formatPrice(c.current_price)}</div>`).join("");
  const changeCells = coins.map(c => `<div class="compare-cell">${changeHTML(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h)}</div>`).join("");
  const mcapCells = coins.map(c => `<div class="compare-cell mono">${formatCap(c.market_cap)}</div>`).join("");
  const volCells = coins.map(c => `<div class="compare-cell mono">${formatCap(c.total_volume)}</div>`).join("");
  const ratioCells = coins.map(c => {
    const r = c.signal ? ((c.signal.vol_ratio ?? 0) * 100).toFixed(2) + "%" : "—";
    return `<div class="compare-cell mono">${r}</div>`;
  }).join("");
  const signalCells = coins.map(c => {
    const sig = c.signal;
    return `<div class="compare-cell">${sig ? `<span class="signal-badge ${sig.status}"><span class="signal-dot"></span>${SIGNAL_LABELS[sig.status] || "Unvalidated"}</span>` : "—"}</div>`;
  }).join("");
  const confidenceCells = coins.map(c => {
    const sig = c.signal;
    return `<div class="compare-cell mono">${sig && sig.confidence != null ? `${sig.confidence}/100` : "—"}</div>`;
  }).join("");
  const newsCells = coins.map(c => {
    const sig = c.signal || {};
    return `<div class="compare-cell compare-cell-news">${sig.source
      ? `<a href="${sig.source_link || "#"}" target="_blank" rel="noopener">${sig.source_title || "Matching article"}</a><span class="compare-news-source">${sig.source}</span>`
      : `<span class="compare-cell-empty">No matching coverage</span>`}</div>`;
  }).join("");

  wrap.innerHTML = `
    <div class="compare-grid" style="--compare-cols:${coins.length}">
      <div class="compare-row compare-row-head">
        <div class="compare-row-label"></div>
        ${headerCells}
      </div>
      ${compareMetricRowHTML("Price", priceCells)}
      ${compareMetricRowHTML("24h Change", changeCells)}
      ${compareMetricRowHTML("Market Cap", mcapCells)}
      ${compareMetricRowHTML("24h Volume", volCells)}
      ${compareMetricRowHTML("Volume / Mcap", ratioCells)}
      ${compareMetricRowHTML("Signal", signalCells)}
      ${compareMetricRowHTML("Confidence", confidenceCells)}
      ${compareMetricRowHTML("Matched News", newsCells)}
    </div>`;
}

// A coin added to the comparison might be outside liveCoins entirely (same
// situation as a watchlisted long-tail coin — see ensureWatchlistCoinsLoaded
// above), so it's fetched individually via /api/coin/<id> rather than
// assumed to already be in coinsById.
async function loadCompareCoins() {
  document.getElementById("compareTableWrap").innerHTML = `<p class="loading-row">Loading&hellip;</p>`;
  await Promise.all(compareIds.map(async id => {
    if (coinsById.has(id)) return;
    try {
      const res = await fetch(`/api/coin/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const coin = await res.json();
      if (coin && coin.id) extraCoins.set(coin.id, coin);
    } catch (err) { console.error("Failed to load a coin for comparison", err); }
  }));
  rebuildCoinIndex();
  renderCompareChips();
  renderCompareTable();
}

function addCompareCoin(id) {
  if (!id || compareIds.includes(id) || compareIds.length >= 3) return;
  compareIds.push(id);
  updateCompareUrl();
  renderCompareChips();
  loadCompareCoins();
}

function removeCompareCoin(id) {
  compareIds = compareIds.filter(x => x !== id);
  updateCompareUrl();
  renderCompareChips();
  renderCompareTable();
}

// Debounced search into #compareSuggestions — same server-side /api/search
// endpoint and pattern as the dashboard's own search (see renderSuggestions
// above), kept as a separate function/timer/request-id set so the two search
// boxes on different routes never share or clobber each other's state.
let compareSearchDebounceTimer = null;
let compareSearchRequestId = 0;

function renderCompareSuggestions(query) {
  const box = document.getElementById("compareSuggestions");
  if (!box) return;
  clearTimeout(compareSearchDebounceTimer);

  if (!query) { box.style.display = "none"; box.innerHTML = ""; return; }

  const thisRequestId = ++compareSearchRequestId;
  compareSearchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const matches = await res.json();
      if (thisRequestId !== compareSearchRequestId) return; // a newer keystroke already superseded this

      const filtered = matches.filter(c => !compareIds.includes(c.id));
      if (filtered.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }

      filtered.forEach(c => extraCoins.set(c.id, c));
      rebuildCoinIndex();

      box.innerHTML = filtered.map(c => `
        <div class="suggestion-item" data-id="${c.id}">
          <span class="sugg-left">${coinDotHTML(c, "sm")}<span class="sugg-name">${c.name}</span></span>
          <span class="sym">${(c.symbol || "").toUpperCase()}</span>
        </div>`).join("");
      box.style.display = "block";
    } catch (err) {
      console.error("Compare search failed", err);
    }
  }, 200);
}

const compareSearchInputEl = document.getElementById("compareSearchInput");
const compareSuggestionsEl = document.getElementById("compareSuggestions");
const compareChipsEl = document.getElementById("compareChips");

if (compareSearchInputEl) {
  compareSearchInputEl.addEventListener("input", (e) => renderCompareSuggestions(e.target.value.trim()));
}
if (compareSuggestionsEl) {
  compareSuggestionsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".suggestion-item");
    if (!item) return;
    compareSearchInputEl.value = "";
    compareSuggestionsEl.style.display = "none";
    addCompareCoin(item.dataset.id);
  });
}
if (compareChipsEl) {
  compareChipsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".compare-chip-remove");
    if (btn) removeCompareCoin(btn.dataset.id);
  });
}

function initCompare() {
  const params = new URLSearchParams(location.search);
  compareIds = (params.get("coins") || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);
  renderCompareChips();
  if (compareIds.length > 0) loadCompareCoins();
  else renderCompareTable();
}

// ---------------------------------------------------------------------------
// Init — routes to either the live dashboard or a single coin's detail page
// based on the URL, since both share this one script.js / index.html.
// ---------------------------------------------------------------------------
function initDashboard() {
  fetchLivePrices();
  fetchNewsList();
  fetchTrackRecord();
  fetchSourceReliability();

  // Search no longer needs a periodic full-list fetch at all — it queries
  // the server on demand instead (see the Search section above). Prices
  // don't move fast enough on a research dashboard to need a 3-second
  // refresh, so that's backed off too.
  setInterval(fetchLivePrices, 15000);
  setInterval(fetchNewsList, 300000);
  setInterval(fetchTrackRecord, 300000); // changes slowly — snapshots are only taken every few hours
  setInterval(fetchSourceReliability, 300000); // same cadence — new source_calls rows land on the same news-refresh cycle
}

// Highlights whichever nav link matches the current page, instead of
// "Dashboard" being hardcoded active in the HTML regardless of route. A
// coin detail page (/coin/<id>) isn't its own nav item — it's reached FROM
// the dashboard, not a separate section — so it highlights Dashboard too,
// same as "/" itself.
function updateNavActiveState() {
  const path = location.pathname;
  const activeHref = (path === "/compare" || path === "/how-it-works") ? path : "/";
  document.querySelectorAll(".nav-link").forEach(link => {
    link.classList.toggle("active", link.getAttribute("href") === activeHref);
  });
}

function init() {
  updateNavActiveState();
  const match = location.pathname.match(/^\/coin\/([^/]+)/);
  if (match) {
    document.getElementById("dashboardView").style.display = "none";
    document.getElementById("coinDetailView").style.display = "block";
    initCoinDetail(decodeURIComponent(match[1]));
  } else if (location.pathname === "/compare") {
    document.getElementById("dashboardView").style.display = "none";
    document.getElementById("compareView").style.display = "block";
    initCompare();
  } else if (location.pathname === "/how-it-works") {
    document.getElementById("dashboardView").style.display = "none";
    document.getElementById("howItWorksView").style.display = "block";
    document.title = "How Signal Works — Sift";
  } else {
    initDashboard();
  }
}

document.addEventListener("DOMContentLoaded", init);