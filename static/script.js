const input = document.getElementById("coinInput");
const button = document.getElementById("searchButton");
const result = document.getElementById("result");
const suggestionsBox = document.getElementById("suggestions");


let allCoins = [];
let selectedCoinId = null;

async function loadCoins() {
    try {
        const response = await fetch("/api/prices");
        if (!response.ok) {
            console.log("Server responded with an error:", response.status);
            return;
        }
        allCoins = await response.json();
        console.log("Loaded coins from our own server. Total:", allCoins.length);
    } catch (error) {
        console.log("Couldn't reach our server:", error);
    }
}

function renderDashboard() {
    const dashboardBody = document.getElementById("dashboardBody");
    dashboardBody.innerHTML = ""; // clear out the old rows before drawing new ones

    const topCoins = allCoins.slice(0, 20); // top 20 by market cap (already sorted)

    topCoins.forEach(coin => {
        const row = document.createElement("tr");

        const change = coin.price_change_percentage_24h;
        const changeClass = change >= 0 ? "price-up" : "price-down";
        const changeSymbol = change >= 0 ? "▲" : "▼";

        row.innerHTML = `
            <td>${coin.name} (${coin.symbol.toUpperCase()})</td>
            <td>$${coin.current_price.toLocaleString()}</td>
            <td class="${changeClass}">${changeSymbol} ${Math.abs(change).toFixed(2)}%</td>
        `;

        dashboardBody.appendChild(row);
    });
}

async function refreshDashboard() {
    await loadCoins();
    renderDashboard();
}

refreshDashboard(); // run once immediately on page load
setInterval(refreshDashboard, 1000); // then automatically every 60 seconds

input.addEventListener("input", function () {
    selectedCoinId = null;
    const text = input.value.toLowerCase();
    suggestionsBox.innerHTML = "";
    if (text === "") return;

    const matches = allCoins.filter(coin =>
        coin.name.toLowerCase().includes(text) || coin.symbol.toLowerCase().includes(text)
    ).slice(0, 8);

    matches.forEach(coin => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.textContent = coin.name + " (" + coin.symbol.toUpperCase() + ")";
        item.addEventListener("click", function () {
            input.value = coin.name;
            selectedCoinId = coin.id;
            suggestionsBox.innerHTML = "";
        });
        suggestionsBox.appendChild(item);
    });
});

function checkPrice(coinId, displayName) {
    const coin = allCoins.find(c => c.id === coinId);
    if (coin) {
        result.textContent = displayName + " price: $" + coin.current_price;
    } else {
        result.textContent = `Couldn't find "${displayName}" in the loaded coin list.`;
    }
}

function runSearch() {
    let idToUse = selectedCoinId;
    if (!idToUse) {
        const typed = input.value.toLowerCase();
        const match = allCoins.find(c =>
            c.id === typed || c.symbol.toLowerCase() === typed || c.name.toLowerCase() === typed
        );
        idToUse = match ? match.id : typed;
    }
    checkPrice(idToUse, input.value);
    suggestionsBox.innerHTML = "";
}

button.addEventListener("click", runSearch);
input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") runSearch();
});

async function loadNews() {
    try {
        const response = await fetch("/api/news");
        if (!response.ok) {
            console.log("News request failed:", response.status);
            return;
        }
        const articles = await response.json();
        renderNews(articles);
    } catch (error) {
        console.log("Couldn't reach the news endpoint:", error);
    }
}

function renderNews(articles) {
    const newsList = document.getElementById("newsList");
    newsList.innerHTML = "";

    articles.forEach(article => {
        const item = document.createElement("li");
        item.className = "news-item";
        item.innerHTML = `
            <a href="${article.link}" target="_blank">${article.title}</a>
            <span class="news-source">${article.source} — ${article.published}</span>
        `;
        newsList.appendChild(item);
    });
}

loadNews();
setInterval(loadNews, 3000); // refresh every 1 minute