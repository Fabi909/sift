# Test-only harness: reuses the real Flask app/routes from server.py but seeds
# realistic sample data instead of hitting CoinGecko, so we can verify the
# frontend against something that looks like production without needing
# network access to CoinGecko (which this sandbox can't reach anyway).
import sys, types, importlib.util, time, os, sqlite3
 
# Point the Signal Track Record feature at a throwaway DB file instead of the
# real signal_history.db, and start clean each run.
TEST_DB_PATH = "/tmp/test_signal_history.db"
if os.path.exists(TEST_DB_PATH):
    os.remove(TEST_DB_PATH)
os.environ["SIGNAL_HISTORY_DB"] = TEST_DB_PATH
 
NEWS = [
    {"title": "Bitcoin ETF inflows hit record high as institutions pile in", "link": "https://coindesk.com/a", "source": "CoinDesk", "published": "2 hr ago"},
    {"title": "XRP rallies on regulatory clarity", "link": "https://cointelegraph.com/b", "source": "Cointelegraph", "published": "3 hr ago"},
    {"title": "Aurora announces partnership with major exchange", "link": "https://decrypt.co/c", "source": "Decrypt", "published": "1 hr ago"},
]
 
def coin(id, name, symbol, price, mcap, vol, c1h, c24h, c7d, image_ok=True):
    return {
        "id": id, "name": name, "symbol": symbol,
        "image": f"https://example-cdn-that-does-not-resolve.test/{symbol}.png" if image_ok else None,
        "current_price": price, "market_cap": mcap, "total_volume": vol,
        "price_change_percentage_24h": c24h,
        "price_change_percentage_1h_in_currency": c1h,
        "price_change_percentage_24h_in_currency": c24h,
        "price_change_percentage_7d_in_currency": c7d,
    }
 
COINS = [
    coin("bitcoin", "Bitcoin", "btc", 86503, 1.74e12, 1.5e11, 0.1, -0.19, 3.2),
    coin("ethereum", "Ethereum", "eth", 2752.92, 3.36e11, 5e10, -0.3, -0.71, 2.1),
    coin("solana", "Solana", "sol", 118.58, 6.42e10, 4e9, 0.5, -0.47, -1.2),
    coin("xrp", "XRP", "xrp", 2.41, 1.413e11, 3e10, 1.1, 1.32, 4.1),
    coin("tether", "Tether", "usdt", 1.0, 1.4e11, 9e10, 0.0, 0.01, -0.02),
    coin("pulsefin", "PulseFin", "pulse", 0.042, 4e7, 3e5, 12.0, 38.4, 50.0, image_ok=False),
    # Real matching coverage (see NEWS above) but volume/market-cap is far
    # below LOW_VOLUME_RATIO (0.02) — the market hasn't reacted to the news
    # yet. Exercises the Quiet Coverage panel.
    coin("auroracoin", "Aurora", "aoc", 0.85, 5e7, 2e5, 0.2, 0.9, 1.1),
]
 
# Only returned to the full-index build (see FakeResp.json below), never to
# the live/hot-set fetch — lets us verify search and the coin detail page
# both work for a coin that's outside cached_coins entirely, resolved only
# through the server-side coin_index table.
LONGTAIL_COIN = coin("tailwind-token", "Tailwind Token", "twnd", 0.0031, 1.2e6, 4e4, 0.4, 2.1, -3.0, image_ok=False)
 
import requests
class FakeResp:
    status_code = 200
    def json(self):
        if self._url.endswith("/coins/markets"):
            params = self._params or {}
            page = params.get("page")
            # fetch_all_coins() (the live/hot-set loop) passes
            # price_change_percentage; refresh_full_coin_index() doesn't —
            # that's how we tell the two callers apart here and give the
            # full-index build one extra coin the live set never sees.
            is_live_fetch = "price_change_percentage" in params
            if is_live_fetch:
                # Mirrors CoinGecko's /coins/markets shape — only page 1 has
                # data, every later page is empty (like running out of
                # results), so the refresh loop keeps re-seeding the same
                # synthetic coins forever instead of the cache going empty
                # after the first 60s refresh.
                return COINS if page == 1 else []
            return (COINS + [LONGTAIL_COIN]) if page == 1 else []
        if "global" in self._url:
            return {"data": {}}
        if self._url.endswith("/ohlc"):
            # Synthetic OHLC candles shaped like CoinGecko's real
            # /coins/<id>/ohlc response: [[ts_ms, open, high, low, close], ...],
            # oldest first. Six candles regardless of range is enough to
            # exercise get_coin_chart()/attach_signal_history() without
            # needing to match CoinGecko's real per-range candle counts.
            days = (self._params or {}).get("days", 1)
            step_ms = {1: 4 * 3600 * 1000, 30: 5 * 24 * 3600 * 1000, 365: 60 * 24 * 3600 * 1000}.get(days, 3600 * 1000)
            now_ms = int(time.time() * 1000)
            price = 86000
            candles = []
            for i in range(6):
                t = now_ms - (6 - i) * step_ms
                o = price
                c = o + (i - 3) * 50
                h = max(o, c) + 20
                l = min(o, c) - 20
                candles.append([t, o, h, l, c])
                price = c
            return candles
        return []
def fake_get(url, params=None, **kwargs):
    r = FakeResp()
    r._url = url
    r._params = params
    return r
requests.get = fake_get
 
import feedparser
feedparser.parse = lambda url: types.SimpleNamespace(entries=[])
 
spec = importlib.util.spec_from_file_location("server_module", "server.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
 
# The module's own top-level fetch_all_coins()/fetch_news() calls already ran
# against the fakes above (signals included), so cached_coins is real
# synthetic data from the moment the module loads — no separate manual
# seeding needed, and the 60s refresh loop keeps working too.
mod.cached_news = NEWS
mod.cached_global = {
    "total_market_cap_usd": 3.41e12,
    "total_volume_usd": 1.428e11,
    "btc_dominance": 51.2,
    "market_cap_change_24h": -0.8,
}
mod.compute_all_signals()
 
# Optionally backfill fake historical snapshots so the Signal Track Record
# card has something to show (SEED_TRACK_RECORD=1 python3 test_server.py).
# Without this, the DB starts empty and the card should show its "building
# history" empty state instead — both are worth being able to check.
if os.getenv("SEED_TRACK_RECORD"):
    mod.init_db()
    now = int(time.time())
    conn = sqlite3.connect(TEST_DB_PATH)
    seed_rows = []
    # (coin_id, symbol, name, status, then_price, days_ago) — then_price is
    # deliberately chosen relative to each coin's current price above so the
    # computed % change is realistic and, on average, validated > unvalidated.
    seed_spec = [
        ("bitcoin", "btc", "Bitcoin", "validated", 78000, 10),
        ("bitcoin", "btc", "Bitcoin", "validated", 74000, 20),
        ("ethereum", "eth", "Ethereum", "validated", 2400, 10),
        ("ethereum", "eth", "Ethereum", "validated", 2200, 20),
        ("xrp", "xrp", "XRP", "validated", 2.1, 10),
        ("solana", "sol", "Solana", "mixed", 130, 10),
        ("solana", "sol", "Solana", "mixed", 140, 20),
        ("tether", "usdt", "Tether", "mixed", 1.0, 10),
        ("pulsefin", "pulse", "PulseFin", "unvalidated", 0.06, 5),
        ("pulsefin", "pulse", "PulseFin", "unvalidated", 0.09, 12),
        ("auroracoin", "aoc", "Aurora", "unvalidated", 0.95, 5),
        ("auroracoin", "aoc", "Aurora", "unvalidated", 1.05, 12),
    ]
    for coin_id, symbol, name, status, then_price, days_ago in seed_spec:
        seed_rows.append((coin_id, symbol, name, status, then_price, then_price * 4e7, now - days_ago * 86400))
    conn.executemany(
        "INSERT INTO signal_snapshots (coin_id, symbol, name, status, price, market_cap, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        seed_rows
    )
    conn.commit()
    conn.close()
    print(f"Seeded {len(seed_rows)} fake historical snapshots for track-record testing.")
 
if __name__ == "__main__":
    mod.app.run(port=5055, debug=False, use_reloader=False)