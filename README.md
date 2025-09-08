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

## 🧠 Stratégie Complète : “Chasseur de Précision Macro-Micro + Ignition + SL Suiveur ⚡”

La philosophie du bot est d'être un prédateur chirurgical, capable de s'adapter à différentes conditions de marché pour capturer des mouvements explosifs. Il utilise un système de notation multi-niveaux pour quantifier la qualité de chaque opportunité.

---

### **Phase 1 : Radar Macro (Génération de la Hotlist)**

**Objectif :** Identifier les paires de devises présentant un fort potentiel haussier et les placer sur une "Hotlist" pour une surveillance intensive.

| Condition | Indicateur | Score |
| :--- | :--- | :--- |
| Tendance Haussière 4h | Prix de clôture > MME50 (4h) | 3 |
| Compression Volatilité 15m | Bollinger Band Squeeze < 25% quartile sur 50 périodes | 3 |
| Filtre d'Ignition 15m | Bougie précédente avec volume > 2× moyenne + clôture proche de la bande supérieure des BB | +2 |

**Logique de la Hotlist :**
```
Score_Hotlist = Score_Tendance + Score_Bollinger + Score_Ignition
Seuil_Hotlist = 5

Si Score_Hotlist >= Seuil_Hotlist:
    Ajouter la paire à la Hotlist
    S'abonner aux flux de données 1m et 5m
```

---

### **Phase 2 : Déclencheur Micro & Confirmation (Analyse 1m + 5m)**

**Objectif :** Détecter le point d’entrée précis avec une confirmation multi-échelles pour les paires de la Hotlist, en utilisant un système de notation pour évaluer la confiance du signal.

| Condition | Indicateur | Score |
| :--- | :--- | :--- |
| Momentum 1m | Prix de clôture > MME9 (1m) | 2 |
| Volume 1m | Volume > 1.5 × moyenne récente (1m) | 1 |
| OBV 1m | OBV ascendant (1m) | 1 |
| CVD 5m | CVD ascendant (5m) | 1 |
| Clôture 5m haussière | Bougie 5m > prix de déclenchement 1m | 2 |
| Sécurité RSI | RSI 15m & 1h non suracheté | 1 |
| Mèche haute | Bougie 1m sans mèche excessive | 1 |
| Mouvement Parabolique | Pas de hausse verticale récente | 1 |
| Déclencheur d'Ignition 1m | Bougie 1m avec volume > 2× et clôture > MME9 + momentum | +2 |

**Calcul du Score de Trade :**
```
Score_Trade = somme(Scores_des_conditions)
Seuil_Trade_High = 8
Seuil_Trade_Low = 5

Si Score_Trade >= Seuil_Trade_High:
    Trade = Haute Confiance (souvent avec Ignition)
Sinon si Score_Trade >= Seuil_Trade_Low:
    Trade = Faible Confiance
Sinon:
    Pas de trade
```

---

### **Phase 2.5 : Sélecteur de Profil Dynamique**

**Objectif :** Adapter la gestion du trade au type de marché actuel en analysant la force de la tendance (ADX) et la volatilité (ATR) sur le graphique 15m.

| Profil | Condition (15m) | Style de Gestion |
| :--- | :--- | :--- |
| **Scalpeur** | ADX < Seuil_Range (ex: 20) | SL serré, TP rapide, SL Suiveur ⚡ activé pour Ignition. |
| **Chasseur Volatilité** | ATR% > Seuil_Volatil (ex: 5%) | SL basé sur l'ATR, TP dynamique, Trailing Stop agressif, SL Suiveur ⚡. |
| **Sniper** | Marché stable (défaut) | Prise partielle, Break-even, Trailing Stop, SL Suiveur ⚡ pour Ignition. |

---

### **Phase 3 : Gestion du Trade**

#### **Stop Loss Suiveur Éclair ⚡ (pour les trades d'Ignition)**

C'est une arme secrète pour les mouvements les plus explosifs.
1.  Une fois qu'un seuil de profit est atteint (ex: +0,5%), le SL se déplace agressivement au-dessus du prix d’entrée pour garantir un gain minimal.
2.  Le SL suit ensuite le prix en temps réel avec un très petit décalage (ex: 0,2%), capturant la majorité du mouvement vertical tout en se protégeant contre un retournement soudain.
3.  **Objectif :** Sécuriser les gains d'une tendance explosive tout en laissant le potentiel de hausse s'exprimer.

#### **Gestion par Profil :**

*   **Scalpeur :** Sortie rapide, SL serré, TP court, SL Suiveur ⚡ actif si Ignition.
*   **Chasseur Volatilité :** SL basé sur l'ATR, TP dynamique, Trailing Stop agressif, SL Suiveur ⚡ actif.
*   **Sniper :** Prise de profit partielle, mise à break-even, trailing stop standard, et SL Suiveur ⚡ activé si le trade a été déclenché par un signal d'Ignition.
