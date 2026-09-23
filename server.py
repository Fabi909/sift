from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
import requests
import threading
import time
import re
import feedparser
import os

load_dotenv()

app = Flask(__name__)
CORS(app)

API_KEY = os.getenv("COINGECKO_API_KEY")

cached_coins = []       # every coin CoinGecko gives us, each with a "signal" field attached
cached_news = []
cached_global = {}      # total market cap / volume / btc dominance, from CoinGecko's /global

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
        reason = "Move isn't backed by volume, and no matching coverage found"

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


def fetch_all_coins():
    global cached_coins
    all_coins = []
    for page in range(1, 21):
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

    cached_coins = all_coins
    compute_all_signals()
    print("Price cache refreshed. Total coins cached:", len(cached_coins))


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


@app.route("/api/news")
def get_news():
    return jsonify(cached_news)


@app.route("/api/global")
def get_global():
    return jsonify(cached_global)


fetch_all_coins()
fetch_global()
fetch_news()

threading.Thread(target=price_refresh_loop, daemon=True).start()
threading.Thread(target=global_refresh_loop, daemon=True).start()
threading.Thread(target=news_refresh_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)