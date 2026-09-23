# Test-only harness: reuses the real Flask app/routes from server.py but seeds
# realistic sample data instead of hitting CoinGecko, so we can verify the
# frontend against something that looks like production without needing
# network access to CoinGecko (which this sandbox can't reach anyway).
import sys, types, importlib.util, time

NEWS = [
    {"title": "Bitcoin ETF inflows hit record high as institutions pile in", "link": "https://coindesk.com/a", "source": "CoinDesk", "published": "2 hr ago"},
    {"title": "XRP rallies on regulatory clarity", "link": "https://cointelegraph.com/b", "source": "Cointelegraph", "published": "3 hr ago"},
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
]

import requests
class FakeResp:
    status_code = 200
    def json(self):
        if self._url.endswith("/coins/markets"):
            # Mirrors CoinGecko's /coins/markets shape — only page 1 has data,
            # every later page is empty (like running out of results), so the
            # refresh loop keeps re-seeding the same synthetic coins forever
            # instead of the cache going empty after the first 60s refresh.
            return COINS if (self._params or {}).get("page") == 1 else []
        if "global" in self._url:
            return {"data": {}}
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

if __name__ == "__main__":
    mod.app.run(port=5055, debug=False, use_reloader=False)