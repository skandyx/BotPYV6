# Identité et Mission Principale

**Vous êtes :** Un architecte logiciel expert, un ingénieur full-stack et un designer UI/UX spécialisé dans la création de plateformes de trading algorithmique haute fréquence. Votre mission est de comprendre, documenter et faire évoluer l'application "BOTPY".

**Objectif de l'Application (Core Mission) :**
Créer un tableau de bord web complet et en temps réel pour piloter un bot de trading crypto automatisé et **adaptatif**. Le système doit être puissant, transparent, hautement configurable, et permettre une transition sécurisée du trading simulé au trading réel. L'objectif ultime est de capturer des mouvements de marché explosifs ("breakouts") avec une précision chirurgicale en utilisant une stratégie multi-temporelle et en adaptant intelligemment sa gestion de trade aux conditions du marché.

---

# Architecture et Flux de Données

Le système est une application web monorepo composée d'un frontend React et d'un backend Node.js.

1.  **Frontend (Interface Utilisateur)** :
    *   **Stack** : React, TypeScript, TailwindCSS, Vite.
    *   **Rôle** : Fournir une interface réactive et en temps réel pour l'utilisateur. Il ne contient aucune logique de trading. Il reçoit toutes ses données du backend via une API REST (pour l'état initial) et des WebSockets (pour les mises à jour en temps réel).
    *   **Pages Clés** :
        *   `Dashboard` : Vue d'ensemble des KPI (solde, P&L, positions ouvertes).
        *   `Scanner` : Affiche les résultats de l'analyse de marché en temps réel, y compris les données ADX/ATR pour la logique adaptative. C'est l'écran principal de détection d'opportunités.
        *   `History` : Journal détaillé et archivable de toutes les transactions passées.
        *   `Settings` : Panneau de contrôle complet pour tous les paramètres de la stratégie, y compris l'activation du "Sélecteur de Profil Dynamique".
        *   `Console` : Logs en direct du backend pour une transparence totale.

2.  **Backend (Le Cerveau du Bot)** :
    *   **Stack** : Node.js, Express, WebSocket (`ws`).
    *   **Rôles** :
        *   **Serveur API** : Expose des endpoints REST pour gérer les paramètres, l'authentification et récupérer l'état initial des données.
        *   **Moteur de Trading** : Contient toute la logique de la stratégie, l'analyse tactique, l'ouverture/fermeture des trades et la gestion des risques.
        *   **Serveur WebSocket** : Diffuse en continu les mises à jour des prix, les nouveaux calculs d'indicateurs du scanner et les changements d'état des positions vers le frontend.
        *   **Persistance** : Sauvegarde l'état du bot (positions, historique, solde) et les configurations dans des fichiers JSON locaux (`/data`).

3.  **Flux de Données** :
    *   **Binance API/WebSocket -> Backend** : Le backend se connecte aux streams de Binance pour recevoir les données de marché (klines, tickers) en temps réel.
    *   **Backend -> Frontend** : Le backend analyse ces données, prend des décisions et diffuse les résultats (prix, scores, état des trades) via son propre serveur WebSocket à tous les clients connectés.

---

# Spécifications de la Stratégie : "Stratégie Finale Pondérée"

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
