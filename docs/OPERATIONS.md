# Recette, historique, ingestion et exploitation

## 1. Recette des données dans l'environnement disposant du réseau

Les tests du sandbox sont hors ligne/synthétiques. Exécuter cette recette
**localement ou sur le serveur de marché**, sans copier les secrets dans le chat.
Les CLI ne connectent/déconnectent aucun compte et ne passent aucun ordre.

```bash
# Installer la version figée dans un venv puis démarrer le vrai serveur.
pip install -r requirements.lock.txt
cd backend
python -m uvicorn app:app --host 0.0.0.0 --port 8000
# Depuis la racine, dans un autre terminal :
PYTHONPATH=backend python backend/acceptance.py --base-url http://localhost:8000 \
  --symbols SPX,ES,BTC --compare-sources --output data/acceptance-live.json
```

Si la lecture privée est active, la CLI lit `GEX_VIEWER_TOKEN` de son environnement.
Pas de token dans l'URL. Les CLI ne chargent pas automatiquement `.env` : utiliser
un environnement de service/shell protégé, pas des arguments secrets.

Code de sortie : 0 = contrôles API passés, 2 = attention requise (inclut les prix
SIM/DELAYED ou un 0DTE vide à vérifier), autres codes = erreur d'exécution.
Même un code 0 **ne signe pas la recette live** : droits, coupure/reconnexion,
pricing et correspondance exacte des contrats doivent être revus humainement.

`--compare-sources` lit les URL publiques fixes CBOE/Deribit, sans identifiants.
Des snapshots différents sont « non comparables », pas artificiellement alignés.
Pour le BTC, comparer un index en mouvement à une autre lecture peut produire
un écart normal ; vérifier les horodatages et conditions de marché. Les futures
nécessitent une revue du contrat et du basis, pas une comparaison de prix cash.

### Observation d'une séance

```bash
PYTHONPATH=backend python backend/acceptance.py --samples 2880 --interval 30 \
  --base-url http://localhost:8000 --output data/acceptance-session.json
```

Commande volontaire de 24 heures, à lancer dans un service/superviseur ou terminal
adapté. Aucun soak de 24 h n'a été exécuté ici. Les rapports n'enregistrent ni
requêtes d'authentification, ni mots de passe ni URLs contenant des credentials.
Ils sont ignorés par Git.

Faire séparément une coupure/reconnexion contrôlée, comparer les sources avec
le terminal du broker, et conserver une fiche d'acceptation datée. Ne pas effectuer
cette manipulation sur un flux utilisé pour une décision active sans organisation.

## 2. Calendrier, modèles et projections

- `exchange_calendars` fournit les sessions XNYS et génériques CMES/COMEX. CME est
  intersecté avec la maintenance quotidienne 17–18 h ET. Fuseaux/DST explicites.
- PM cash : cut-off de session, donc 13 h ET lors d'une fermeture anticipée.
  SPX/NDX standard AM : 09:30 ET. Une date non ouvrée est rejetée, pas déplacée
  silencieusement vers une autre échéance.
- Ce calendrier n'atteste pas toutes les particularités CBOE/CME : exceptions
  par produit, négociation ETF après 16 h, heures spéciales COMEX et spécifications
  de règlement/exercice doivent être confirmées par les documents officiels.
- Taux par défaut : 4 % cash, 0 % BTC ; rendement continu 0 %. **Hypothèses**, pas
  une courbe de marché récupérée automatiquement. Biais American/discrete dividends
  et inverse settlement crypto non éliminés par ce modèle européen spot.

Configuration optionnelle `GEX_MODEL_INPUTS=/chemin/protege/model-inputs.json` :

```json
{"SPX":{"asof":1792100000,"rate":0.04,"dividend_yield":0.01,
         "curve":[[30,0.04],[365,0.035]]}}
```

Les valeurs ci-dessus illustrent le schéma, **pas des paramètres recommandés ou
calibrés**. Taux/rendements en décimal ; maturités en jours calendaires.
Interpolation linéaire, extrémités constantes. Une calibration datée après le
snapshot n'est pas appliquée à celui-ci ; fichier invalide = hypothèses identifiées
comme telles. Inputs et provenance sont exposés dans `meta.model_inputs`/diagnostics.

Basis/ratio : même fournisseur Yahoo pour les deux branches, timestamps séparés,
skew maximum 60 s. À défaut de quotes cohérentes, dernière paire de bougies 5 min
strictement alignées, au maximum 96 h. Un basis de plus de 30 minutes est marqué
périmé et suspend les alertes de niveaux ; il n'est pas annoncé comme frais.
Sans projection, pas de strikes cash dessinés à l'échelle future.

Le contrat continu Yahoo n'est pas certifié identique à la livraison Rithmic.
La vérification périodique front-month (15 min) signale un rollover ; **pas de
roulement silencieux**. Examiner puis déconnecter/reconnecter depuis Paramètres.
Un contrat explicitement saisi reste sous le contrôle de l'opérateur.

## 3. Enregistrer et évaluer

Activer `GEX_RECORD_EVENTS=true` après vérification des droits de conservation.
Redémarrer. Le défaut reste **off** pour éviter l'accumulation de données/licences.

- Queue bornée 20 000, flush par lots de 2 000 chaque seconde hors event loop.
- Prix externes réels et transactions options observées ; SIM jamais journalisé.
- Times source/réception et type de prix distincts. Indices/proxies non exécutables
  séparés des trades futures directs avec identité du contrat.
- SQLite : au plus 7 jours / 2 millions d'évènements (première borne atteinte),
  100 000 snapshots maximum. IDs de replay non réutilisés après rétention.
- Drops, erreurs disque et attente sont visibles dans `/api/recording` et l'onglet
  VALIDATION. Après un arrêt brutal, une queue non flushée peut être perdue.
  Une queue saine ne prouve pas que l'exchange a fourni tous ses ticks.

`GET /api/replay-events/{symbol}?start=...&end=...&cursor=0&limit=1000` : fenêtre
max 24 h, pagination par ID d'arrivée, `has_more`/`next_cursor`. Lire toutes les
pages ; ne pas traiter une page comme une séance complète. Le curseur par niveau
de l'onglet RECHERCHE reste un explorateur de snapshots, indépendant du live.

### Simulation paper dans VALIDATION

Choisir ES/NQ/GC et le filtre, début/fin UTC, niveau, stratégie hypothétique,
horizon et **ses propres coûts**. Les valeurs de départ du formulaire ne sont
pas les frais vérifiés de votre compte.

Le moteur simule **un contrat**, une position à la fois :

1. Niveau enregistré strictement avant le tick ; ne pas utiliser un niveau changé
   comme un franchissement du prix. Chaîne/projection/contexte périmés exclus.
2. Signal au franchissement ; entrée au tick valide suivant, pas au tick du signal.
3. Spread supposé/2 + slippage défavorable à chaque côté ; commission aller-retour.
4. Sortie au premier tick valide à l'horizon. Pas de carnet/fill réel reconstitué.
5. Exclusion si gap >20 s, source future, prix non direct, changement de contrat,
   ou trade qui traverse la séparation chronologique.
6. 70/30 chronologique dans l'UI, aucune optimisation. Statistiques train/test,
   P&L paper net, drawdown, MAE/MFE des **ticks observés**. Échantillon <30 signalé.

API `POST /api/backtest/{ES|NQ|GC}` : commission/spread/slippage obligatoires,
fenêtre max 7 jours, horizon <=1 h, 50 000 ticks /10 000 snapshots maximum. Une
fenêtre qui dépasserait ces bornes est **refusée**, pas tronquée silencieusement.
Une seule évaluation simultanée par processus. Export JSON dans l'UI.

Ce n'est pas une certification de performance : ni liquidité de file d'attente,
ni impact réel, ni coûts personnels validés. Une division chronologique choisie
après examen des résultats n'est pas un vrai holdout indépendant. Il faut un
historique réel suffisant et des règles définies avant l'observation du test.

## 4. Brancher une source d'options autorisée

**Aucun abonnement acheté et aucun fournisseur actions/CME connecté par ce code.**
La frontière d'ingestion est prête ; un bridge spécifique au fournisseur reste
à choisir/valider avec ses droits et conventions de prix.

Configurer des secrets distincts : `GEX_INGEST_TOKEN`, `GEX_OPTION_FEED_SOURCE`
(nom exact de la source), `GEX_OPTION_FEED_SYMBOLS` (allowlist séparée par virgules).

`POST /api/ingest/options`, Bearer ingest, JSON `{ "trades": [...] }`, 1–1 000
observations, max 2 Mio. Schéma dans `backend/option_ingest.py` :

- source/trade_id/symbol/instrument, ts et expiry Unix UTC, strike, C/P ;
- quantité, prix de prime en **USD** et multiplicateur explicite : prime USD =
  prix × quantité × multiplicateur ; vérifier ce mapping pour chaque famille ;
- bid et ask ensemble, quote_ts antérieur au trade et vieux de <=1 s ; sinon
  ne pas envoyer de quote. Aucune utilisation d'un bid/ask futur ;
- IV en %, delta en unités, sens/source, conditions/multi-leg/position effect
  uniquement si réellement fournis. Inconnu reste inconnu, pas une classification
  haussière/baissière d'après le type d'option.

Déduplication source/symbole/ID dans une fenêtre bornée de 20 000 IDs, pas une
promesse d'exactly-once globale. Batch rejeté intégralement si source/symbole
non autorisés. Imports historiques reçus aujourd'hui gardent cette heure de
réception : **pas de disponibilité historique fabriquée**. Transactions anciennes
non affichées comme un flux live.

```bash
# Valider seulement : pas de réseau ni de secret nécessaire.
PYTHONPATH=backend python backend/import_options.py fichier-normalise.json
# Envoi explicite, token dans l'environnement, HTTPS obligatoire à distance.
PYTHONPATH=backend python backend/import_options.py fichier-normalise.json \
  --send --base-url https://votre-terminal
```

Le tableau RECHERCHE reçoit ces observations pour les instruments autorisés.
Tant qu'il n'en reçoit pas, il l'indique : l'absence de données n'est pas simulée.

## 5. Protéger et superviser

Trois secrets séparés :

- `GEX_VIEWER_TOKEN` facultatif : protège lectures API et WS. L'UI échange le jeton
  contre un cookie HttpOnly SameSite=Strict, 1 h, Secure en HTTPS. Aucun secret dans
  le localStorage ou l'URL. Expiration/rotation vérifiées aussi sur le WS.
- `GEX_ADMIN_TOKEN` : administration Rithmic. Une session viewer ne suffit pas.
- `GEX_INGEST_TOKEN` : ingestion uniquement, ne donne ni lecture ni administration.

Ce sont des rôles partagés pour un petit déploiement, **pas du SSO ni des comptes
multi-tenant individuels**. Pour une organisation : proxy d'identité/SSO et contrôle
d'accès individuels à intégrer avant exposition. Aucun service externe configuré
sans autorisation.

Production : `GEX_ALLOWED_HOSTS` explicite, HTTPS, origine UI/API unique, proxy
qui reconstruit Host/X-Forwarded-* depuis une source de confiance, pas Internet.
Défaut `*` seulement pour le développement/preview. Ne pas exposer Uvicorn directement
comme une installation durcie. Ne pas activer CORS `*`.

Bornes par processus : lectures 240/min/IP, logins 10/min/IP, évaluations 6/min/IP,
ingestion 120/min/IP, 128 requêtes API actives, 8 WS/IP et 64 WS globaux ; mémoire
des buckets bornée. Retour 429/Retry-After plutôt qu'empilement illimité. 2 Mio
limite réelle de corps y compris chunked. Ajouter quotas au proxy (y compris
connexions lentes), limites de workers/mémoire et quotas distribués si multi-worker.
Les limites IP supposent un proxy dont l'identité client est correctement configurée.

- `/api/health` public minimal : application/données initiales, pas une attestation live.
- `/api/diagnostics` protégé si lecture privée : fraîcheur/sources, projections,
  espace disque, latence, erreurs, event-loop lag, enregistrement et rollover.
- `/api/metrics` même protection, format texte : scrutable par votre supervision.
- VALIDATION montre les alertes techniques ; **notifications externes non branchées**.

### Sauvegarder et restaurer

```bash
PYTHONPATH=backend python backend/operations.py backup data/research.sqlite3 \
  data/backups/research-2026-10-17.sqlite3
# Arrêter le serveur. Restauration dans un NOUVEAU chemin uniquement :
PYTHONPATH=backend python backend/operations.py restore \
  data/backups/research-2026-10-17.sqlite3 data/restored.sqlite3 --server-stopped
```

SQLite backup cohérent en lecture, integrity_check, permissions 0600, manifest
SHA-256. Pas de .env/config/credentials archivés. SHA-256 détecte l'altération,
**pas l'authenticité d'une sauvegarde hostile** : protéger le stockage des backups.
La restauration refuse l'écrasement ; définir ensuite `GEX_RESEARCH_DB` vers le
nouveau chemin, vérifier puis redémarrer. Gérer séparément les secrets du service.
Planifier backups, copie hors machine, retention et exercice de restauration via
votre superviseur ; aucune tâche de déploiement distante n'a été exécutée ici.

### Charge avant déploiement

```bash
PYTHONPATH=backend python backend/loadcheck.py --base-url http://localhost:8000 \
  --requests 100 --concurrency 4 --output data/loadcheck.json
```

D'abord staging. Lecture seule, charge bornée ; ce n'est pas un test d'une séance
complète ni du fan-out WS. Les données de fixture ne doivent pas servir au trading.

## Reproduire les tests hors ligne

```bash
pytest -q
python -m crypto_feed.tests_offline
node --check frontend/app.js
node --check frontend/research.js
node --check frontend/access.js
node --check frontend/validation.js
```

Intégration navigateur sur Linux/Node 22 (outillage local ignoré par Git) :

```bash
npm install --prefix .cache/ui playwright@1.64.1 @sparticuz/chromium@153.0.0
# Terminal A, données synthétiques uniquement, aucun compte broker :
GEX_VIEWER_TOKEN=fixture-only-not-a-secret PYTHONPATH=backend:tests \
  python -m uvicorn ui_fixture:app --host 0.0.0.0 --port 8010
# Terminal B, puis arrêter la fixture :
GEX_TEST_VIEWER_TOKEN=fixture-only-not-a-secret node tests/browser.cjs
```

Le jeton de fixture ci-dessus est une constante de test publique, **jamais à
réutiliser dans un déploiement réel**. La fixture se substitue aux chargements
provider et ne doit jamais être publiée comme source de prix.
