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
import resource
import gc
import calendar
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

load_dotenv()

app = Flask(__name__)
CORS(app)

START_TIME = time.time()

# Every outbound requests.get() call below uses this. Without an explicit
# timeout, requests will wait forever on a connection that hangs — one slow
# response from CoinGecko or an RSS host would block whichever refresh loop
# made the call for good, silently freezing that data instead of erroring
# and trying again next cycle like a normal failure does.
REQUEST_TIMEOUT_SECONDS = 15

API_KEY = os.getenv("COINGECKO_API_KEY")

# Paid CoinGecko plans (Basic and up) are a completely separate API from the
# free Demo tier — different root URL, different auth. Demo used
# api.coingecko.com with the key as a query param (x_cg_demo_api_key); paid
# plans use pro-api.coingecko.com with the key as a header instead. The two
# are not interchangeable — a Demo key against the Pro URL (or vice versa)
# just fails, which is exactly what happened here right after upgrading,
# since the code was still built for the old free endpoint/key combo.
COINGECKO_BASE_URL = "https://pro-api.coingecko.com/api/v3"
COINGECKO_HEADERS = {"x-cg-pro-api-key": API_KEY}

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
    # Added for broader mid/small-cap altcoin coverage — the original 8 sources
    # lean toward headline BTC/ETH stories that every outlet covers anyway.
    # A coin's Signal reads "no matching coverage found" only because these
    # sources happened to miss it, so wider coverage means fewer incorrect
    # Unvalidated calls on smaller coins that do have real coverage elsewhere.
    ("BeInCrypto", "https://beincrypto.com/feed/"),
    ("U.Today", "https://u.today/rss"),
    ("Blockworks", "https://blockworks.com/feed"),
    # Second round — picked for actually distinct coverage rather than more
    # of the same headline stories: CoinGape/crypto.news/ZyCrypto all run high
    # volumes of smaller-ticker stories daily; DL News leans DeFi/institutional,
    # a genuinely different angle from everything else on this list.
    ("CoinGape", "https://coingape.com/feed/"),
    ("crypto.news", "https://crypto.news/feed/"),
    ("ZyCrypto", "https://zycrypto.com/feed/"),
    ("DL News", "https://www.dlnews.com/arc/outboundfeeds/rss/"),
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

# These intervals are sized against CoinGecko's paid Basic plan budget:
# 100,000 credits/month, 300 calls/min. Each /coins/markets or /global call
# costs 1 credit regardless of per_page, so credits/month is just calls/month.
# At the old 60-second price/global intervals plus a 6-hour full index
# rebuild, this app was on track to use ~226,000 credits/month — more than
# double even the PAID budget, not just the free Demo one. These numbers
# instead target roughly 60,000/month combined, leaving real headroom:
#   price  (3 calls/cycle,  every 180s) -> ~480 cycles/day -> ~43,200/mo
#   global (1 call/cycle,   every 300s) -> ~288 cycles/day ->  ~8,640/mo
#   full index (~86 pages,  every 8h)   ->    3 passes/day ->  ~7,740/mo
PRICE_REFRESH_INTERVAL_SECONDS = 180
GLOBAL_REFRESH_INTERVAL_SECONDS = 300
FULL_INDEX_PAGE_DELAY = 4        # seconds between pages while building the full index (per-minute pacing, not the binding constraint now — see above)
FULL_INDEX_REFRESH_HOURS = 8


def find_matching_news(name, symbol, news_list):
    """Look for EVERY cached news article that mentions this coin, not just
    the first one. A coin independently covered by several different outlets
    is meaningfully stronger evidence than a single borderline match from
    one site, so compute_signal() below uses the full list — how many
    articles, and from how many distinct sources — instead of a bare
    yes/no. news_list is already sorted newest-first (see fetch_news()), so
    the returned list is too."""
    name = (name or "").strip()
    symbol = (symbol or "").strip()

    name_pattern = re.compile(r"\b" + re.escape(name) + r"\b", re.IGNORECASE) if name else None
    # Only match on symbol if it's not a super short/common string (avoids
    # "S" or "ID" matching random words in headlines).
    symbol_pattern = re.compile(r"\b" + re.escape(symbol) + r"\b", re.IGNORECASE) if len(symbol) >= 3 else None

    matches = []
    for article in news_list:
        title = article.get("title", "")
        if (name_pattern and name_pattern.search(title)) or (symbol_pattern and symbol_pattern.search(title)):
            matches.append(article)
    return matches


def format_usd_compact(n):
    """'$52.3M' / '$1.2B' / '$421K' style compact formatting, used only to
    build the plain-English reason sentence in compute_signal() below —
    mirrors formatCap() in script.js, but this copy's output goes into that
    sentence, not directly onto the page."""
    n = n or 0
    if n >= 1e12:
        return f"${n / 1e12:.2f}T"
    if n >= 1e9:
        return f"${n / 1e9:.1f}B"
    if n >= 1e6:
        return f"${n / 1e6:.1f}M"
    if n >= 1e3:
        return f"${n / 1e3:.1f}K"
    return f"${n:.0f}"


def compute_confidence(vol_ratio, source_count):
    """0-100 score for how STRONGLY a coin clears its Validated/Mixed/
    Unvalidated status, not which status it gets — that's still decided
    entirely by the threshold logic below, unchanged. Two coins can both
    land on "Validated" for very different reasons (one barely clearing
    the volume threshold with a single borderline article, another
    blowing past it with several independent sources); the status badge
    can't show that difference, so this is the tiebreaker underneath it,
    surfaced only in the hover tooltip and the coin detail page rather
    than as its own column — the badge stays the headline.

    Weighted 65/35 toward volume over news: every coin has a volume ratio,
    so it's the always-available primary evidence, while news coverage
    doesn't exist for most coins at most moments and shouldn't be able to
    sink the score as hard as thin trading does just by being absent.
    """
    # Volume: 0 at no trading, full marks at 2x the "real activity"
    # threshold — comfortably validated, not just barely over the line.
    volume_score = min(100, (vol_ratio / (HIGH_VOLUME_RATIO * 2)) * 100) if HIGH_VOLUME_RATIO else 0
    # News: each additional independent source matters less than the last
    # (0 -> 1 source is a bigger jump in confidence than 3 -> 4 is).
    news_score = min(100, source_count * 40)
    return round(0.65 * volume_score + 0.35 * news_score)


def compute_signal(coin, news_list):
    market_cap = coin.get("market_cap") or 0
    volume = coin.get("total_volume") or 0
    vol_ratio = (volume / market_cap) if market_cap else 0

    volume_backs = vol_ratio >= HIGH_VOLUME_RATIO
    volume_thin = vol_ratio < LOW_VOLUME_RATIO

    matches = find_matching_news(coin.get("name"), coin.get("symbol"), news_list)
    has_news = len(matches) > 0
    # Distinct outlets, newest-first (matches is already sorted that way).
    # Independent corroboration from several different sources is stronger
    # evidence than the same single article, so this drives the reason text
    # below rather than collapsing straight to a yes/no.
    distinct_sources = []
    for m in matches:
        if m["source"] not in distinct_sources:
            distinct_sources.append(m["source"])

    # The reason sentence below is built from THIS coin's actual numbers —
    # its real volume, market cap, and vol_ratio, and the actual article/
    # sources that matched (if any) — rather than one fixed string per
    # status. Two coins that both land on "Validated" traded very different
    # amounts relative to their size, and one might have five independent
    # outlets backing it while another has exactly one borderline match;
    # showing the real numbers is what makes the reason mean something
    # specific to that coin instead of reading like a canned label.
    high_pct = f"{HIGH_VOLUME_RATIO * 100:.0f}%"
    low_pct = f"{LOW_VOLUME_RATIO * 100:.0f}%"
    volume_clause = (
        f"Trading {format_usd_compact(volume)} in 24h — "
        f"{vol_ratio * 100:.1f}% of its {format_usd_compact(market_cap)} market cap"
    )

    if has_news:
        if len(distinct_sources) == 1:
            sources_desc = distinct_sources[0]
        elif len(distinct_sources) == 2:
            sources_desc = f"{distinct_sources[0]} and {distinct_sources[1]}"
        else:
            sources_desc = f"{distinct_sources[0]}, {distinct_sources[1]}, and {len(distinct_sources) - 2} more"
        news_clause = (
            f'coverage found from {sources_desc} ("{matches[0]["title"]}")'
            if len(matches) == 1 else
            f'coverage found from {sources_desc} — most recently "{matches[0]["title"]}"'
        )
    else:
        news_clause = f"no matching coverage found across {len(NEWS_SOURCES)} tracked sources"

    if volume_backs and has_news:
        status = "validated"
        reason = f"{volume_clause}, above the {high_pct} threshold for real trading activity, and {news_clause}."
    elif volume_backs and not has_news:
        status = "mixed"
        reason = f"{volume_clause}, above the {high_pct} threshold for real trading activity, but {news_clause}."
    elif has_news and not volume_thin:
        status = "mixed"
        reason = (
            f"{volume_clause} — above the {low_pct} thin-trading floor but under the {high_pct} "
            f"threshold that would fully confirm the move — and {news_clause}."
        )
    else:
        status = "unvalidated"
        # has_news can still be true here (real coverage exists, but volume is
        # too thin to call it backed) — the reason text needs to say so, since
        # this is exactly the case the "Quiet Coverage" panel on the dashboard
        # surfaces, and an inaccurate reason here would undercut it.
        reason = (
            f"{volume_clause}, under the {low_pct} threshold for real trading activity, even though {news_clause}."
            if has_news else
            f"{volume_clause}, under the {high_pct} threshold for real trading activity, and {news_clause}."
        )

    matched = matches[0] if matches else None
    return {
        "status": status,
        "reason": reason,
        # The single most recent matched article — kept as its own field
        # (rather than only the list below) so the existing frontend link in
        # the tooltip keeps working unchanged.
        "source": matched["source"] if matched else None,
        "source_link": matched["link"] if matched else None,
        "source_title": matched["title"] if matched else None,
        # New: how many articles matched, and the distinct outlets among
        # them — not used by the frontend yet, but there for a future UI
        # that wants to show corroboration strength directly (e.g. a "4
        # sources" badge) rather than parsing it back out of the sentence.
        "source_count": len(matches),
        "matched_sources": distinct_sources,
        "volume": volume,
        "market_cap": market_cap,
        "vol_ratio": vol_ratio,
        "threshold_high": HIGH_VOLUME_RATIO,
        "threshold_low": LOW_VOLUME_RATIO,
        # How strongly this coin clears its status, not which status it got
        # (see compute_confidence() above) — surfaced in the tooltip and
        # detail page only, deliberately left off the main table so the
        # three-bucket badge stays the at-a-glance read.
        "confidence": compute_confidence(vol_ratio, len(distinct_sources)),
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS source_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            coin_id TEXT NOT NULL,
            article_link TEXT NOT NULL,
            article_title TEXT,
            price_at_call REAL,
            ts INTEGER NOT NULL,
            UNIQUE(source, coin_id, article_link)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_source_calls_source_ts ON source_calls (source, ts)")
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


# ---------------------------------------------------------------------------
# Source Reliability — the same track-record idea as above, turned on the
# news sources themselves instead of the Signal status. Every time one of
# the 15 tracked RSS sources publishes an article that matches a coin (see
# find_matching_news()), that's recorded as a "call": this source, this
# coin, at this price. Comparing that price to the coin's price later tells
# you whether a given source's coverage tends to precede real moves or not —
# a meta-layer no other coin tracker scores, since it's not just "here's the
# news," it's "here's whether this outlet's coverage has actually meant
# anything historically."
#
# One row per (source, coin, article) — the UNIQUE constraint on
# source_calls means the same article seen across several fetch_news()
# cycles (it stays in cached_news for a while) only gets recorded once, at
# whatever price was current the first time it was seen.
# ---------------------------------------------------------------------------
SOURCE_RELIABILITY_WINDOWS_DAYS = [3, 7, 14, 30]
SOURCE_RELIABILITY_MIN_SAMPLES = 3  # per source, per window, before we'll show it


def record_source_calls():
    """Called at the end of fetch_news(), once per news-refresh cycle. Walks
    every live coin against the freshly-fetched news list the same way
    compute_signal() does internally, but instead of just using the matches
    to decide Validated/Mixed/Unvalidated, persists each new one so its
    outcome can be checked later."""
    if not cached_coins or not cached_news:
        return

    now = int(time.time())
    rows = []
    for coin in cached_coins:
        price = coin.get("current_price")
        if price is None:
            continue
        matches = find_matching_news(coin.get("name"), coin.get("symbol"), cached_news)
        for m in matches:
            if not m.get("link"):
                continue  # no stable identity to dedupe on — skip rather than risk double-counting
            rows.append((m["source"], coin["id"], m["link"], m["title"], price, now))

    if not rows:
        return

    conn = sqlite3.connect(DB_PATH)
    # INSERT OR IGNORE, not INSERT OR REPLACE — the whole point is capturing
    # the price the FIRST time this article was seen, not the latest time.
    conn.executemany(
        "INSERT OR IGNORE INTO source_calls (source, coin_id, article_link, article_title, price_at_call, ts) VALUES (?, ?, ?, ?, ?, ?)",
        rows
    )
    conn.commit()
    conn.close()


def compute_source_reliability():
    """For each news source, for each window (3/7/14/30 days), average the
    price change from call-time to now across every call old enough for
    that window — same shape as compute_track_record() above, just grouped
    by source instead of by Signal status."""
    now = int(time.time())
    current_price_by_id = {c["id"]: c.get("current_price") for c in cached_coins}

    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT source, coin_id, price_at_call, ts FROM source_calls").fetchall()
    conn.close()

    by_source = {}
    for source, coin_id, price_then, ts in rows:
        by_source.setdefault(source, []).append((coin_id, price_then, ts))

    results = []
    for source, calls in sorted(by_source.items()):
        windows = []
        for days in SOURCE_RELIABILITY_WINDOWS_DAYS:
            cutoff = now - days * 86400
            changes = []
            for coin_id, price_then, ts in calls:
                if ts > cutoff or not price_then:
                    continue  # not old enough yet for this window, or no usable price
                now_price = current_price_by_id.get(coin_id)
                if now_price is None:
                    continue
                changes.append(((now_price - price_then) / price_then) * 100)
            if len(changes) >= SOURCE_RELIABILITY_MIN_SAMPLES:
                windows.append({"days": days, "avg_change_pct": round(sum(changes) / len(changes), 2), "count": len(changes)})
        if windows:
            results.append({"source": source, "total_calls": len(calls), "windows": windows})

    # Ranked by the shortest window that actually has data, richest (most
    # calls) sources first within a tie — an easy source-vs-source glance,
    # not a claim that the ranking itself is statistically rigorous yet.
    results.sort(key=lambda r: (r["windows"][0]["avg_change_pct"], r["total_calls"]), reverse=True)
    return {"ready": len(results) > 0, "sources": results}


def snapshot_refresh_loop():
    while True:
        time.sleep(6 * 3600)
        try:
            snapshot_signals()
        except Exception as e:
            # Without this, an uncaught error here (a locked/corrupt sqlite
            # file, a disk hiccup, etc.) would kill this thread permanently —
            # snapshots would silently stop being recorded until the next
            # redeploy, and nobody would notice until Track Record stopped
            # updating days later. Log and try again next cycle instead.
            print(f"snapshot_refresh_loop tick failed, will retry next cycle: {e}")


def fetch_all_coins():
    global cached_coins
    all_coins = []
    for page in range(1, LIVE_COIN_PAGES + 1):
        response = requests.get(
            f"{COINGECKO_BASE_URL}/coins/markets",
            params={
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": 250,
                "page": page,
                # Adds price_change_percentage_1h_in_currency / _24h_in_currency /
                # _7d_in_currency to every coin, needed for the Top Movers timeframes.
                "price_change_percentage": "1h,24h,7d",
            },
            headers=COINGECKO_HEADERS,
            timeout=REQUEST_TIMEOUT_SECONDS
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
        # good data and just try again next cycle (PRICE_REFRESH_INTERVAL_SECONDS).
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
    On the paid Basic plan the per-minute limit (300 calls/min) is generous
    enough that pacing isn't really about avoiding 429s anymore; the real
    constraint is the 100,000 credits/month budget shared with
    price_refresh_loop and global_refresh_loop, which is why this only runs
    once every FULL_INDEX_REFRESH_HOURS hours rather than continuously. At
    the default 4-second delay a full pass across ~90 pages still takes
    roughly 6 minutes, which is fine for something that only needs to run a
    few times a day, since a long-tail coin's price doesn't need to be
    fresher than that to be searchable and to have a working detail page."""
    page = 1
    total = 0
    consecutive_429s = 0
    conn = sqlite3.connect(DB_PATH)
    try:
        while True:
            response = requests.get(
                f"{COINGECKO_BASE_URL}/coins/markets",
                params={
                    "vs_currency": "usd",
                    "order": "market_cap_desc",
                    "per_page": 250,
                    "page": page,
                },
                headers=COINGECKO_HEADERS,
                timeout=REQUEST_TIMEOUT_SECONDS
            )
            if response.status_code == 429:
                # Rate-limited. Retrying is fine ONCE or TWICE, but retrying
                # forever on every 429 (what this used to do) just keeps
                # hammering CoinGecko indefinitely, which risks turning a
                # brief rate-limit into a longer punitive block — the opposite
                # of what backing off is supposed to do. Give up on this pass
                # after a few tries and let the next scheduled run (in
                # FULL_INDEX_REFRESH_HOURS) try again instead.
                consecutive_429s += 1
                if consecutive_429s > 3:
                    print("Full coin index still rate-limited after", consecutive_429s, "tries — giving up on this pass")
                    break
                wait = 30 * consecutive_429s
                print("Full coin index rate-limited on page", page, "- backing off", wait, "s (attempt", consecutive_429s, ")")
                time.sleep(wait)
                continue
            consecutive_429s = 0
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
    # Give the live hot-set loop (price_refresh_loop/global_refresh_loop —
    # what the dashboard actually needs to render anything) a long, fully
    # clear runway before this starts competing for CoinGecko's rate limit
    # at all. This was 90 seconds, which turned out not to be enough
    # separation once a rate-limit backoff bug had this job hammering
    # CoinGecko continuously — 5 minutes gives real breathing room for things
    # to recover if the key is in any kind of cooldown.
    time.sleep(300)
    while True:
        try:
            refresh_full_coin_index()
        except Exception as e:
            # refresh_full_coin_index() already handles 429s and non-200s
            # itself, but the timeout added to its requests.get() call can
            # now raise (Timeout/ConnectionError) partway through a ~90-page
            # pass, and a stray sqlite error could too — either would
            # otherwise kill this thread for good, silently freezing search
            # and coin-detail-page results at whatever page it died on.
            print(f"full_index_refresh_loop tick failed, will retry next cycle: {e}")
        time.sleep(FULL_INDEX_REFRESH_HOURS * 3600)


def fetch_global():
    global cached_global
    response = requests.get(
        f"{COINGECKO_BASE_URL}/global",
        headers=COINGECKO_HEADERS,
        timeout=REQUEST_TIMEOUT_SECONDS
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


# ---------------------------------------------------------------------------
# Coin detail page: price chart with a Signal-history overlay
#
# Two data sources feed one response here:
#   1. Real OHLC candles from CoinGecko's /coins/<id>/ohlc — the actual price
#      history, at whatever granularity CoinGecko itself picks for the range
#      (30-min candles for 1 day, 4-hour for 30 days, 4-day for 365 days —
#      not something we control, just what that endpoint returns).
#   2. This coin's own row in signal_snapshots (see "Signal Track Record"
#      above) — what the Signal status actually was at each point in time,
#      so the chart can be shaded by "was this move Validated at the time?"
#      instead of only showing today's status.
#
# Snapshots are only taken every 6 hours (snapshot_signals(), top 500 coins
# by market cap), which is much coarser than a 1-day chart's 30-minute
# candles — so a lot of candles, especially on 1D and for coins outside that
# top-500 pool, won't have a snapshot near them. attach_signal_history()
# below carries the most recent known status forward candle-by-candle rather
# than inventing one, and candles before the first snapshot ever taken (or
# for a coin that's never been snapshotted at all) just get None — the
# frontend leaves those unshaded instead of guessing.
# ---------------------------------------------------------------------------
CHART_RANGE_DAYS = {"1d": 1, "1m": 30, "1y": 365}

# Unlike the loops above, this endpoint is hit live, per pageview, by
# whichever coin's detail page a visitor happens to have open — there's no
# way to pre-budget it the way PRICE_REFRESH_INTERVAL_SECONDS etc. do for
# the shared caches. A small in-memory cache keeps repeat requests for the
# same coin+range (a page reload, another visitor looking at the same coin,
# the frontend's own periodic refresh below) from each costing a fresh
# CoinGecko call, without needing a background loop or any new storage.
CHART_CACHE_TTL_SECONDS = 60
_chart_cache = {}  # (coin_id, range_key) -> (cached_at_epoch, response_dict)


def fetch_coin_ohlc(coin_id, days):
    response = requests.get(
        f"{COINGECKO_BASE_URL}/coins/{coin_id}/ohlc",
        params={"vs_currency": "usd", "days": days},
        headers=COINGECKO_HEADERS,
        timeout=REQUEST_TIMEOUT_SECONDS
    )
    if response.status_code != 200:
        print(f"OHLC fetch failed for {coin_id} ({days}d) - status:", response.status_code)
        return None
    return response.json()  # [[ts_ms, open, high, low, close], ...], oldest first


def attach_signal_history(coin_id, candles):
    """Tag each candle with the Signal status that was most recently
    recorded at or before that candle's own timestamp. Both candles and
    snapshot rows are already time-ordered, so this is a single pass with a
    pointer into the snapshot rows rather than a per-candle query."""
    if not candles:
        return candles

    end_ts = candles[-1][0] // 1000
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT status, ts FROM signal_snapshots WHERE coin_id = ? AND ts <= ? ORDER BY ts ASC",
        (coin_id, end_ts)
    ).fetchall()
    conn.close()

    out = []
    idx = 0
    current_status = None
    for candle in candles:
        candle_ts = candle[0] // 1000
        while idx < len(rows) and rows[idx][1] <= candle_ts:
            current_status = rows[idx][0]
            idx += 1
        out.append(candle + [current_status])
    return out


def get_coin_chart(coin_id, range_key):
    days = CHART_RANGE_DAYS.get(range_key)
    if days is None:
        return None

    cache_key = (coin_id, range_key)
    cached = _chart_cache.get(cache_key)
    now = time.time()
    if cached and (now - cached[0]) < CHART_CACHE_TTL_SECONDS:
        return cached[1]

    candles = fetch_coin_ohlc(coin_id, days)
    if candles is None:
        return False  # fetch failed — distinct from "never cached" (None) so the route can 502

    result = {"range": range_key, "candles": attach_signal_history(coin_id, candles)}
    _chart_cache[cache_key] = (now, result)
    return result


def format_published(published_parsed):
    """Turn feedparser's parsed date into one consistent display string —
    'Thu, Sep 24 2026, 5:06 PM' — instead of showing each RSS feed's own raw
    date text as-is. Every source formats its <pubDate> a little differently
    (some include seconds, all of them include a UTC offset like '+0000'),
    so passing that straight through made the News panel look inconsistent
    from card to card. published_parsed can be missing entirely on a
    malformed feed entry, so this returns "" rather than crashing or
    printing a bogus epoch date.

    The time shown is whatever feedparser normalized the feed's own
    <pubDate> to, which is UTC — this formats it in the 12-hour AM/PM
    convention but doesn't convert it to any particular local time zone, so
    it's still UTC under the hood, just without the "+0000" label that used
    to make that explicit."""
    if not published_parsed:
        return ""
    dt = datetime(*published_parsed[:6])
    date_part = f"{dt.strftime('%a, %b')} {dt.day} {dt.year}"
    time_part = dt.strftime("%I:%M %p").lstrip("0")  # "05:06 PM" -> "5:06 PM"
    return f"{date_part}, {time_part}"


def _fetch_one_news_source(source_name, feed_url):
    """Fetch + parse a single RSS source. Never raises — always returns a
    list, empty on any failure — since this runs inside a thread pool where
    an uncaught exception would just vanish rather than being visible to
    whatever's waiting on the result.

    feedparser.parse() takes no timeout of its own — pointed straight at a
    URL, it uses urllib underneath with no time limit, so one slow or dead
    RSS host could hang this call forever. Fetching with requests first
    gives an explicit timeout, and catching everything here means one broken
    feed (a timeout, a connection error, a malformed response) only drops
    that one source for this cycle instead of taking down the whole batch."""
    try:
        resp = requests.get(feed_url, timeout=REQUEST_TIMEOUT_SECONDS, headers={"User-Agent": "Mozilla/5.0 (compatible; SiftBot/1.0)"})
        feed = feedparser.parse(resp.content)
    except Exception as e:
        print(f"News source '{source_name}' failed this cycle: {e}")
        return []
    articles = []
    for entry in feed.entries:
        raw_parsed = entry.get("published_parsed")
        articles.append({
            "title": entry.get("title", "Untitled"),
            "link": entry.get("link", ""),
            "source": source_name,
            "published": format_published(raw_parsed),
            # Epoch seconds (UTC) alongside the pre-formatted string above —
            # the frontend uses this to display each article's time in the
            # VIEWER's own local timezone (format_published() above bakes in
            # UTC, which is fine as a fallback but wrong for anyone not in
            # UTC). calendar.timegm() (not time.mktime()) is what correctly
            # treats raw_parsed as UTC rather than the server's local time.
            "published_ts": calendar.timegm(raw_parsed) if raw_parsed else None,
            # Sorting still needs an actual sortable value even for an entry
            # with no date at all — falls back to the epoch so those sort to
            # the very end (oldest) instead of breaking the sort entirely.
            # format_published() above (which runs on raw_parsed, not this
            # fallback) is what keeps a missing date showing "" rather than
            # a bogus "Thu, Jan 1 1970".
            "published_parsed": raw_parsed or time.gmtime(0),
        })
    return articles


def fetch_news():
    global cached_news

    # Fetched concurrently rather than one source at a time. NEWS_SOURCES has
    # grown from 8 to 15 feeds — a sequential loop's worst case (several
    # sources timing out back-to-back, each eating the full
    # REQUEST_TIMEOUT_SECONDS) could start approaching news_refresh_loop's
    # own 300s cycle. A small thread pool means one cycle takes roughly as
    # long as the single slowest source, not the sum of all of them, and
    # that stays true as more sources get added later.
    all_articles = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for articles in pool.map(lambda src: _fetch_one_news_source(*src), NEWS_SOURCES):
            all_articles.extend(articles)

    all_articles.sort(key=lambda article: article["published_parsed"], reverse=True)

    cached_news = []
    for article in all_articles[:30]:
        cached_news.append({
            "title": article["title"],
            "link": article["link"],
            "source": article["source"],
            "published": article["published"],
            "published_ts": article["published_ts"],
        })

    compute_all_signals()  # news changed, so signals might too
    record_source_calls()  # persist any new source/coin/article matches for Source Reliability
    print("News cache refreshed. Total articles cached:", len(cached_news))


def price_refresh_loop():
    while True:
        time.sleep(PRICE_REFRESH_INTERVAL_SECONDS)
        try:
            fetch_all_coins()
        except Exception as e:
            # The timeout added to fetch_all_coins()'s requests.get() call
            # means a slow CoinGecko response can now raise here instead of
            # just hanging — without this try/except that would kill the
            # thread the whole dashboard depends on, freezing every price on
            # the site at whatever it last showed, forever, with nothing in
            # the logs to explain why. Log it and let the next tick retry.
            print(f"price_refresh_loop tick failed, will retry next cycle: {e}")


def global_refresh_loop():
    while True:
        time.sleep(GLOBAL_REFRESH_INTERVAL_SECONDS)
        try:
            fetch_global()
        except Exception as e:
            print(f"global_refresh_loop tick failed, will retry next cycle: {e}")


def news_refresh_loop():
    while True:
        time.sleep(300)
        try:
            fetch_news()
        except Exception as e:
            # fetch_news() already guards each individual RSS source, but this
            # is a second layer of defense in case something outside that loop
            # (e.g. compute_all_signals()) ever throws — better a logged miss
            # this cycle than a permanently frozen news feed.
            print(f"news_refresh_loop tick failed, will retry next cycle: {e}")


@app.route("/")
def home():
    return app.send_static_file("index.html")


@app.route("/coin/<coin_id>")
def coin_detail_page(coin_id):
    # Same single-page app shell — script.js reads the URL and renders the
    # per-coin breakdown view instead of the dashboard. This route's only job
    # is making sure a direct link or a page refresh on /coin/<id> works.
    return app.send_static_file("index.html")


@app.route("/compare")
def compare_page():
    # Same single-page app shell as above — script.js reads location.pathname
    # (and an optional ?coins=a,b,c query string) and renders the Coin
    # Comparison view instead of the dashboard. This route's only job is
    # making sure a direct link or a page refresh on /compare works.
    return app.send_static_file("index.html")


@app.route("/how-it-works")
def how_it_works_page():
    # Same single-page app shell again — script.js renders the static
    # methodology view instead of the dashboard. Purely explanatory content
    # (no API calls of its own), so this route's only job, like the two
    # above, is making a direct link or page refresh work.
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


@app.route("/api/chart/<coin_id>")
def get_chart(coin_id):
    """OHLC candles for the coin detail page's Price History chart, each
    tagged with the Signal status that was in effect at that point in time
    (see attach_signal_history() above) — real CoinGecko data plus real
    Signal history, not demo data like the earlier standalone preview of
    this chart used."""
    range_key = request.args.get("range", "1d")
    if range_key not in CHART_RANGE_DAYS:
        return jsonify({"error": f"range must be one of {list(CHART_RANGE_DAYS)}"}), 400

    result = get_coin_chart(coin_id, range_key)
    if result is False:
        return jsonify({"error": "Couldn't fetch chart data right now"}), 502
    return jsonify(result)


@app.route("/api/news")
def get_news():
    return jsonify(cached_news)


@app.route("/api/global")
def get_global():
    return jsonify(cached_global)


@app.route("/api/health")
def health():
    """Lightweight runtime diagnostics, kept in permanently (unlike the old
    /api/debug) so memory/thread behavior can actually be watched over hours
    instead of guessed at. peak_rss_mb is the process's peak resident memory
    so far (Linux reports ru_maxrss in KB, not current usage) — a steady
    climb across repeated checks over several hours is the leak signature to
    watch for. thread_count should stay flat once startup settles (main
    thread + 5 daemon refresh loops = 6; briefly 7 while initial_load's
    one-shot thread is still running) — a number that keeps creeping up
    would mean something is spawning threads without them ever finishing.
    No API keys or other secrets are exposed here."""
    return jsonify({
        "uptime_seconds": round(time.time() - START_TIME),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "thread_count": threading.active_count(),
        "python_object_count": len(gc.get_objects()),
        "cached_coins_len": len(cached_coins),
        "cached_news_len": len(cached_news),
        "pid": os.getpid(),
    })


@app.route("/api/track-record")
def get_track_record():
    return jsonify(compute_track_record())


@app.route("/api/track-record/<coin_id>")
def get_coin_track_record(coin_id):
    return jsonify(compute_coin_track_record(coin_id))


@app.route("/api/source-reliability")
def get_source_reliability():
    return jsonify(compute_source_reliability())


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


_background_started_pid = None


def start_background_threads():
    """Spins up init_db() plus every refresh loop. Pulled into its own
    function (instead of running loose at module level, which is how this
    used to work) so it can be safely called again after a fork.

    Why this matters: Gunicorn's worker processes are forked from a master
    process. If the master ever imports this module before forking (e.g.
    with preload_app enabled), plain module-level code — like the old bare
    threading.Thread(...).start() calls — only runs once, in the master, at
    import time. Threads don't survive a fork: the forked worker gets a
    frozen snapshot of memory at that instant, not the master's live
    threads. So the master's threads keep fetching CoinGecko data forever
    and print successful refreshes, while the worker that actually answers
    HTTP requests is permanently stuck with whatever cached_coins looked
    like at fork time (empty, if the fork happened before the first fetch
    finished). That split — background thread's for the master process no
    one is talking to, real traffic handled by a worker that never
    changes — is exactly what caused the dashboard to be stuck on
    "Loading…" while the logs showed successful refreshes.

    The fix: gunicorn.conf.py's post_fork hook calls this function again in
    every worker, right after it's forked, guaranteeing the threads run in
    the same process that serves traffic. The PID-based guard below makes
    that safe to do — it only re-starts the threads if the calling process
    is different from whichever process last started them (i.e. we're in a
    freshly forked child), so it never double-starts within the same
    process, but it DOES correctly start fresh after a fork even though the
    plain "already started" flag would otherwise carry over from the
    parent's memory."""
    global _background_started_pid
    current_pid = os.getpid()
    if _background_started_pid == current_pid:
        return
    _background_started_pid = current_pid

    # init_db() only does local SQLite table setup — no network calls — so
    # unlike the fetches below it's fast enough to run synchronously here.
    # That also avoids a startup race: full_index_refresh_loop writes to the
    # coin_index table from its very first tick, so that table needs to
    # exist before its thread starts, not "eventually" once initial_load()
    # gets to it.
    init_db()

    threading.Thread(target=initial_load, daemon=True).start()
    threading.Thread(target=price_refresh_loop, daemon=True).start()
    threading.Thread(target=global_refresh_loop, daemon=True).start()
    threading.Thread(target=news_refresh_loop, daemon=True).start()
    threading.Thread(target=snapshot_refresh_loop, daemon=True).start()
    threading.Thread(target=full_index_refresh_loop, daemon=True).start()


# Runs at import time regardless of how this module is loaded — covers
# being run directly (`python server.py`), the test harness (which imports
# this module via importlib), and Gunicorn workers that import it fresh
# themselves (the default, no-preload behavior). Under Gunicorn WITH
# preload_app on, gunicorn.conf.py's post_fork hook calls this again inside
# each actual worker process after the fork; the PID guard above makes that
# correctly re-run the startup rather than being skipped.
start_background_threads()

if __name__ == "__main__":
    # debug=True was left on from local development — it should never run on
    # a publicly deployed service: besides the extra memory overhead, Flask's
    # debug mode exposes an interactive in-browser debugger on any unhandled
    # error, which lets whoever triggers that error run arbitrary code on the
    # server. debug=False here as well as on Render.
    app.run(debug=False, use_reloader=False)
