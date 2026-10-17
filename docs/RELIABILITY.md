# Fiabilité, 0DTE et nouvelles fonctions

## Migration (lire avant lancement)

1. Installer les dépendances dans un environnement virtuel. `requirements.lock.txt`
   fige l'environnement Linux/Python 3.11 utilisé pour les tests (inclut pytest).
2. Copier `.env.example` vers `.env` puis définir **localement** `GEX_ADMIN_TOKEN`.
   Générateur : `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
3. Redémarrer le serveur. Dans Paramètres, saisir le jeton pour administrer
   Rithmic. Sans jeton serveur, toutes les routes `/api/rithmic*` sont verrouillées.
   Les lectures publiques de marché restent publiques : ce n'est pas une gestion
   multi-utilisateur complète. Utiliser HTTPS et un reverse proxy de confiance.
4. L'ancien mot de passe JSON est chargé en mémoire puis retiré du fichier
   lors de l'initialisation du bridge. Pour un redémarrage automatique, configurer
   `RITHMIC_PASS` via l'environnement ou `.env` non versionné. Sinon le ressaisir.
   Les sauvegardes historiques du disque ne sont pas effacées : les gérer séparément.
5. Par défaut, sans flux live : **DELAYED**, prix figé jusqu'au refresh. Pour une
   démonstration volontaire : `GEX_DEMO_MODE=true` avant démarrage. Après usage
   d'un vrai flux, une panne reste toujours STALE, même en mode démo.
6. Gateways : presets Rithmic TLS/443 uniquement. Un hôte supplémentaire doit être
   explicitement approuvé par l'administrateur dans `GEX_RITHMIC_HOSTS`.
7. Même origine pour l'UI/API/WS. `GEX_ALLOWED_ORIGINS` permet une liste explicite,
   pas `*`. Le serveur doit rester derrière un proxy qui valide son Host.

Le serveur sert désormais l'interface avant la fin des téléchargements. Elle
réessaie le chargement sans recharger toute la page. `/api/health` distingue
`waiting_for_data` de `ready`. Une absence de connexion fournisseur n'est jamais
remplacée par des données synthétiques en production.

## Pourquoi le 0DTE peut être vide

**0DTE signifie une option qui expire à la date de valorisation, non encore expirée,
avec OI positif dans la chaîne reçue.** Pas « prochaine échéance » ni « moins de 24 h ».

- Actions/indices/proxies futures : calendrier New York, changement d'heure inclus.
- SPX standard : convention AM 09:30 ET ; SPXW/ETF : PM 16:00 ET. Les spécifications
  instrument/les fermetures anticipées restent à vérifier auprès de la source.
- BTC Deribit : journée UTC, expiration à 08:00 UTC fournie par l'instrument.
  Après 08:00, l'échéance du lendemain ne devient pas du 0DTE.
- Après expiration, le week-end, sans échéance ou sans OI publié : le filtre peut
  légitimement ne contenir aucun contrat. Les options à OI nul ne contribuent pas au GEX.

Le bandeau affiche maintenant le filtre, le nombre de séries et l'OI filtré, la
raison d'absence et la prochaine échéance avec OI disponible. « Voir ALL » est une
**action explicite** : aucune substitution automatique. Le graphique de prix
reste indépendant. Le passage à 0DTE ferme l'ancien WebSocket, invalide les
scénarios et ignore les réponses GEX obsolètes des clics précédents.

Les Greeks utilisent l'heure de valorisation et non l'heure figée de la chaîne.
Les contrats expirés sont exclus immédiatement, y compris de la cache à leur
expiration. Les OI/IV restent ceux du snapshot : revaloriser n'est pas rafraîchir
le positionnement.

## Calculs et transparence

- Max pain partagé par les vues, calcul O(n log n) via sommes cumulées ; ancien
  signe inversé dans la vue dérivés corrigé. Agréger plusieurs échéances reste
  descriptif, pas une cible de règlement.
- Gamma flip = zero gamma du GEX agrégé selon un spot hypothétique. Le croisement
  cumulatif par strike n'est plus présenté comme un flip de régime.
- Convention de positionnement estimée **calls + / puts −** affichée ; elle ne
  révèle pas les positions réelles des dealers.
- IV CBOE interprétée en décimal : une IV de 1,8 est 180 %, pas 1,8 %.
- Calculs complets mutualisés par symbole/filtre/fenêtre/version de chaîne, jusqu'à
  5 secondes. Hors boucle événementielle pour les WebSockets et les alertes.
- Niveaux futures projetés depuis le cash : unités monétaires des expositions
  restent celles du modèle cash. Pas de prétention à du gamma natif CME.
- Expected move : proxy IV30 journalier, √252 actions / √365 crypto ; pas un
  « vol trigger » structurel. Les scénarios déplacent maintenant IV30 aussi.
- Alertes prix suspendues en DELAYED/STALE/SIM. Changer le strike d'une wall
  n'est plus un franchissement du prix. Règles navigateur liées à leur symbole ;
  anciennes règles sans symbole ignorées, à recréer explicitement.

### Sessions et approximations

Session Auto : RTH 09:30–16:00 ET cash, ETH 18:00–17:00 ET futures,
00:00 UTC crypto. Sélecteur explicite disponible. Plus de mélange arbitraire
de deux journées pour calculer le VWAP. Les bougies quotidiennes et volumes
nuls ne donnent plus de VWAP session invalide. Le CVD futures se réinitialise
à 18 h ET ; crypto à 00 h UTC. Les prints hors ordre ne réécrivent pas les barres.

Le VWAP de bougies reste approximatif. Le volume profile répartit uniformément
le volume dans le range de chaque bougie : **estimation OHLCV, pas volume-at-price**.
Le panneau « réaction » est exploratoire : niveaux actuels appliqués au passé,
**pas un backtest**. Le score de proximité flip n'est pas une probabilité de pinning.

Heatmap SESSION : reconstruction avec OI/IV/temps du snapshot constants, pas un
historique observé. Heatmap HIST : anciens snapshots ALL uniquement ; les autres
filtres sont refusés plutôt que présentés comme filtrés à tort.

## Onglet RECHERCHE

### Transactions options BTC

Vrais prints publics Deribit : heure UTC, instrument/strike/échéance, direction
fournie par l'exchange, quantité, prime USD, IV du trade si fournie. Filtres call/put,
prime minimale et 0DTE (si le filtre graphique est 0DTE) ; sinon ALL pour le tape.
Échantillon borné à 2 000 transactions depuis démarrage/backfill public ; top des
concentrations par strike/échéance, export JSON.

- Bid/ask au moment du trade, delta, multi-leg et ouverture/fermeture : **inconnus**.
- Un achat de call n'est pas une preuve de biais haussier.
- Déduplication par ID natif quand il est fourni ; aucune fusion heuristique des
  prints distincts de même prix/timestamp.
- Actions/CME : fournisseur de transactions options **non connecté**. Le tape
  futures Rithmic ne le remplace pas. Aucun faux flow n'est généré.
- Ancienne « absorption options BTC » renommée activité options/index stable :
  ce regroupement ne prouve pas l'absorption d'un carnet d'option précis.

### Historique point-in-time

`data/research.sqlite3`, non versionné : échantillons toutes les 30 secondes des
niveaux connus, filtres ALL/0DTE/≤7D/≤35D, timestamp de chaîne et de valorisation,
prix/mode/source et heure d'enregistrement. SIM exclu. Rétention 7 jours, cap
100 000 snapshots. Exploration via curseur et export JSON, sans recalcul avec la
chaîne actuelle et sans perturber les alertes live. Un prix différé ou périmé y
reste identifié. **Ce n'est pas un replay tick par tick ni un backtest exécuté.**

OI : dernière observation locale par journée, rétention 90 jours, 30 observations
exposées. La date officielle de publication n'est pas inventée. Les variations
incluent expirations et changements de couverture ; elles ne prouvent pas des
ouvertures/fermetures intraday.

### Vanna, charm et scénarios

Vanna : variation locale du delta équivalent USD pour +1 point absolu d'IV.
Charm : dérivée locale du delta équivalent USD par jour calendaire écoulé.
Même convention signed-OI, BS taux 4 %, sans dividendes. Pas du P&L, ni une
prévision de couverture dealer ; extrapolation journalière particulièrement
fragile près de l'expiration. Les tests comparent les formules aux différences
finies. Source cash conservée pour les futures.

Scénario : choc spot, IV et temps écoulé (UI 0–240 min, API 0–1 440 min). Les
options arrivées à échéance à l'horizon sont exclues ; OI inchangé. Les réponses
asynchrones anciennes ne remplacent plus le scénario d'un autre symbole/filtre.

## Validation

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
.venv/bin/pytest -q
.venv/bin/python -m crypto_feed.tests_offline
node --check frontend/app.js
node --check frontend/research.js
```

Tests navigateur optionnels, exclusivement sur données synthétiques :

```bash
npm install --prefix .cache/ui --no-audit --no-fund playwright@1.64.1 @sparticuz/chromium@153.0.0
PYTHONPATH=backend:tests .venv/bin/uvicorn ui_fixture:app --host 0.0.0.0 --port 8010
# dans un autre terminal
node tests/browser.cjs
```

La fixture ne démarre ni Rithmic ni les appels fournisseurs. Ne pas la déployer
comme serveur de marché. Le test vérifie les états 0DTE rempli/vide, retour ALL,
STALE, sessions, VWAP sans volume, verrouillage admin, recherche et contrôles à
1024 px. Le navigateur Sparticuz peut nécessiter ses bibliothèques AL2023 ; le
script les extrait localement dans `.cache/ui` si nécessaire.

## Suite de l'exécution

Les travaux suivants sont maintenant décrits et suivis dans
[EXECUTION_STATUS.md](EXECUTION_STATUS.md) et [OPERATIONS.md](OPERATIONS.md) :
calendriers, modèles configurables, recette exécutable, journal d'évènements,
simulation paper point-in-time, ingestion autorisée, accès de lecture privé,
quotas, diagnostics et sauvegardes/restaurations.

Les limites des anciennes sections ci-dessus sont précisées par ces nouveaux
guides : les Greeks ont des paramètres configurables, la fermeture PM peut être
anticipée selon le calendrier de référence, et les endpoints de lecture peuvent
être protégés par `GEX_VIEWER_TOKEN`. Le replay de snapshots reste distinct de
l'API d'évènements. Un fournisseur actions/CME et une recette live complète ne
sont toujours pas déclarés connectés/validés.
