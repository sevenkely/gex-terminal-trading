# GEX Terminal

Dashboard temps réel de **Gamma Exposure (GEX)**, **put/call walls** et **zero-GEX**
pour SPX, SPY, QQQ, GLD, les futures ES, NQ, GC **et le BTC en 24/7** — construit
uniquement avec des sources **gratuites**.

## Sources de données

| Donnée | Source | Frais | Latence |
|---|---|---|---|
| Chaînes d'options complètes (OI, IV, Greeks) | CBOE delayed quotes JSON (`cdn.cboe.com/api/global/delayed_quotes/options/…`) — SPX, SPY, QQQ, GLD, NDX | 0 € | ~15 min |
| Bougies historiques (5m → 1D, 2 ans), actions & futures | Yahoo Finance chart API (`^SPX`, `ES=F`, `NQ=F`, `GC=F`…) | 0 € | ~15 min |
| Ticks temps réel (actions/futures) | **SIM** par défaut (random walk calibré sur l'IV30) — **Rithmic** prêt à brancher | 0 € / compte Rithmic | live |
| **BTC** : chaîne d'options (OI, IV, échéances quotidiennes), spot, bougies et tape | **Deribit** API publique v2 (`get_book_summary_by_currency`, `get_tradingview_chart_data`, WS `deribit_price_index.btc_usd` + `trades.*.100ms`) | 0 €, **sans compte ni clé** | temps réel |

## Futures : zones GEX projetées

Les futures n'ont pas de chaîne d'options « dealer gamma » exploitable
gratuitement — la pratique standard est de **projeter le GEX du sous-jacent
cash** sur le future :

- **ES** ← GEX de **SPX**, transposé via le **basis** (additif, ex. +29,75 pts)
- **NQ** ← GEX de **NDX**, via le basis
- **GC** ← GEX de **GLD**, via un **ratio** (×~10,94)

Le basis/ratio est recalculé toutes les 15 min depuis les cotations Yahoo
(ES=F vs chaîne CBOE). Tous les niveaux (walls, zero-GEX, vol triggers) et le
profil par strike sont shiftés sur l'échelle du future — les zones tombent
directement sur les bougies ES/NQ/GC. Rithmic fournit ensuite le tick live
du future (badge RITHMIC LIVE) ; les zones continuent de venir du cash.

> Alternative avancée : calculer un « FEX » natif sur les options CME (ES
> options) — Rithmic les diffuse avec l'abonnement market data CME, mais le
> positionnement dealer y est très différent (principalement du hedging
> end-user). Le proxy SPX reste la référence du marché.

## Méthodologie GEX

Convention classique « hedge-dealer » (style SpotGamma / SqueezeMetrics) :

- Dealers supposés **longs calls, courts puts**.
- `GEX = signe × gamma × OI × spot² × 0.01 × 100` ($ par mouvement de 1 %).
- Les Greeks sont **re-pricés en Black-Scholes** (IV de la chaîne, r = 4 %) à chaque
  tick : les walls bougent donc avec le spot, comme sur un vrai desk.
- **Call wall** = strike au **plus gros OI calls** au-dessus du spot (bande ±10 %,
  convention SpotGamma) ; **Put wall** = plus gros OI puts en-dessous. Basés sur
  l'OI (et non sur l'argmax du gamma) car le gamma ATM des 0DTE explose en fin
  de journée et ferait flipper les walls à chaque tick.
- **Pics gamma** (call/put) affichés en référence intra-journalière dans la carte.
- **Zero GEX** = niveau où le gamma net agrégé change de signe
  (scan ±14 % autour du spot, 161 points).
- **Vol Trigger / Expected move** = spot ± 1σ quotidien (IV30 / √252).
- Options sans IV (profondément ITM/OTM) : gamma du feed mis à l'échelle (S₀/S)².
- Filtres d'échéance : ALL, 0DTE, ≤7D, ≤35D.

Limites assumées : pas de dividendes dans le re-pricing (biais minime sur SPY/QQQ/GLD),
OI mis à jour une fois par jour par le CBOE (publication EOD — comme partout ailleurs),
hypothèse de positionnement dealer simplificatrice.

## Architecture

```
backend/
  app.py            FastAPI — REST + WebSocket /ws/{symbol}, refresh chaînes /15 min
  gex.py            Moteur GEX vectorisé numpy (profil par strike, walls OI, zero-GEX)
  cboe.py           Fetch + cache disque des chaînes CBOE (TTL 15 min)
  history.py        Bougies Yahoo (cache 5 min) + quotes futures (basis/ratio)
  live_feed.py      PriceEngine : SIM (défaut) ou ticks externes Rithmic, par symbole
  rithmic_bridge.py Connexion Rithmic (async_rithmic) : front-month auto, direct/anchor
frontend/
  index.html / styles.css / app.js   (Lightweight Charts v5 + polices auto-hébergées)
data/               cache JSON (chaînes, historique) + rithmic_config.json
```

## Lancer en local

Prérequis : **Python 3.11+** et une connexion Internet (CBOE + Yahoo Finance).
Aucune clé API n'est nécessaire.

```bash
# 1. dépendances (fastapi, uvicorn, httpx, numpy)
pip install -r requirements.txt

# 2. serveur (API + interface)
cd backend
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Puis ouvrir **http://localhost:8000** dans un navigateur.

Notes :
- le premier chargement prend 10–30 s (téléchargement des chaînes CBOE) ;
- hors séance (cash : RTH 9 h 30–16 h ET ; futures : dim 18 h → ven 17 h,
  pause 17-18 h), les ticks SIM sont **figés** : le prix ne dérive plus marché
  fermé — le compteur de ticks et l'horloge continuent de tourner ;
- le dossier `data/` est créé automatiquement à la racine du projet :
  cache des chaînes, préférences (dont identifiants Rithmic) et journal des
  snapshots GEX (`data/gex_hist/*.jsonl`, alimenté toutes les 15 min) ;
- supprimer `data/` réinitialise cache et préférences ;
- les données CBOE sont différées (~15 min) et Yahoo Finance gratuit ;
  Rithmic (optionnel) se branche depuis l'interface ⚙️ → « Connecter Rithmic ».

## Pane GEX (overlay gamma synchronisé)

Bouton **GAMMA** (actif par défaut) : un canvas superposé au chart, aligné sur
l'axe de prix, dessine en direct :

- **zones gamma ombrées** — une bande horizontale par strike, teinte rouge
  (GEX net négatif = régime court gamma, le prix y est « aimanté ») ou verte
  (GEX positif = amortissant), alpha proportionnel à l'intensité ;
- **histogramme du GEX net par strike** dans une gouttière à droite du plot
  (échelle sqrt pour compresser la dominance 0DTE), avec marqueurs
  triangulaires des walls et losange du zero-GEX en bord de gouttière ;
- **cône ±1σ de session** projeté depuis le dernier prix (largeur = expected
  move issu de l'IV), en pointillés bleus.

Redessiné à chaque tick / zoom / pan / resize via `priceToCoordinate()` ;
toggle GAMMA pour revenir au chart nu (le rightOffset du chart s'ajuste pour
laisser la place au cône).

### Timeframes & visibilité des niveaux

- Intervalles : **1m, 5m, 15m, 30m, 1H, 1D** (Yahoo : 1m→7 j, 30m→60 j).
  Au changement d'intervalle, zoom « smart » (~2-5 séances lisibles) au lieu
  d'un fitContent intégral, avec garde anti-race si on clique vite.
- En intraday, l'autoscale colle aux bougies et les walls peuvent sortir de
  l'écran : des **chips de rappel** « ▲ CW 8,000 » / « ▼ PW 7,000 » s'épinglent
  alors en haut/bas du plot (overlay gamma).
- Bouton **NIVEAUX** : force l'échelle de prix à inclure call wall, put wall et
  zero-GEX (autoscaleInfoProvider) — les lignes GEX redeviennent visibles sur
  n'importe quel timeframe.

## Simulateur de scénario (what-if)

Bouton **SCÉNARIO** : deux sliders — choc de spot (−5 % → +5 %) et choc d'IV
(−10 → +10 points de vol) — re-pricent en direct la chaîne du jour
(Black-Scholes, open interest inchangé) et affichent :

- les niveaux du scénario (zero-GEX, call/put walls) en lignes orange
  pointillées sur le chart, avec l'écart en points vs les niveaux actuels ;
- le régime gamma et le GEX net du scénario dans le panneau.

Endpoint : `GET /api/scenario/{sym}?dspot=-0.05..0.10&div=-15..15&filter=…`
(re-pricing vectorisé numpy, ~30 ms, exécuté hors boucle asyncio).

## Interface vivante

- prix animés (odometer 420 ms) sur le gros prix et les onglets ;
- sparkline 5 min (40 bougies) dans chaque onglet, alimentée en direct par les
  ticks WebSocket (dégradé vert/rouge selon le sens de la séance) ;
- countdown « maj CBOE dans mm:ss » dans la barre d'état, calé sur le prochain
  pull serveur du CDN CBOE (cycle 15 min) ;
- flash vert/rouge du prix à chaque tick.

## Heatmap GEX

Bouton **HEATMAP** dans la barre d'outils du chart. Deux modes :

- **SESSION** : reconstruction honnête de la journée en cours — l'OI et les IV
  de la chaîne du jour sont re-pricés Black-Scholes aux closes historiques
  Yahoo (5m / 15m / 1h), donc chaque colonne = « quel était le GEX si le spot
  avait été ce close ». Onglets futures (ES/NQ/GC) : calcul sur la chaîne
  source puis conversion spot/strikes à l'échelle futures via le basis.
- **HIST** : journal accumulé des profils GEX agrégés toutes les 15 min
  depuis le démarrage du serveur (`data/gex_hist/`), donc multi-sessions.

Contrôles : intervalle 5m/15m/1h, fenêtre de strikes ±3/5/8 %, filtre
d'échéances hérité du profil (ALL/0DTE/±7D/±35D). Rendu canvas : normalisation
par colonne (alpha^0.6), vert = GEX positif / rouge = négatif, ligne blanche =
trajectoire du spot, pointillés = call/put walls, tooltip au survol
(date · strike · GEX en M$). Endpoint : `GET /api/heatmap/{sym}?mode=session|hist
&interval=5m|15m|1h&range=0.01..0.15&filter=all|0dte|7d|35d` (cache 120 s).

## Brancher Rithmic (temps réel) — depuis l'interface ⚙️

1. Cliquer sur l'engrenage en haut à droite du dashboard.
2. Choisir un **préréglage** (Rithmic Test / Paper Trading / Live Chicago…) ou
   saisir le `system_name` + `gateway URL` fournis par votre broker.
3. Entrer l'**app ID** (utilisateur) et le **mot de passe** Rithmic.
4. Ajuster les **abonnements** si besoin : exchange, contrat (vide = front-month
   auto-résolu via l'API Rithmic) et mode :
   - `direct` : le prix du contrat alimente l'onglet tel quel (ES/NQ/GC) ;
   - `anchor` : les variations Rithmic pilotent l'onglet cash (SPX/SPY/QQQ/GLD)
     sans saut de basis — l'offset est calculé au premier tick.
5. **Enregistrer & Connecter** → le badge passe de « SIM » (jaune) à
   « RITHMIC LIVE » (vert) pour les onglets alimentés.

Détails techniques :

- Librairie : [`async-rithmic`](https://async-rithmic.readthedocs.io) (pure Python,
  protobuf/websocket — `pip install -r requirements.txt`).
- La config est stockée dans `data/rithmic_config.json` (**mot de passe en
  clair** — privilégiez un compte paper ; ne versionnez pas ce fichier).
- Si les ticks Rithmic deviennent silencieux (> 20 s), l'onglet repasse
  automatiquement en SIM. En cas d'échec de connexion, le message d'erreur est
  affiché dans la modale (identifiants, gateway, conformance…).
- Les gateways de **production** peuvent exiger le test de conformance Rithmic ;
  commencez avec « Rithmic Test » (`rituz00100.rithmic.com:443`) ou le gateway
  indiqué par votre broker (Apex, Topstep, AMP…).

> Note : Rithmic ne diffuse pas la chaîne d'options SPX/SPY — il sert le **prix
> temps réel** (futures) ; le GEX vient de la chaîne CBOE. C'est l'architecture
> standard : OI = quotidien, spot = live.

> **Ce que sert chaque gateway** (relevé avec le template 20 du R|Protocol, puis
> le template 16 sur chaque host) :
>
> | Host | Systèmes servis |
> |---|---|
> | `rituz00100.rithmic.com:443` (kit) | `Rithmic Test` uniquement |
> | `rprotocol-ie` (Europe), `rprotocol-de` (Francfort), `rprotocol-sg` (Singapour) | 24 systèmes, dont `Rithmic Paper Trading`, `Apex`, `Tradeify`, `Rithmic 01`… |
> | `rprotocol-mobile` (Chicago Area) | coupe la poignée de main TLS hors application mobile — inutilisable depuis un client desktop |
>
> Vérification en une commande, sans identifiant :
> `python backend/rithmic_client.py --systems` et `--gateways`.
>
> **Conformance** : elle authentifie, mais ne relaie **ni flux CME ni données de
> référence** (`rp_code 7 / no data` sur les abonnements, pas de front-month) —
> c'est un environnement de tests d'ordres. Le dashboard reste donc en SIM même
> une fois connecté, et le message de statut l'indique explicitement. Pour des
> ticks réels il faut un compte market data (paper d'un broker/prop firm), avec
> le couple `system_name` + host indiqué dans l'e-mail d'inscription.

## Client R| Protocol autonome (`backend/rithmic_client.py`)

Client WebSocket + protobuf **indépendant** de l'app (aucun import FastAPI) :
utilisable en console, en script ou comme brique du backend.

```bash
cd backend
python rithmic_client.py --systems                     # template 16
python rithmic_client.py --gateways                    # template 20
python rithmic_client.py --symbol NQ --exchange CME    # trades + BBO en console
python rithmic_client.py --symbol NQ --duration 30     # écoute bornée
```

Ce qu'il implémente, valeurs prises dans `0.90.0.0/samples/samples.py/SampleMD.py` :

| Étape | Template | Détail |
|---|---|---|
| Login | 10 → 11 | `infra_type = TICKER_PLANT`, `template_version = "5.55"`, `rp_code` vérifié |
| Logout | 12 → 13 | fermeture propre (code 1000) |
| Systèmes du gateway | 16 → 17 | `--systems` |
| Heartbeat | 18 → 19 | envoyé dès que le flux est muet depuis `heartbeat_interval/2` (60 s sur la conformance) |
| Gateways R|Protocol | 20 → 21 | `gateway_name` / `gateway_uri` |
| Abonnement | 100 → 101 | `LAST_TRADE \| BBO` ; `rp_code 7` = « no data » expliqué dans les logs |
| Flux | 150 / 151 | `LastTrade` (prix, taille, aggressor) et `BestBidOffer` |

Reconnexion automatique (backoff 1→30 s, réabonnement, arrêt sur erreur fatale
type `rp_code 13`), et messages d'erreur explicites : `rp_code` + libellé,
socket fermé avec code/raison, `RITHMIC_USER`/`RITHMIC_PASS` manquants.

### Bindings protobuf

Générés depuis les `.proto` du kit dans `backend/rithmic_pb/` (le kit ne livre
que des `*_pb2.py` compilés pour protobuf 2.6, incompatibles avec protobuf 4+) :

```bash
pip install grpcio-tools          # fournit protoc (build seulement)
cd backend
python -m grpc_tools.protoc -I rithmic_pb_src --python_out=rithmic_pb \
  rithmic_pb_src/request_login.proto rithmic_pb_src/response_login.proto \
  rithmic_pb_src/request_heartbeat.proto rithmic_pb_src/response_heartbeat.proto \
  rithmic_pb_src/request_rithmic_system_info.proto rithmic_pb_src/response_rithmic_system_info.proto \
  rithmic_pb_src/request_rithmic_system_gateway_info.proto rithmic_pb_src/response_rithmic_system_gateway_info.proto \
  rithmic_pb_src/request_market_data_update.proto rithmic_pb_src/response_market_data_update.proto \
  rithmic_pb_src/last_trade.proto rithmic_pb_src/best_bid_offer.proto \
  rithmic_pb_src/request_logout.proto rithmic_pb_src/response_logout.proto
```

`rithmic_pb_src/` est l'extraction des `.proto` du kit ; `rithmic_pb/` contient
les modules générés (importés au runtime). Seule dépendance runtime :
`protobuf` (déjà tirée par `async-rithmic`).

## Onglet BTC (Deribit, 24/7)

Aucun compte, aucune clé : tout vient de l'API **publique** Deribit.

- **Chaîne d'options** (`backend/deribit.py`) : 774 contrats OI > 0, OI en
  contrats de **1 BTC** → multiplicateur 1 dans `gex.Chain` (au lieu de 100
  actions), donc le GEX est directement en dollars par mouvement de 1 %.
  Deribit ne fournit pas de gamma par contrat : le profil est re-pricé en
  Black-Scholes à partir de la mark IV, et l'IV30 est la moyenne pondérée par
  l'OI des échéances 20-40 jours (~37 % mi-octobre).
- **Rafraîchissement** : 60 s (l'OI et l'IV bougent en continu) contre 15 min
  pour le CBOE.
- **Prix temps réel** : `deribit_price_index.btc_usd` en WebSocket (~1 tick/s).
  Le chip marché affiche « 24/7 · CRYPTO » et le mode « DERIBIT LIVE ».
- **Bougies** : `get_tradingview_chart_data` sur `BTC-PERPETUAL` (mêmes
  intervalles 1m → 1D que Yahoo côté actions).
- **Échéances** : Deribit cote **tous les jours** — le filtre `0DTE` du profil
  isole donc réellement l'échéance du jour (expiration 08:00 UTC = 04:00 ET).

Limites assumées : l'OI Deribit est agrégé (pas de ventilation par exchange),
les seuils du tape sont calés sur des distributions mesurées en marché calme,
et l'absorption sur options ne peut se déclencher que si le ruban options est
actif (quelques prints/minute en journée, presque rien le week-end).

## Flux d'ordres — gros trades & absorption (onglet FLUX)

Alimenté par les **ticks Rithmic** (tape : prix, taille, aggressor BUY/SELL —
indisponible en SIM) **ou, pour BTC, par le tape Deribit** (`?src=perp` sur le
notionnel du perp, `?src=options` sur la prime payée). Backend : `backend/flow.py`.

- **Delta agressif séance** : volume achats − ventes (aggressor Rithmic, repli
  sur le croisement prix/BBO si absent), remis à zéro chaque séance ET.
- **Gros trades** : print dont la taille ≥ max(10, 8 × taille médiane glissante
  300 prints) — seuil adaptatif affiché dans le panneau, liste horodatée avec
  côté (ACHAT/VENTE).
- **Absorption** (heuristique) : volume agressif concentré sur 6 s ≥
  max(40, 12 × médiane) **sans mouvement de prix** au-delà de 2 ticks → les
  ordres passifs absorbent l'agression (toast + ligne colorée ; cooldown 25 s
  par côté). « ACHATS ABSORBÉS » = agression acheteuse encaissée par des
  vendeurs passifs (biais vendeur), et inversement.
- La vue suit le contrat sous-jacent de l'onglet (SPX→ES, QQQ→NQ, GLD→GC…),
  rafraîchie toutes les 2,5 s. Sans compte Rithmic connecté : panneau vide
  avec explication.

### Bulles gros trades & absorptions sur le chart (style Deepchart)

Calque dédié (`#flow-canvas`, canvas 2D entre les niveaux GEX et les dessins) :
chaque **gros print** devient une bulle pleine au prix exact et à l'heure exacte
du trade, colorée par l'agresseur (vert = achat, rouge = vente) et **dimensionnée
en √notionnel** par rapport au plus gros print affiché ; le montant s'écrit dans
la bulle dès ~13 px. Les **absorptions** sont des bulles à anneau pointillé (« ABS »)
dont la couleur suit le signal de contrepartie (achats absorbés = rouge) et le
rayon le volume absorbé. Les bulles s'estompent avec l'âge (constante 90 min) et
sont bornées aux 160 derniers gros prints / 80 dernières absorptions.

- Survolez une bulle : infobulle (type, côté, notionnel, seuil, instrument, heure).
- Le bouton ⌾ de la barre d'outils (ou Ctrl+K) masque/affiche les bulles
  (persisté `gex.bubbles`). Les bulles ne créent pas de séries Lightweight
  Charts : elles suivent le zoom/pan/tick comme les tracés, sans jamais peser
  sur l'échelle de prix.

## Feed crypto autonome (`crypto_feed/`) — Deribit + Binance/Bybit

Module asyncio **indépendant du dashboard** (aucun import FastAPI, aucune clé),
utilisable seul ou comme bibliothèque. Deux pipelines concurrents alimentent un
état partagé ; `get_state()` en renvoie un instantané JSON cohérent.

```
crypto_feed/
├─ main.py          point d'entrée : MarketFeed + CLI + get_state
├─ config.py        config centralisée (dataclass + surcharge CRYPTO_FEED_* / CLI)
├─ options.py       Deribit REST : chaîne, OI par strike, murs, GEX Black-Scholes
├─ tape.py          WS Binance aggTrade → Bybit publicTrade, delta/CVD, carnet L2
├─ state.py         état partagé (asyncio.Lock) + snapshot JSON
└─ tests_offline.py tests sans réseau (parsing, BS, murs, seuils, carnet)
```

```bash
python -m crypto_feed --once --json                       # un snapshot puis sortie
python -m crypto_feed                                     # BTC, console, options toutes les 3 min
python -m crypto_feed --currency ETH --symbol ETHUSDT     # ETH USDT perp
python -m crypto_feed --expiry 0dte --cvd-reset session   # 0DTE + delta de session
python -m crypto_feed --depth --source bybit              # carnet L2 via Bybit
python -m crypto_feed.tests_offline                       # tests hors ligne
```

```python
from crypto_feed import MarketFeed, get_state
feed = MarketFeed()
await feed.start()
state = await get_state()          # options + flow + depth + feed
top = state["options"]["call_wall"]; print(top["strike"], top["oi"])
```

**1) Options (Deribit, public REST).** `public/get_book_summary_by_currency`
(kind=option) → parsing `BTC-27MAR26-90000-C`, filtre d'échéance `all|0dte|weekly|monthly`,
OI calls/puts par strike, **GEX en dollars par variation de 1 %** :
`Γ · OI · contract_size · S² · 0,01`, Γ recalculé en Black-Scholes à partir de la
mark IV (call positif, put négatif — convention dealers long calls / short puts,
assumée comme telle). Sorties : `call_wall`, `put_wall` (+ second mur),
`zero_gamma` (interpolation du passage à zéro du GEX cumulé), `net_gex`, `iv30`,
et la liste complète `strikes`. Rafraîchissement 3 min, retry/backoff 2→16 s avec
jitter ; une chaîne momentanément vide ne tue jamais le feed.

**2) Flux d'ordres (Binance → Bybit).** `btcusdt@aggTrade` en WebSocket :
`m = true` ⇒ acheteur maker ⇒ **vente agressive** (`buy = not m`) ; taille × prix
= notionnel USD, c'est l'unité des seuils. Delta = notionnel signé, **CVD remis à
zéro par bougie** (`--cvd-candle 30s|1m|5m|15m|1h`) **ou par session**
(`--cvd-reset`, paramétrable), avec série des bougies closes et delta de séance
jamais remis à zéro. **Gros trade** : notionnel ≥ `--big-trade-usd` (50 k$ par
défaut). **Absorption** : ≥ `--absorb-usd` (250 k$) de notionnel agressif d'un
même côté sur `--absorb-window` (6 s) **sans** mouvement de prix au-delà de 1,5 bps
(cooldown 20 s par côté). Carré d'un reset d'orphelin : `--depth` ajoute le flux
`@depth@100ms` avec snapshot REST + contrôle des `updateId` (resynchronisation
si trou), ou `orderbook.50` chez Bybit, et publie `imbalance`/`spread_bps`.

**Bascule de source, mesurée sur ce réseau.** L'ordre essayé est
`binance:aggTrade → binance:trade → bybit`, avec deux déclencheurs distincts :
l'**erreur** (HTTP 451 / 403 au handshake, sonde REST `/fapi/v1/time`) et le
**silence** (connexion acceptée mais aucune donnée pendant 12 s — proxy qui
filtre le flux). Un stream déclaré muet/refusé est mis de côté 5 min puis
retesté, sans redémarrer le process. C'est ce qui se passe ici : `@aggTrade`
reste muet alors que `@trade` diffuse, donc le feed bascule seul et l'état
expose `feed.source` / `feed.stream` / `feed.error` / `feed.reconnects`.

**3) État exposé.** `get_state()` → `{options, flow, depth, feed, counters, config}`
avec `flow.big[]` et `flow.absorb[]` (seq, ts, prix, notionnel, côté) prêts à
afficher, tous les timestamps en UTC (`ts` epoch + `ts_iso`). Aucune variable
partagée mutée sans passer par l'état : les deux pipelines publient, l'appelant
lit une copie profonde.

## API

- `GET /api/flow/{SYM}` — gros trades, absorption et delta du contrat sous-jacent (Rithmic)
- `GET /api/flow/{SYM}/bars?interval=5m&limit=240&src=perp|options` — delta agressif et CVD **par bougie** (agrégés du tape : bougies closes + bougie en cours)
- `GET /api/derivs/{SYM}` — structure par terme de l'IV ATM, skew 25Δ, OI call/put et max pain par échéance
- `GET /api/symbols` — méta + prix live des 7 onglets + sparklines 5 m + prochain refresh CBOE
- `GET /api/gex/{SYM}?filter=all|0dte|7d|35d` — profil complet + niveaux
- `GET /api/scenario/{SYM}?dspot=…&div=…&filter=…` — profil re-pricé à spot/IV hypothétiques
- `GET /api/heatmap/{SYM}?mode=session|hist&interval=5m|15m|1h&range=…&filter=…` — matrice GEX temps × strikes
- `GET /api/history/{SYM}?interval=1m|5m|15m|30m|1h|1d` — bougies
- `GET /api/basis/{SYM}` — historique 5 j (échantillons 5 m) du basis/ratio future−cash
- `GET /api/alerts/{SYM}` — journal des franchissements (zero-GEX, walls)
- `GET /api/depth/{SYM}` — carnet d'ordres L2 (Rithmic connecté, mode direct)
- `GET|POST /api/rithmic…` — config + statut + connect/disconnect
- `WS /ws/{SYM}?filter=…` — ticks + niveaux re-pricés + alertes (profil complet tous les 5 ticks)

## Alertes de franchissement

Une boucle serveur surveille chaque tick : quand le prix **croise** le zero-GEX,
la call wall ou la put wall (changement de côté), une alerte est journalisée
(cooldown 90 s par niveau) et poussée aux clients WebSocket → toast + flux
« Alertes de franchissement » dans la sidebar.

## Bande delta / CVD sous le chart

Un tape vaut mieux qu'un delta agrégé : `flow.SymbolFlow` agrège maintenant le
tape en bougies (`BAR_PERIODS` : 30s → 1d, `BAR_HISTORY` = 420 par contrat) et
`/api/flow/{SYM}/bars` renvoie `{t, o, h, l, c, buy, sell, vol, n, delta, cvd}`.

- **Rendu** (`#delta-canvas`, calque en bas du `#chart-area`, 92 px au-dessus de
  l'axe du temps) : histogramme de delta agressif (vert/rouge, échelle = |Δ|max)
  autour d'une ligne zéro, et **CVD cumulé** en trait fin cyan, avec les bornes
de l'échelle à droite et un point sur la dernière valeur.
- **Alignement** : les bougies du tape sont posées sur l'axe temps du chart
  (`timeToCoordinate`, repli sur la date ISO en 1D), largeur = médiane des écarts.
- **Légende** (`#delta-legend`) : achats / ventes / CVD + Δ et CVD courants,
  nombre de bougies ; rafraîchie toutes les 15 s et à chaque changement de TF
  ou de source (perp / options).
- **Pas de tape = pas de bande** : le calque disparaît complètement (les ticks
  CME demandent un compte Rithmic, la crypto un tape Deribit).
- Limite assumée : l'agrégation commence au démarrage du serveur, aucun
  backfill historique n'est fabriqué.

## Zone droite nettoyée

- **Cône ±1σ supprimé** : plus de projecteur triangulaire depuis la ligne de
  prix ; l'expected move reste dans les tuiles, les lignes ±1σ et l'éventail de
  la Zone Map.
- **Axe volume masqué** (`priceScale("vol").visible = false`) et histogramme de
  volume coincé entre le prix et la bande delta.
- **Gouttière GEX réduite** (108 → 64 px) : l'histogramme par strike laisse
  respirer le chart.
- **Chips anti-collision** : les labels de niveaux remplissent toute la largeur
  de l'axe (masque opaque derrière, plus de prix du scale qui transparaît),
  se poussent vers le bas puis remontent si ça déborde, sans jamais
  descendre sur l'axe du temps ; un trait de rappel relie la chip décalée au
  strike réel. Top 3 walls de chaque côté + flip + max pain.
- **Strike ladder déplacé dans la sidebar** (carte au-dessus du profil GEX) :
  le chart récupère ses 150 px de largeur. Même rendu (put OI | strike + barre
  γ net | call OI, badges C1/P1, flip, POC, pin, clic = épingler).

## Panneau Dérivés (skew & structure par terme)

Onglet **DÉRIVÉS** (visible pour BTC, chaîne Deribit) : `backend/derivs.py`
regroupe les contrats par échéance et renvoie pour chacune

- l'**IV ATM** interpolée en log-strike entre les deux strikes encadrant le spot,
- le **skew 25Δ** = IV put 25Δ − IV call 25Δ (points de vol, delta Black-Scholes
  à r = q = 0) avec les IV 25Δ des deux ailes,
- l'**OI call / put** et le **max pain** de l'échéance (strike qui minimise le
  payout OI).

Le panneau affiche le skew « front » (moyenne des 3 premières échéances
liquides), l'IV ATM, le ratio put/call, une **courbe de structure par terme**
(canvas, aire + points + labels d'échéance) et le tableau échéance / skew /
OI / max pain. Rafraîchi toutes les 60 s.

## Règles d'alerte personnelles & réaction des niveaux

En plus des franchissements serveur (zero-GEX / walls), l'onglet ALERTES porte
deux cartes client :

- **Règles personnelles** (persistées `gex.rules`) : *Franchit* (CW1, PW1, FLIP,
  MAX PAIN, VWAP ou prix fixe), *Approche ≤ N bps* d'un niveau (réarmement à
  1,8× le seuil), *Régime γ devient* LONG/SHORT. Évaluées à chaque tick
  (`checkRules`), déclenchement = toast ambre, bip (si SON), pulse sur le
  niveau et ligne horodatée dans le journal (`gex.rlog`, 40 entrées).
- **Réaction des niveaux** : sur l'historique affiché, chaque touche (mèche qui
  traverse le niveau, une par passage) est suivie sur 5 bougies → nombre de
  touches, % de **tenue** (clôture du même côté qu'à la touche) et **mouvement
  moyen** en bps, avec barre proportionnelle. Recalculé au chargement et toutes
  les 30 s.

## Design v4 — identité « Desk » + pièces signatures

Direction A (identité) + deux pièces signatures, suite du plan A→B→C→D :

- **Flat design** : radius 2-3 px, hairlines 1 px, zéro blur/glass ; séparations
  par contraste et filets. Palette resserrée : encre/graphite + vert (call) /
  rouge (put) / ambre (flip, POC) ; bleu & cyan décoratifs → steel gris-bleu
  (EM, bandes VWAP, VAH/VAL).
- **Typo** : Inter (UI, caps trackés .14em sur les titres de cartes) +
  JetBrains Mono tabular-nums pour toutes les données ; 3 corps.
- **Tape ticker** : bande défilante sous le header (instruments + chg %,
  Γ net + régime, flip en bps, CW1/PW1, VWAP, heure de chaîne) ; pause au
  survol ; rafraîchie par tick WS (throttle 5 s).
- **Heatmap GEX temps × strike** (`#gex-strip`, colonne 92 px à droite du
  chart, alignée sur l'axe prix) : une colonne par snapshot 15 min du journal
  (`/api/heatmap?mode=hist`), couleur divergente verte/rouge en |v|^0.6,
  point blanc = spot du snapshot, dernière colonne = profil live. Toggle HEAT γ.
- **VWAP session + volume profile** : calcul client sur les bougies du jour
  ET (repli 2 jours si <12 bougies) ; VWAP blanche 1.6 px + bandes ±1σ/±2σ
  steel ; profile TPO 56 buckets à gauche (alpha .16), POC ambre, VAH/VAL
  pointillés (value area 70 %). Toggles VWAP / PROFILE.
- Layout : `#chart-wrap` = flex [#chart-area | #gex-strip] ; aside dupliqué
  corrigé ; thèmes daylight/oled héritent de la palette steel.
- Rendu : previews/14_identity_vwap_heat.png.

À venir (plan) : B = cockpit (rail sidebar, strike ladder façon DOM, HUD
crosshair, ruban de session), C-reste = step-lines + marqueurs de
franchissement + pin gauge, D = motion/micro-feedback + presets SCALP/SWING/
MACRO + thème phosphor.

## Design v5 — cockpit B/C/D (plan A→B→C→D complet)

- **B · Cockpit** : strike ladder façon depth-of-market (colonne 150 px :
  put OI | strike + barre γ net | call OI, badges C1…/P1…, ligne flip teintée,
  POC pointillé, clic = pin, survol crosshair surligné) ; HUD crosshair
  (strike survolé, γ net, OI C/P, distances bps à CW1/PW1/FLIP) ; rail 46 px
  quand la sidebar est repliée (SPOT/CW1/PW1/FLIP/Γ NET) ; ruban de session
  en bas (colonnes colorées vs VWAP, points blancs = crosses VWAP, polyline
  du rendu cumulé).
- **C · compléments** : marqueurs de franchissement ▲/▼ sur CW1/PW1/FLIP avec
  compteur « ×n » dans les chips d'axe ; step-lines de dérive des walls/flip
  depuis le journal 15 min (champs cw/pw/fl ajoutés aux snapshots + renvoyés
  par /api/heatmap?mode=hist) ; PIN SCORE (tile + gauge conic) :
  100·exp(−|spot−flip|/σ daily), +15 si long gamma.
- **D · motion & identité** : flash vert/rouge du prix héros à chaque tick ;
  pulses annulaires + toast + bip WebAudio optionnel (bouton SON, défaut off)
  sur alerte de franchissement ; presets SCALP / SWING / MACRO (TF, fenêtre,
  toggles, ladder persistés) ; thème PHOSPHOR (CRT vert sur noir, scanlines).
- Rendus : previews/15_cockpit_bcd.png (scalp), 16_phosphor.png,
  17_rail_46px.png.

## Murs top-N & rendu pro (SpotGamma / MenthorQ / GEXBot)

Refonte du rendu des walls (follow-up 10) : chaque niveau est une **ligne
horizontale fine pile sur son strike**, plus de zones larges.

- **Calcul par strike** : call OI, put OI, call GEX, put GEX, net GEX agrégés
  par strike ; GEX = gamma x OI x 100 x spot^2 x 0.01 (calls +, puts -).
  Bug corrigé au passage : l'IV du feed CBOE est en décimal (0.15 = 15 %) et
  était divisée par 100 -> gamma BS quasi nul sur la majorité des contrats.
- **Niveaux** : CW1..CW5 = top 5 strikes au-dessus du spot classés par call
  GEX ; PW1..PW5 = top 5 en dessous par |put GEX| ; gamma flip = strike où le
  GEX net cumulé croise zéro (sinon zero-GEX re-pricé) ; max pain = strike
  minimisant le payout total ; walls structurels OI +/-10 % conservés en
  contexte (drapeaux de la zone map).
- **Fenêtre** : strikes candidats dans +/-win % du spot (défaut 3 %, réglable
  +/-1/2/3/5/8 % dans la sidebar) -> murs toujours visibles en intraday.
- **Rendu** : #1 ligne pleine 2 px, secondaires 1 px avec opacité
  proportionnelle à la magnitude ; call = vert, put = rouge, flip = jaune,
  max pain = blanc pointillé ; bande étroite +/-0.25 x espacement sous les #1
  (toggle BANDES) ; chips d'axe « CW1 7,700 | $8.7B » ; histogramme GEX net par
  strike à axe zéro central (vert à droite, rouge à gauche) ; toggles
  CW/PW/FLIP/PAIN/HIST/BANDES persistés (localStorage gex.ltgl).
- **Échéances** : sélecteur 0DTE / <=7j / <=35j / ALL (carte Profil GEX) —
  pilote désormais tout le moteur de niveaux (API + WebSocket).
- **Futures** : chaque strike des murs, du flip, du max pain et de
  l'histogramme est projeté via la basis (ES/NQ) ou le ratio (GC).
- Rendus : previews/13_walls_pro.png (défaut + zooms).

## Design v3 (thèmes, architecture, vivant, dessin)

- **3 thèmes** persistés : Midnight (défaut), Daylight (salle de marché claire),
  OLED (noir profond) — via ⚙️ → Apparence ou Ctrl+K. Tout le chart (grilles,
  axes, crosshair) et les surfaces suivent via variables CSS.
- **Couleurs de bougies personnalisables** : pickers hausse/baisse + 4 presets
  (Classique, Daltonien, Cyber, Mono) ; répercutées sur mèches, volume,
  sparklines et héro. Persistées (localStorage `gex.colors`).
- **Héro v2** : prix en dégradé selon le sens, sparkline de fond, badge de
  régime gamma (LONG/SHORT).
- **Sidebar à onglets** GEX / ALERTES / FUTURES, repliable (◀) ; **mode ZEN**
  (chart plein écran) ; **palette de commandes Ctrl+K** (symboles, intervalles,
  thèmes, toggles, outils).
- **Vivant** : skeletons de chargement sur les tiles, toasts v2 glass,
  micro-interactions (hover/glow), tour guidé en 5 étapes au premier lancement
  (rejouable via Ctrl+K → « Rejouer le tour guidé »).
- **Outils de dessin** (barre verticale gauche du chart) : trendline, ray,
  ligne horizontale, ligne verticale, rectangle/zone, retracement Fibonacci ;
  outil curseur pour sélectionner/déplacer (poignées aux extrémités), couleur +
  épaisseur par tracé, Ctrl+Z pour annuler, corbeille pour tout effacer.
  Tracés persistés par symbole (localStorage `gex.draw.{SYM}`), redrawés à
  chaque zoom/pan/tick via les coordonnées prix/temps du chart.
- **Édition d'un tracé** : cliquez-le à l'outil curseur → le panneau flottant
  donne **couleur**, **épaisseur** et **opacité** (curseur 10-100 %, appliquée au
  trait, au remplissage des zones et aux badges, homothétiquement), plus
  **dupliquer** (⧉, copie décalée de 12 px) et **supprimer** (✕). Au clavier :
  `Suppr`/`Retour arrière` supprime la sélection, `Échap` la désélectionne,
  `Ctrl+D` la duplique — y compris quand le curseur d'opacité a le focus, pour
  régler puis supprimer sans cliquer ailleurs.

## Rendus

Captures d'écran générées avec Playwright (chromium headless) dans
`previews/` : vue SPX, vue ES futures (basis + DOM), modale Rithmic,
heatmap GEX en mode session (`04_heatmap.png`), simulateur de scénario
(`05_scenario.png`), pane GEX synchronisée (`06_gamma_pane.png`), timeframes &
chips de niveaux (`07`, `08`), dessin sur chart (`09_dessin_midnight.png`),
thèmes (`10_theme_daylight.png`, `11_theme_oled.png`).
