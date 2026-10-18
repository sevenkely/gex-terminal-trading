# React — cockpit et outils d’analyse

## Accès et démarrage

Démarrage réel en une commande : `./scripts/run-production.sh`.
Guide réseau et validation en séance : [REAL_DATA.md](REAL_DATA.md).


Le cockpit React est servi à **`/react/`** après construction et redémarrage de
FastAPI ; `/` y redirige. L'interface classique reste accessible à `/classic/`
pour comparaison, sans être requise pour les outils portés. Les préférences
existantes sont conservées. Sans build, `/react/` répond 503
avec les commandes à effectuer, plutôt qu'une application silencieusement cassée.

Node **22.12+ dans la branche 22**, 24 LTS ou 26+ (contrainte Vitest) :

```bash
cd terminal-react
npm ci
npm run build
cd ../backend
# Utiliser le Python du venv et les dépendances requirements.lock.txt du projet.
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Développement : backend en 8000, puis dans un deuxième terminal :

```bash
cd terminal-react
npm ci
npm run dev -- --port 5173
```

Ouvrir `/react/` sur le port 5173. Vite accepte les hôtes de preview `.e2b.app`.
Les appels navigateur sont relatifs ; Vite proxy `/api`, `/ws`, `/classic` et les logos locaux
vers le backend. Aucun appel navigateur à localhost pour joindre un autre service.
En production, FastAPI sert le build directement : pas besoin de serveur Vite.
Ne pas versionner `dist/` ; exécuter le build avant démarrage/déploiement.

## Ce qui fonctionne dans React

- Navigation sur les huit instruments configurés et état vide si un actif n'a
  pas de source. Sélection instrument/intervalle/filtre isolée dans les requêtes.
- Quotes, chandeliers/volume Lightweight Charts, lignes Call/Put Wall/Zero Gamma,
  filtres d'échéance, Focus, cadrage du prix. Seuls les ticks DERIBIT/RITHMIC
  cohérents avancent les chandeliers ; aucun volume de trades n'est inventé.
- VP et VWAP : mathématique partagée avec le frontend existant, base OHLCV
  indépendante du graphique, périodes/séances/fuseaux, préférences persistées,
  choix d'ancrage par clic, profils précédents, bandes et styles.
- Événements big/abs estimée, inspecteur synchronisé au survol, source/unités,
  journal d'agrégats et export CSV. Les données sont reçues, pas reconstituées.
- Relecture indépendante des snapshots GEX enregistrés, limitée aux points
  dévoilés jusqu'à la sélection et avec trous >90 s non reliés. Ne prétend pas
  être le replay prix/flux/niveaux combiné ou un tick replay.
- Repères horizontaux, tendances et rectangles (clics), undo et effacement
  confirmé. Stockage des dessins React par actif, distinct des dessins classiques.
- Interface responsive, animations Motion/CSS, intensité et préférence système,
  clavier/focus et dialogues natifs, état d'accès de lecture par cookie existant.

## Outils avancés intégrés dans React

Le bouton **Outils** ouvre un atelier React chargé à la demande :

- **Échéances** : grille Gamma/Vanna strike×échéance, fenêtre ±3/5/10/15 %, unités,
  troncature et cellules absentes distinctes de zéro. Une sélection inclut le
  strike dans l'échelle du prix et ajoute une ligne nommée ; « Cadrer » la retire.
- **Heatmap** : session reconstruite clairement identifiée, ou snapshots réellement
  enregistrés ; paramètres d'intervalle et fenêtre, inspection d'une cellule.
- **Scénarios** : variation spot, IV et avance du temps, revalorisation par le
  backend existant, profil global et niveaux. Pas une simulation de prix live.
- **Dessins** : horizontal, vertical, tendance, rayon, rectangle, Fibonacci ;
  édition des coordonnées UTC/prix, couleur, épaisseur, trait, opacité/remplissage,
  masquage, verrouillage, suppression, undo/redo. Import volontaire des dessins
  classiques sans modifier les originaux. Déplacement par coordonnées, pas
  encore par poignées drag-and-drop sur le canvas.
- **Recherche** : tape options reçu, filtre contrat/prime/type et tri, échéances
  IV/skew/OI/max pain, Vanna/Charm du modèle. Tape ALL ; le filtre global reste
  appliqué au risque et à l'exposition, pas implicitement au tape.
- **Relecture combinée** : bougies des ticks enregistrés, lignes GEX et événements
  options jusqu'au même curseur de réception, lecture/pause/vitesse, fenêtre
  UTC ≤24 h et pagination d'événements. Aucune donnée future ou bougie inventée.
- **Alertes** : franchissements serveur Call/Put/Zero Gamma, avec blocage serveur
  lorsque les sources sont périmées. Les règles VP/VWAP personnalisées de
  l'ancien frontend ne sont pas encore importées ni exécutées par React.
- **Sources & connexion** : diagnostic réel et administration Rithmic protégée,
  configuration market data, contrats, connexion/déconnexion et état. Pas de
  stockage navigateur des identifiants ou du jeton admin.

Ces outils ne nécessitent plus d'ouvrir le classique. Cela n'affirme pas une
parité exhaustive de toutes ses options (par exemple poignées drag-and-drop,
alertes personnalisées, OI historique et UI complète de backtest/validation).
Le classique reste conservé, et la validation de marché réelle reste séparée
des tests de recette. Voir [exploitation réelle](REAL_DATA.md) pour le réseau.

Les préférences classiques sont lues seulement pour amorcer intervalle et
indicateurs ; les modifications React vont dans `gex.react.workspace.v1`.
Les ancrages sont isolés par actif. Les dessins sont dans `gex.react.draw.<actif>`.
Aucune suppression des données `data/`, du SQLite ou des anciens paramètres.

## Architecture et intégrité

- `terminal-react/src/components/` : composants d'interface, chart et dialogues.
- `src/lib/stream.ts` : un WebSocket partagé, génération de connexion contre les
  réponses d'un ancien instrument, reconnexion bornée, refus d'accès non rebouclé.
  Les ticks vont directement au chart ; les mises à jour React sont groupées à
  350 ms. L'absence de confirmation récente du flux n'affiche pas une badge live.
- TanStack Query : cache HTTP par instrument/filtre/intervalle/source, annulation
  via AbortSignal, erreurs et rafraîchissements. Pas de remplacement par SIM.
- Zustand : préférences d'interface, pas un store de tous les ticks. L'inspection
  est séparée, afin de ne pas rerendre tout le cockpit à chaque déplacement.
- Chart chargé en chunk séparé ; cycle de vie instrument/intervalle, destruction
  des ressources à la sortie. Pan/zoom et réglages n'initialisent pas le chart.
  Profils et VWAP mis en cache hors de la boucle de dessin tant que les données
  et paramètres n'ont pas changé. Pas de recalcul Intl de toutes les bougies à
  chaque tick. Le refresh des bougies ne force pas le cadrage après la première
  initialisation. Alignement horaire cash :30 conservé pour les agrégats de flux.
- Prix de source historique, mode, chaîne, OI et projection restent distincts.
  Le VP répartit le volume OHLCV entre low/high, le VWAP utilise HLC3 : estimations,
  non trade-by-trade. Les périodes Weekly/Monthly peuvent être incomplètes.
  Fuseaux RTH/ETH : filtres horaires, pas certification des jours fériés.
- Tokens de lecture seulement en mémoire le temps du POST `/api/session` ; le
  cookie HttpOnly est géré par le backend. Aucun secret dans Vite/localStorage.

## Skills et design

Guides Everything Claude Code sélectionnés et épinglés dans `.agents/skills/`.
Ils sont utilisés comme méthode de travail, pas comme runtime Claude. Le contrat
visuel et les états sont documentés dans `terminal-react/DESIGN.md`, les tokens
dans `design-tokens.json`. Les fichiers upstream conservent leur licence MIT.
Les logos et fontes existants conservent leurs licences propres ; le pack de
logos CC BY-NC-SA doit être vérifié avant une redistribution commerciale.

## Vérification reproductible

```bash
cd terminal-react
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm audit --audit-level=high
cd ..
.venv/bin/python -m pytest -q
node tests/indicator_math.cjs
```

Recette navigateur isolée (données **synthétiques**, jamais l'aperçu réel) :

```bash
npm install --prefix .cache/ui playwright@1.64.1 @sparticuz/chromium@153.0.0
npm run build --prefix terminal-react
./scripts/test-react-ui.sh
```

Le script lance et arrête une fixture dédiée sur 8010. Les deux recettes React refusent
un backend qui n'annonce pas `demo:true` : aucune recette ne doit accidentellement
utiliser le serveur de marché. Le script vérifie aussi le classique à /classic/. CI construit et exécute ces mêmes tests.

La première recette teste VP/VWAP, ancrages, persistance, dessins/undo, journal,
0DTE vide, indépendance base/intervalle, quatre dimensions, reduced-motion,
erreur source et formulaire de lecture. La seconde teste les grilles et API
avancées, provenance heatmap, édition/verrouillage/undo/redo des dessins,
recherche contrat, replay combiné et sérialisation protégée des paramètres admin
(le masque de mot de passe retourné par le serveur n'est jamais renvoyé comme
nouveau mot de passe). Desktop/mobile, dialogues sans débordement.

Ces tests ne constituent pas une séance de marché live : certaines réponses
sont injectées explicitement dans le navigateur de recette. Le build et le
backend de production ne contiennent aucun jeu de prix de remplacement.

Couverture unitaires ciblée (API, stream, historique live et préférences, **pas tous les composants**) :

```bash
cd terminal-react
npm run test -- --coverage --coverage.include=src/lib/api.ts --coverage.include=src/lib/stream.ts --coverage.include=src/lib/preferences.ts --coverage.include=src/lib/chart-history.ts --coverage.reporter=text
```

Recette de référence effectuée : build/typecheck/lint, 19 tests React, 70 tests
Python et mathématiques d'indicateurs réussis ; audit npm sans vulnérabilité
signalée à l'installation. Couverture de parité de l'ancien cockpit et validation
marché réelle restent à terminer avant de supprimer le classique.
