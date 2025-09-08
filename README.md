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

### Phase 1 – Radar Macro (Hotlist)
👉 **Objectif :** détecter les paires à potentiel.
- **Tendance 4h (MME200, RSI, MACD)** → Score -2 à +2
- **Tendance 15m (MME50/200, RSI, MACD)** → Score -2 à +2
- **Corrélation BTC/ETH (si cohérente)** → +1
- **Volume relatif (vs 24h)** :
  - 1.3× → +1
  - 1.5× → +2
  - 2× → +3 (Ignition boost)
- ✅ **Seuil d’entrée en Hotlist : Score ≥ 5**

### Phase 2 – Déclencheur Micro & Confirmation (1m + 5m)
- **Bougie 1m** :
  - Close > MME9 → +1
  - RSI croise 50 à la hausse → +1
  - MACD bullish croisement → +1
  - Volume > 1.5× → +2 (Ignition boost)
- **Bougie 5m (confirmation soft)** :
  - Confirme → +2
  - Ne confirme pas mais neutre → 0
  - Contradiction forte → -1 (pas rejet complet)
- ✅ **Signal d’entrée : Score ≥ 8**

### Phase 2.5 – Sélecteur de Profil Dynamique
Analyse ADX (15m) + ATR (volatilité relative) :
- **Scalpeur** (ADX<20, ATR bas) → SL fixe 0.3%, TP rapide 0.6%
- **Chasseur Volatilité** (ADX>20, ATR modéré) → SL ATR(14), TP dynamique (1-2%), trailing agressif
- **Sniper** (ADX>25, ATR haut) → Prise partielle (50% à +1%), SL break-even, trailing large

### Phase 3 – Gestion Active & Stop Loss Suiveur ⚡
🎯 Une fois en position :
1. Stop Loss classique placé (selon profil).
2. Dès que profit ≥ **+0.5%**, activer le **Stop Loss Suiveur ⚡** :
   - SL déplacé au-dessus du prix d’entrée.
   - Puis suit le prix avec un delta (0.2% – 0.5% selon volatilité).
3. **Objectif :** sécuriser gains dès que le trade “démarre”.

### Règles d’Ignition (Breakout Explosif)
Détecté si :
- Volume > 1.5× (bonus), >2× (boost fort)
- RSI > 55 et MACD positif
- Bougie longue avec clôture au-dessus d’un niveau clé (MME200 / résistance locale)
⚡ **Action spéciale Ignition :**
- Entrée agressive (même si score < 8 → min. 6 autorisé).
- SL serré + **Stop Loss Suiveur ⚡ obligatoire**.
- **Objectif :** capter les gros breakouts sans rater l’explosion.
