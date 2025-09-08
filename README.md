# Trading Bot Dashboard "BOTPY"

BOTPY is a comprehensive web-based dashboard designed to monitor, control, and analyze a multi-pair automated crypto trading bot operating on USDT pairs. It provides a real-time, user-friendly interface to track market opportunities, manage active positions, review performance, and fine-tune the trading strategy. It supports a phased approach to live trading with `Virtual`, `Real (Paper)`, and `Real (Live)` modes.

## ✨ Key Features

-   **Multiple Trading Modes**: A safe, phased approach to live trading.
    -   `Virtual`: 100% simulation. Safe for testing and strategy optimization.
    -   `Real (Paper)`: Uses real Binance API keys for a live data feed but **simulates** trades without risking capital. The perfect final test.
    -   `Real (Live)`: Executes trades with real funds on your Binance account.
-   **Advanced Hybrid Strategy Engine**: Fuses a 'Macro-Micro Precision' model for squeeze plays with a high-speed 'Ignition' detector for volume spikes, ensuring adaptability to various market conditions.
-   **Data-Driven Scoring**: Implements a sophisticated scoring system for both market scanning (Hotlist) and trade entry, quantifying signal quality and confidence levels.
-   **Dynamic Adaptive Profiles**: Instead of a static configuration, the bot operates as a "Tactical Chameleon". When enabled, it analyzes the market's volatility and trend strength for each specific trade and automatically selects the most effective management profile: "Sniper", "Scalper", or "Volatility Hunter".
-   **Specialized Risk Management**: Features unique trade management profiles, including a lightning-fast 'Flash Trailing Stop Loss' (SL Suiveur Éclair ⚡) tailored for explosive 'Ignition' trades.
-   **Live Dashboard**: Offers an at-a-glance overview of key performance indicators (KPIs) such as balance, open positions, total Profit & Loss (P&L), and win rate.
-   **Real-time Market Scanner**: Displays the results of the market analysis, showing pairs with active trade signals, scores, and all relevant data points.
-   **Detailed Trade History**: Provides a complete log of all past trades with powerful sorting, filtering, and data export (CSV) capabilities.
-   **Fully Configurable**: Every parameter of the strategy is easily adjustable through a dedicated settings page with helpful tooltips.

---

## 🎨 Application Pages & Design

The application is designed with a dark, modern aesthetic (`bg-[#0c0e12]`), using an `Inter` font for readability and `Space Mono` for numerical data. The primary accent color is a vibrant yellow/gold (`#f0b90b`), used for interactive elements and highlights, with green and red reserved for clear financial indicators.

### 🔐 Login Page
-   **Purpose**: Provides secure access to the dashboard.

### 📊 Dashboard
-   **Purpose**: The main control center, providing a high-level summary of the bot's status and performance.
-   **Key Components**: Stat Cards (Balance, Open Positions, P&L), Performance Chart, and an Active Positions Table.

### 📡 Scanner
-   **Purpose**: To display the real-time results of the market analysis, showing which pairs are potential trade candidates.
-   **Layout**: A data-dense table with sortable columns reflecting the strategy.

### 📜 History
-   **Purpose**: A dedicated page for reviewing and analyzing the performance of all completed trades.

### ⚙️ Settings
-   **Purpose**: Allows for complete configuration of the bot's strategy, including enabling the "Dynamic Profile Selector" and setting its thresholds.

### 🖥️ Console
-   **Purpose**: Provides a transparent, real-time view into the bot's internal operations with color-coded log levels.

---

# Version Française

## 🚀 Stratégie Finale Pondérée avec Ignition + Stop Loss Suiveur ⚡

### **Phase 1 – Radar Macro (Hotlist)**

**👉 Objectif :** détecter les paires à potentiel.

| Indicateur | Condition | Score |
| :--- | :--- | :--- |
| **Tendance 4h** | Tendance de fond (MME200, RSI, MACD) | Score pondéré de -2 à +2 |
| **Tendance 15m** | Tendance locale (MME50/200, RSI, MACD) | Score pondéré de -2 à +2 |
| **Corrélation BTC/ETH** | Cohérente avec la tendance | +1 |
| **Volume Relatif** | Volume 15m vs. moyenne | 1.3× → +1, 1.5× → +2, 2× → +3 (Boost Ignition) |

**✅ Seuil d’entrée en Hotlist :** `Score ≥ 5`

---

### **Phase 2 – Déclencheur Micro & Confirmation (1m + 5m)**

| Indicateur (Bougie 1m) | Condition | Score |
| :--- | :--- | :--- |
| **Momentum** | Clôture > MME9 | +1 |
| **RSI** | Croise 50 à la hausse | +1 |
| **MACD** | Croisement haussier | +1 |
| **Volume** | > 1.5× la moyenne | +2 (Boost Ignition) |
| **Confirmation 5m** | Bougie 5m soutient le mouvement | +2 (ou 0, ou -1 si contradiction) |
| **Filtres Additionnels**| OBV, CVD, Sécurité (RSI, Mèches, etc.) | +3 (potentiel) |


**✅ Signal d’entrée :** `Score ≥ 8`

---

### **Phase 2.5 – Sélecteur de Profil Dynamique**

Analyse ADX (15m) + ATR (volatilité relative) :

| Profil | Condition (15m) | Style de Gestion |
| :--- | :--- | :--- |
| **Scalpeur** | ADX < 20, ATR bas | SL fixe (0.3%), TP rapide (0.6%) |
| **Chasseur Volatilité**| ADX > 20, ATR modéré | SL basé sur l'ATR, TP dynamique (1-2%), trailing agressif |
| **Sniper** | ADX > 25, ATR haut | Prise partielle (50% à +1%), SL à break-even, trailing large |

---

### **Phase 3 – Gestion Active & Stop Loss Suiveur ⚡**

🎯 Une fois en position :

1.  Stop Loss classique placé (selon profil).
2.  Dès que le profit atteint `≥ +0.5%`, le **Stop Loss Suiveur ⚡** est activé :
    -   Le SL est d'abord déplacé au-dessus du prix d’entrée pour garantir un trade sans perte.
    -   Ensuite, il suit le prix avec un delta serré (ex: 0.2% – 0.5%) pour sécuriser les gains tout en laissant courir le mouvement.

---

### **Règles d’Ignition (Breakout Explosif)**

Détecté si :

-   **Volume** > 1.5× (bonus), >2× (boost fort)
-   **RSI** > 55 et **MACD** positif
-   Bougie longue avec clôture au-dessus d’un niveau clé (ex: MME200)

⚡ **Action spéciale Ignition :**

-   Entrée agressive (seuil de score abaissé à 6).
-   SL serré + **Stop Loss Suiveur ⚡ obligatoire.**
-   Objectif : capter les gros breakouts sans rater l'explosion initiale.
