from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import requests
import threading
import time
import feedparser
import os

load_dotenv()

app = Flask(__name__)
CORS(app)

API_KEY = os.getenv("COINGECKO_API_KEY")

cached_coins = []
cached_news = []

NEWS_SOURCES = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
]

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
                "x_cg_demo_api_key": API_KEY
            }
        )
        if response.status_code != 200:
            print("Stopped at page", page, "- status:", response.status_code)
            break
        data = response.json()
        all_coins = all_coins + data

    cached_coins = all_coins
    print("Price cache refreshed. Total coins cached:", len(cached_coins))

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
    for article in all_articles[:15]:
        cached_news.append({
            "title": article["title"],
            "link": article["link"],
            "source": article["source"],
            "published": article["published"]
        })

    print("News cache refreshed. Total articles cached:", len(cached_news))

def price_refresh_loop():
    while True:
        time.sleep(60)
        fetch_all_coins()

def news_refresh_loop():
    while True:
        time.sleep(300)
        fetch_news()

@app.route("/")
def home():
    return app.send_static_file("index.html")

@app.route("/api/prices")
def get_prices():
    return jsonify(cached_coins)

@app.route("/api/news")
def get_news():
    return jsonify(cached_news)

fetch_all_coins()
fetch_news()

threading.Thread(target=price_refresh_loop, daemon=True).start()
threading.Thread(target=news_refresh_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)