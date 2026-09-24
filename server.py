from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
import requests
import threading
import time
import re
import feedparser
import os
import sqlite3

load_dotenv()

app = Flask(__name__)
CORS(app)

API_KEY = os.getenv("COINGECKO_API_KEY")

cached_coins = []       # every coin CoinGecko gives us, each with a "signal" field attached
cached_news = []
cached_global = {}      # total market cap / volume / btc dominance, from CoinGecko's /global

# Overridable so test_server.py can point at a throwaway file instead of the
# real one — see the SIGNAL_HISTORY_DB env var there.
DB_PATH = os.getenv(
    "SIGNAL_HISTORY_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "signal_history.db")
)

NEWS_SOURCES = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
    ("The Block", "https://www.theblock.co/rss.xml"),
    ("Decrypt", "https://decrypt.co/feed"),
    ("CryptoSlate", "https://cryptoslate.com/feed/"),
    ("Bitcoin Magazine", "https://bitcoinmagazine.com/feed"),
    ("NewsBTC", "https://www.newsbtc.com/feed/"),
    ("CryptoPotato", "https://cryptopotato.com/feed/"),
]

# ---------------------------------------------------------------------------
# Signal Score: Validated / Mixed / Unvalidated
#
# First real pass at this. Two things it checks, both from data we already
# have cached — no new API keys or paid data needed:
#   1. Does trading volume actually back up the price move? (volume / market
#      cap ratio — a big move on very little volume is a red flag)
#   2. Does real news coverage (CoinDesk / Cointelegraph, already scraped
#      below) actually mention this coin?
#
# This is intentionally simple and will get better over time — it does NOT
# do real sentiment/bot detection yet (that needs paid social data, which
# we've deliberately scoped out for now). Thresholds are a starting guess,
# easy to tune once we see how it behaves on real data.
# ---------------------------------------------------------------------------
HIGH_VOLUME_RATIO = 0.08   # 8%+ of market cap traded in 24h = real activity
LOW_VOLUME_RATIO = 0.02    # under 2% = thin/quiet trading

# ---------------------------------------------------------------------------
# Coin coverage: a "live" hot set + a slow, complete search index
#
# Early on, cached_coins held ~5000 coins (20 CoinGecko pages), refetched
# every 60 seconds, and doubled as both the dashboard's live data AND the
# search index — the frontend downloaded that entire list on a timer just to
# power the search box. On Render's 512MB Starter plan that's what pushed the
# service over its memory limit.
#
# The fix is to stop conflating "what's live on the dashboard" with "what's
# searchable." Those are now two different things:
#   - cached_coins (below) is the small, frequently-refreshed hot set behind
#     the table / Top Movers / Watchlist / Track Record — it only needs to
#     comfortably cover the top ~300 the dashboard actually displays.
#   - coin_index (a SQLite table, see init_db()) holds CoinGecko's entire
#     coin list — ~21,500 coins as of writing — refreshed slowly in the
#     background by refresh_full_coin_index(). Search queries hit this table
#     directly and return a handful of matches, so browsers never download
#     more than a few coins at a time no matter how big the searchable
#     universe is.
# ---------------------------------------------------------------------------
LIVE_COIN_PAGES = 3              # 750 coins — headroom above the top 300 actually shown live
FULL_INDEX_PAGE_DELAY = 4        # seconds between pages while building the full index (rate-limit pacing — see below)
FULL_INDEX_REFRESH_HOURS = 6


def find_matching_news(name, symbol, news_list):
    """Look for a cached news article that actually mentions this coin."""
    name = (name or "").strip()
    symbol = (symbol or "").strip()

    name_pattern = re.compile(r"\b" + re.escape(name) + r"\b", re.IGNORECASE) if name else None
    # Only match on symbol if it's not a super short/common string (avoids
    # "S" or "ID" matching random words in headlines).
    symbol_pattern = re.compile(r"\b" + re.escape(symbol) + r"\b", re.IGNORECASE) if len(symbol) >= 3 else None

    for article in news_list:
        title = article.get("title", "")
        if name_pattern and name_pattern.search(title):
            return article
        if symbol_pattern and symbol_pattern.search(title):
            return article
    return None


def compute_signal(coin, news_list):
    market_cap = coin.get("market_cap") or 0
    volume = coin.get("total_volume") or 0
    vol_ratio = (volume / market_cap) if market_cap else 0

    volume_backs = vol_ratio >= HIGH_VOLUME_RATIO
    volume_thin = vol_ratio < LOW_VOLUME_RATIO

    matched = find_matching_news(coin.get("name"), coin.get("symbol"), news_list)
    has_news = matched is not None

    if volume_backs and has_news:
        status = "validated"
        reason = "Volume backs the move, and coverage matches"
    elif volume_backs and not has_news:
        status = "mixed"
        reason = "Volume backs the move, but no matching coverage found"
    elif has_news and not volume_thin:
        status = "mixed"
        reason = "Coverage matches, but volume doesn't fully confirm the move"
    else:
        status = "unvalidated"
        # has_news can still be true here (real coverage exists, but volume is
        # too thin to call it backed) — the reason text needs to say so, since
        # this is exactly the case the "Quiet Coverage" panel on the dashboard
        # surfaces, and an inaccurate reason here would undercut it.
        reason = (
            "Coverage exists, but volume is too thin to confirm the move"
            if has_news else
            "Move isn't backed by volume, and no matching coverage found"
        )

    return {
        "status": status,
        "reason": reason,
        "source": matched["source"] if matched else None,
        "source_link": matched["link"] if matched else None,
        "source_title": matched["title"] if matched else None,
        "volume": volume,
        "market_cap": market_cap,
        "vol_ratio": vol_ratio,
        "threshold_high": HIGH_VOLUME_RATIO,
        "threshold_low": LOW_VOLUME_RATIO,
    }


def compute_all_signals():
    """Re-tag every cached coin with a fresh signal. Cheap even at a few
    thousand coins x ~15 articles, so it's fine to just recompute in full
    whenever prices or news change."""
    for coin in cached_coins:
        coin["signal"] = compute_signal(coin, cached_news)


# ---------------------------------------------------------------------------
# Signal Track Record
#
# The credibility question underneath the whole product: do "Validated"
# calls actually go on to perform better than "Unvalidated" ones, or is the
# badge just noise? To answer that we need to remember what a coin's signal
# *was* at some point in the past, then compare its price then to its price
# now. That's a time-series problem the in-memory caches above can't answer
# (they only ever hold "right now"), so this gets its own small SQLite table
# that survives independently of the coin/news caches.
#
# A snapshot is taken periodically (every few hours) for the top coins by
# market cap — not all ~5000, since most of those are thin enough that
# nobody's watching them and the table would grow forever for no benefit.
# ---------------------------------------------------------------------------
SNAPSHOT_TOP_N = 500
SNAPSHOT_RETENTION_DAYS = 120
TRACK_RECORD_WINDOWS_DAYS = [3, 7, 14, 30]
TRACK_RECORD_MIN_SAMPLES = 3   # per status, per window, before we'll show it


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS signal_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            coin_id TEXT NOT NULL,
            symbol TEXT,
            name TEXT,
            status TEXT NOT NULL,
            price REAL,
            market_cap REAL,
            ts INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_coin_ts ON signal_snapshots (coin_id, ts)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS coin_index (
            id TEXT PRIMARY KEY,
            symbol TEXT,
            name TEXT,
            image TEXT,
            current_price REAL,
            market_cap REAL,
            total_volume REAL,
            price_change_percentage_24h REAL,
            updated_at INTEGER
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_coin_index_name ON coin_index (name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_coin_index_symbol ON coin_index (symbol)")
    conn.commit()
    conn.close()


def snapshot_signals():
    """Record the current signal + price for the top N coins by market cap.
    Called on a loop, and once at startup if we haven't snapshotted recently."""
    if not cached_coins:
        return

    now = int(time.time())
    top = sorted(cached_coins, key=lambda c: c.get("market_cap") or 0, reverse=True)[:SNAPSHOT_TOP_N]
    rows = [
        (c["id"], c.get("symbol"), c.get("name"), c["signal"]["status"], c.get("current_price"), c.get("market_cap"), now)
        for c in top
        if c.get("signal") and c.get("current_price") is not None
    ]
    if not rows:
        return

    conn = sqlite3.connect(DB_PATH)
    conn.executemany(
        "INSERT INTO signal_snapshots (coin_id, symbol, name, status, price, market_cap, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows
    )
    conn.execute("DELETE FROM signal_snapshots WHERE ts < ?", (now - SNAPSHOT_RETENTION_DAYS * 86400,))
    conn.commit()
    conn.close()
    print(f"Signal snapshot recorded: {len(rows)} coins.")


def snapshot_on_start_if_stale():
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT MAX(ts) FROM signal_snapshots").fetchone()
    conn.close()
    last_ts = row[0] if row else None
    if not last_ts or (time.time() - last_ts) > 3600:
        snapshot_signals()


def compute_track_record():
    """For each window (3/7/14/30 days), find each coin's most recent snapshot
    at least that old, bucket those snapshots by the status they had back
    then, and compare that snapshot's price to the coin's current price.
    A window is only included once we actually have snapshots that old, and
    a status bucket within it is only included once it has enough samples
    to not just be noise from one or two coins."""
    now = int(time.time())
    current_price_by_id = {c["id"]: c.get("current_price") for c in cached_coins}

    conn = sqlite3.connect(DB_PATH)
    oldest_row = conn.execute("SELECT MIN(ts) FROM signal_snapshots").fetchone()
    oldest_ts = oldest_row[0] if oldest_row else None
    oldest_age_days = round((now - oldest_ts) / 86400, 1) if oldest_ts else 0

    windows = []
    for days in TRACK_RECORD_WINDOWS_DAYS:
        cutoff = now - days * 86400
        if not oldest_ts or oldest_ts > cutoff:
            continue  # no snapshot exists that's old enough yet

        # Most recent snapshot per coin, among snapshots old enough for this window.
        rows = conn.execute("""
            SELECT coin_id, status, price FROM (
                SELECT coin_id, status, price, ts,
                       ROW_NUMBER() OVER (PARTITION BY coin_id ORDER BY ts DESC) AS rn
                FROM signal_snapshots
                WHERE ts <= ?
            ) WHERE rn = 1
        """, (cutoff,)).fetchall()

        buckets = {"validated": [], "mixed": [], "unvalidated": []}
        for coin_id, status, then_price in rows:
            now_price = current_price_by_id.get(coin_id)
            if now_price is None or not then_price:
                continue
            pct_change = ((now_price - then_price) / then_price) * 100
            if status in buckets:
                buckets[status].append(pct_change)

        window_out = {}
        for status, changes in buckets.items():
            if len(changes) >= TRACK_RECORD_MIN_SAMPLES:
                window_out[status] = {
                    "avg_change_pct": round(sum(changes) / len(changes), 2),
                    "count": len(changes),
                }
        if window_out:
            windows.append({"days": days, **window_out})

    conn.close()
    return {
        "ready": len(windows) > 0,
        "oldest_snapshot_days": oldest_age_days,
        "windows": windows,
    }


def compute_coin_track_record(coin_id):
    """The single-coin version of the same idea: instead of averaging across
    many coins (which needs a minimum sample size to mean anything), this
    just shows exactly what happened for THIS coin — what its Signal read at
    each past checkpoint, and what its price has done since. No MIN_SAMPLES
    gate here, since a single coin's own history isn't being used to make a
    statistical claim, just a factual one ("here's what happened")."""
    now = int(time.time())
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT status, price, ts FROM signal_snapshots WHERE coin_id = ? ORDER BY ts ASC",
        (coin_id,)
    ).fetchall()
    conn.close()

    if not rows:
        return {"has_history": False}

    status_counts = {"validated": 0, "mixed": 0, "unvalidated": 0}
    for status, price, ts in rows:
        if status in status_counts:
            status_counts[status] += 1
    total = len(rows)
    status_pct = {
        status: round((count / total) * 100)
        for status, count in status_counts.items()
        if count > 0
    }

    oldest_age_days = round((now - rows[0][2]) / 86400, 1)
    current_price = next((c.get("current_price") for c in cached_coins if c["id"] == coin_id), None)

    windows = []
    if current_price is not None:
        for days in TRACK_RECORD_WINDOWS_DAYS:
            cutoff = now - days * 86400
            # Most recent snapshot for this coin that's at least this old.
            candidate = None
            for status, price, ts in reversed(rows):
                if ts <= cutoff:
                    candidate = (status, price)
                    break
            if not candidate or not candidate[1]:
                continue
            status, then_price = candidate
            pct_change = ((current_price - then_price) / then_price) * 100
            windows.append({"days": days, "status": status, "change_pct": round(pct_change, 2)})

    return {
        "has_history": True,
        "oldest_snapshot_days": oldest_age_days,
        "total_snapshots": total,
        "status_pct": status_pct,
        "windows": windows,
    }


def snapshot_refresh_loop():
    while True:
        time.sleep(6 * 3600)
        snapshot_signals()


def fetch_all_coins():
    global cached_coins
    all_coins = []
    for page in range(1, LIVE_COIN_PAGES + 1):
        response = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": 250,
                "page": page,
                # Adds price_change_percentage_1h_in_currency / _24h_in_currency /
                # _7d_in_currency to every coin, needed for the Top Movers timeframes.
                "price_change_percentage": "1h,24h,7d",
                "x_cg_demo_api_key": API_KEY
            }
        )
        if response.status_code != 200:
            print("Stopped at page", page, "- status:", response.status_code)
            break
        data = response.json()
        all_coins = all_coins + data

    if not all_coins:
        # A failed or rate-limited fetch shouldn't wipe out perfectly good
        # data from the last successful cycle — that would blank out the
        # whole dashboard because of one bad refresh. Keep showing the last
        # good data and just try again in 60s.
        print("Price refresh got no data this cycle (likely rate-limited) — keeping previous", len(cached_coins), "cached coins")
        return

    cached_coins = all_coins
    compute_all_signals()
    print("Price cache refreshed. Total coins cached:", len(cached_coins))


def refresh_full_coin_index():
    """Pages through CoinGecko's ENTIRE coin list — not just the small live
    hot set above — and upserts it into the coin_index SQLite table, so
    /api/search and /api/coin/<id> can find any of the ~21,500 coins
    CoinGecko tracks without holding all of them in memory or shipping them
    to every browser tab (that full-list-in-memory-and-over-the-wire pattern
    is what caused the earlier memory limit outage).

    This is deliberately paced slowly — one page (250 coins) every
    FULL_INDEX_PAGE_DELAY seconds — rather than fetched as fast as possible.
    CoinGecko's free Demo API key allows 30 calls/minute total, and that
    budget is shared with price_refresh_loop and global_refresh_loop, which
    are also running concurrently. At the default 4-second delay this job
    uses ~15 calls/minute on its own, leaving comfortable headroom for the
    other loops, and a full pass across ~90 pages takes roughly 6 minutes —
    fine for something that only needs to run every few hours, since a
    long-tail coin's price doesn't need to be fresher than that to be
    searchable and to have a working detail page."""
    page = 1
    total = 0
    conn = sqlite3.connect(DB_PATH)
    try:
        while True:
            response = requests.get(
                "https://api.coingecko.com/api/v3/coins/markets",
                params={
                    "vs_currency": "usd",
                    "order": "market_cap_desc",
                    "per_page": 250,
                    "page": page,
                    "x_cg_demo_api_key": API_KEY
                }
            )
            if response.status_code == 429:
                # Rate-limited — back off and retry the same page rather than
                # giving up on the rest of the index. This job already runs
                # slowly on purpose (see FULL_INDEX_PAGE_DELAY); an occasional
                # 429 from sharing the rate limit with the live price/global
                # loops is expected, not fatal.
                print("Full coin index rate-limited on page", page, "- backing off 30s")
                time.sleep(30)
                continue
            if response.status_code != 200:
                print("Full coin index stopped at page", page, "- status:", response.status_code)
                break
            data = response.json()
            if not data:
                break

            now = int(time.time())
            rows = [
                (c["id"], c.get("symbol"), c.get("name"), c.get("image"),
                 c.get("current_price"), c.get("market_cap"), c.get("total_volume"),
                 c.get("price_change_percentage_24h"), now)
                for c in data
            ]
            conn.executemany("""
                INSERT INTO coin_index (id, symbol, name, image, current_price, market_cap, total_volume, price_change_percentage_24h, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    symbol=excluded.symbol,
                    name=excluded.name,
                    image=excluded.image,
                    current_price=excluded.current_price,
                    market_cap=excluded.market_cap,
                    total_volume=excluded.total_volume,
                    price_change_percentage_24h=excluded.price_change_percentage_24h,
                    updated_at=excluded.updated_at
            """, rows)
            conn.commit()
            total += len(rows)
            page += 1
            time.sleep(FULL_INDEX_PAGE_DELAY)
    finally:
        conn.close()
    print(f"Full coin index refreshed: {total} coins across {page - 1} pages.")


def full_index_refresh_loop():
    # Give initial_load() (the live hot-set fetch that the dashboard actually
    # needs to render anything) a head start before this starts competing for
    # CoinGecko's rate limit — getting real data on screen fast matters more
    # at startup than the full search index being ready a minute sooner.
    time.sleep(90)
    while True:
        refresh_full_coin_index()
        time.sleep(FULL_INDEX_REFRESH_HOURS * 3600)


def fetch_global():
    global cached_global
    response = requests.get(
        "https://api.coingecko.com/api/v3/global",
        params={"x_cg_demo_api_key": API_KEY}
    )
    if response.status_code != 200:
        print("Global stats fetch failed - status:", response.status_code)
        return
    data = response.json().get("data", {})
    cached_global = {
        "total_market_cap_usd": data.get("total_market_cap", {}).get("usd"),
        "total_volume_usd": data.get("total_volume", {}).get("usd"),
        "btc_dominance": data.get("market_cap_percentage", {}).get("btc"),
        "market_cap_change_24h": data.get("market_cap_change_percentage_24h_usd"),
    }
    print("Global stats refreshed.")


def fetch_news():
    global cached_news
    all_articles = []

    for source_name, feed_url in NEWS_SOURCES:
        feed = feedparser.parse(feed_url)
        for entry in feed.entries:
            all_articles.append({
                "title": entry.get("title", "Untitled"),
                "link": entry.get("link", ""),
                "source": source_name,
                "published": entry.get("published", ""),
                "published_parsed": entry.get("published_parsed") or time.gmtime(0)
            })

    all_articles.sort(key=lambda article: article["published_parsed"], reverse=True)

    cached_news = []
    for article in all_articles[:30]:
        cached_news.append({
            "title": article["title"],
            "link": article["link"],
            "source": article["source"],
            "published": article["published"]
        })

    compute_all_signals()  # news changed, so signals might too
    print("News cache refreshed. Total articles cached:", len(cached_news))


def price_refresh_loop():
    while True:
        time.sleep(60)
        fetch_all_coins()


def global_refresh_loop():
    while True:
        time.sleep(60)
        fetch_global()


def news_refresh_loop():
    while True:
        time.sleep(300)
        fetch_news()


@app.route("/")
def home():
    return app.send_static_file("index.html")


@app.route("/coin/<coin_id>")
def coin_detail_page(coin_id):
    # Same single-page app shell — script.js reads the URL and renders the
    # per-coin breakdown view instead of the dashboard. This route's only job
    # is making sure a direct link or a page refresh on /coin/<id> works.
    return app.send_static_file("index.html")


@app.route("/api/prices")
def get_prices():
    limit = request.args.get("limit", type=int)
    if limit:
        return jsonify(cached_coins[:limit])
    return jsonify(cached_coins)


@app.route("/api/search")
def search_coins():
    """Server-side search over the full coin_index table (every coin
    CoinGecko tracks), so the browser never has to hold or download the
    whole list — only the handful of matches. Exact symbol/name matches are
    ranked first, then everything else by market cap."""
    q = (request.args.get("q") or "").strip()
    limit = request.args.get("limit", type=int) or 8
    if not q:
        return jsonify([])

    like = f"%{q}%"
    q_lower = q.lower()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, symbol, name, image, current_price, market_cap, total_volume, price_change_percentage_24h
        FROM coin_index
        WHERE name LIKE ? OR symbol LIKE ?
        ORDER BY
            CASE
                WHEN LOWER(symbol) = ? THEN 0
                WHEN LOWER(name) = ? THEN 1
                ELSE 2
            END,
            market_cap DESC
        LIMIT ?
    """, (like, like, q_lower, q_lower, limit)).fetchall()
    conn.close()

    results = []
    for row in rows:
        coin = dict(row)
        coin["signal"] = compute_signal(coin, cached_news)
        results.append(coin)
    return jsonify(results)


@app.route("/api/coin/<coin_id>")
def get_coin(coin_id):
    """Look up a single coin by id, for the coin detail page. Checks the
    live hot set first (fresher price, refreshed every 60s) and falls back
    to the full coin_index (refreshed every few hours) for anything outside
    it — so every coin CoinGecko tracks has a working detail page, just with
    a price that can be up to a few hours old for long-tail coins."""
    coin = next((c for c in cached_coins if c["id"] == coin_id), None)
    if coin:
        return jsonify(coin)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, symbol, name, image, current_price, market_cap, total_volume, price_change_percentage_24h FROM coin_index WHERE id = ?",
        (coin_id,)
    ).fetchone()
    conn.close()

    if not row:
        return jsonify(None), 404

    coin = dict(row)
    coin["signal"] = compute_signal(coin, cached_news)
    return jsonify(coin)


@app.route("/api/news")
def get_news():
    return jsonify(cached_news)


@app.route("/api/global")
def get_global():
    return jsonify(cached_global)


@app.route("/api/track-record")
def get_track_record():
    return jsonify(compute_track_record())


@app.route("/api/track-record/<coin_id>")
def get_coin_track_record(coin_id):
    return jsonify(compute_coin_track_record(coin_id))


def initial_load():
    """Everything needed before the dashboard has real data, run on a
    background thread instead of blocking here at import time. Previously
    these ran synchronously before app.run() — meaning Flask didn't start
    listening on its port until ~20 sequential CoinGecko requests had all
    finished. On Render, the platform expects the port to open quickly; a
    slow or rate-limited CoinGecko response during that window could stall
    startup long enough to look like the service never came up, then get
    restarted mid-fetch — repeating the same slow startup each time. Running
    it in the background lets Flask bind the port immediately, so Render's
    health check passes right away and the site is reachable (just with
    "Loading…" states) while this fills in a few seconds later."""
    fetch_all_coins()
    fetch_global()
    fetch_news()
    snapshot_on_start_if_stale()


# init_db() only does local SQLite table setup — no network calls — so unlike
# the fetches above it's fast enough to run synchronously here. That also
# avoids a startup race: full_index_refresh_loop (below) writes to the
# coin_index table from its very first tick, so that table needs to exist
# before its thread starts, not "eventually" once initial_load() gets to it.
init_db()

threading.Thread(target=initial_load, daemon=True).start()
threading.Thread(target=price_refresh_loop, daemon=True).start()
threading.Thread(target=global_refresh_loop, daemon=True).start()
threading.Thread(target=news_refresh_loop, daemon=True).start()
threading.Thread(target=snapshot_refresh_loop, daemon=True).start()
threading.Thread(target=full_index_refresh_loop, daemon=True).start()

if __name__ == "__main__":
    # debug=True was left on from local development — it should never run on
    # a publicly deployed service: besides the extra memory overhead, Flask's
    # debug mode exposes an interactive in-browser debugger on any unhandled
    # error, which lets whoever triggers that error run arbitrary code on the
    # server. debug=False here as well as on Render.
    app.run(debug=False, use_reloader=False)