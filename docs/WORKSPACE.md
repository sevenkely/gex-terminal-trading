# Cockpit d’analyse : guide et limites

## Organisation

La vue **Classique · profil global** est la vue principale : elle conserve le
graphique, les niveaux, le profil GEX agrégé et les anciens onglets GEX / Alertes /
Flux / Futures. Les bulles, les chiffres d’absorption et les dessins améliorés
restent disponibles. La grille par échéance n’est pas affichée dans cette vue.

L’espace **Analyse · échéances**, accessible par le sélecteur **Vue**, place le graphique et une heatmap par échéance côte à côte.
Le panneau est redimensionnable à la souris ; son séparateur est accessible au
clavier (flèches gauche/droite). Sous 1180 px, les outils passent sous le graphique.

Quatre vues : **Classique**, **Analyse**, **Focus graphique**, **Recherche**. La dernière ouvre directement
les outils détaillés existants, le flow options, les statistiques et VALIDATION.
« Enregistrer la vue » mémorise localement métrique, fenêtre, nombre de niveaux,
mode de superposition, bandeau et largeur pour cette vue. Aucun secret n'est
stocké. Réinitialiser efface uniquement la préférence de workspace.

## Échéances et niveaux

- Gamma : dollars par mouvement de +1 % du spot, convention calls + / puts −.
- Vanna : dollars de delta équivalent par +1 point de volatilité absolue. Même
  modèle que `risk.py`, pas un second calcul de gamma et pas un montant de P&L.
- Lignes : strikes. Colonnes : timestamps de règlement, affichés en date ET
  pour cash/futures et UTC pour BTC. Le tooltip donne le timestamp UTC exact.
- Cyan positif, violet négatif. Jaune : ligne proche du spot / cellule sélectionnée.
- « — » signifie aucune observation dans cette cellule ; zéro avec un montant
  signifie qu'il existe des options et que leur somme nette est nulle.
- Le filtre global ALL/0DTE/≤7D/≤35D est respecté sans repli implicite.
- Fenêtre ±3/5/10 %, maximum 24 échéances /160 strikes. La troncature est annoncée.
  Le classement « Niveaux » somme les échéances **visibles**, pas toute la chaîne
  lorsque la vue est tronquée. Il n'est pas un signal de support/résistance certain.
- Cliquer une cellule conserve le filtre global, sélectionne le strike/échéance,
  et inclut son strike dans l'échelle du graphique. Effacer la sélection libère
  cette extension. Les prix visibles restent inclus dans l'autoscale.
- Pour ES/NQ/GC, coordonnées projetées depuis le cash, avec unité du modèle cash
  et avertissement d'équivalence du contrat non vérifiée. Pas de GEX natif CME.

API : `GET /api/exposure/{symbol}?filter=all&metric=gamma&band=.05`.
Retourne `strikes`, `expiries`, `values[strike][expiry]`, `counts`, les unités,
les timestamps et paramètres du modèle. Pas de nouvelle connexion fournisseur.
Actualisation UI toutes les 15 s dans Analyse/Focus et seulement si l’onglet navigateur est visible.
Les couleurs sont normalisées à la magnitude maximum de la grille courante : ne
pas comparer la même couleur entre deux grilles comme une valeur absolue identique.

## Superposition sur le graphique

Modes **Niveaux**, **Concentrations**, **Masqué**, avec 3/5/10/15 strikes dominants
par magnitude absolue. Le strike sélectionné est ajouté en jaune.

Les concentrations ont une largeur visuelle fixe de 8 pixels et une opacité liée
à l'exposition. Ce ne sont **ni des intervalles de confiance ni des bandes de prix
calculées**. Elles décrivent le snapshot actuel sur le graphique. Aucune courbe
historique ondulante n'est inventée à partir d'un seul snapshot. Vanna et Gamma
restent identifiés par leur métrique et leurs unités propres.

La heatmap de session/historique préexistante reste un outil distinct via HEATMAP.
Ne pas confondre reconstruction indicative existante et observations enregistrées.

## Replay observé

Onglet Replay : jusqu'aux 300 dernières observations pour le symbole et filtre.
Prix/CW/PW/zero gamma sont affichés ensemble, uniquement jusqu'au curseur choisi.
Lecture/pause, précédent/suivant, curseur et vitesses 1×/4×/16×/60× utilisent les
intervalles réels entre observations. Pas de recalcul avec la chaîne courante.
Les lignes sont interrompues lors des trous de plus de 90 s. SIM est exclu du
journal en production ; les statuts DELAYED/STALE et l'âge de chaîne sont conservés.

Ce lecteur est **indépendant du graphique live** et des alertes. Il ne rejoue pas
une séance en chandeliers complets, ne suppose pas une couverture tick exhaustive,
et ne garantit pas que les 300 dernières observations couvrent toute la journée.
Les échelles du mini-graphique utilisent seulement les données connues au curseur.
Un historique vide est annoncé comme tel. Les contrôles ne fabriquent aucun passé.

## Flow et sources supplémentaires

Dans Recherche : colonnes strike, C/P, expiration, sens source, prime, quantité,
bid/ask, type source et IV ; tri par heure/prime/quantité et isolation par contrat.
La recherche de contrat est appliquée avant le plafonnement de lignes retournées.
`GET /api/option-flow/{symbol}` accepte `contract` optionnel (128 caractères max).
`trade_type` normalisé peut être `unknown`, `block` ou `sweep`, uniquement fourni
par le bridge de données. Aucun sweep ni SigScore n'est déduit artificiellement.
Les unités de bid/ask sont USD pour l'ingestion normalisée ; Deribit ne fournit
pas de quotes synchronisées dans ce tape et les laisse inconnues.

L'onglet Sources annonce explicitement :

- sources publiques différées, BTC public et accès market data facultatif ;
- ingestion actions/CME disponible, mais fournisseur absent par défaut ;
- dark pool non connecté. Aucune assimilation volume Yahoo = transaction dark pool.

**Pas de connecteur Bullflow actif, de nouvelle licence ou d'abonnement acheté.**
La souscription API, les droits d'affichage/conservation, le mapping et la validation
sur payloads réels restent nécessaires avant un tel raccordement. Les changements
relatifs à l'ouverture / clôture ou au placement dealer ne deviennent pas observables
par un simple changement de design.

## Marqueurs de flux par bougie

Le bouton bulles active un **résumé gros trades** (montant brut × nombre de
prints) et un **résumé absorption** distinct (`A montant × épisodes`) par bougie.
Les montants ne sont jamais additionnés entre ces deux types. Le survol détaille
achats, ventes, sens inconnu, delta des gros prints et côtés absorbés.

- Agrégation côté serveur à la réception, pour tous les intervalles, conservée
  en mémoire sur **420 bougies maximum par intervalle et contrat**, avec checkpoints
  SQLite dans `data/flow.sqlite`. Les listes courtes « dernières transactions »
  du panneau ne limitent plus cet historique. Les checkpoints sont restaurés au
  démarrage : on ne repart plus systématiquement à zéro. Écriture toutes les 5 s
  et à l’arrêt propre ; un arrêt brutal peut perdre les dernières secondes.
  La conservation reste partielle et ne récupère pas le passé jamais collecté.
  Jusqu’à 64 contrats par namespace (crypto / Rithmic), les plus récents sur disque.
  Pour les futures, le contrat doit être résolu par le mapping Rithmic courant :
  aucune substitution silencieuse d’une ancienne échéance après rollover.
- Changer l'intervalle utilise les résumés de cet intervalle. L'heure peut être
  alignée à `:00` ou `:30` selon les vraies bougies du graphique ; le quotidien
  suit la date de séance CME pour ES/NQ/GC, UTC pour BTC. Les anciennes réponses
  d'un autre symbole, intervalle ou source ne repeignent pas le nouveau graphique.
- Un marqueur sans bougie OHLC correspondante n'est **pas** raccroché à la dernière
  bougie ni à une bougie voisine. Aucun print n'est reconstitué depuis OHLCV.
  Les marqueurs sont des repères sur le graphique : ils ne donnent pas un prix
  d'exécution cash lorsqu'ils proviennent du futur sous-jacent, ni un prix
  d'exécution d'option lorsqu'ils sont placés sur l'index BTC.
- L'absorption reste une **estimation** volume/prix sur fenêtre de 6 s, pas une
  observation certaine de liquidité passive. Son volume est attribué à la bougie
  de **détection**, même si sa fenêtre commence dans la bougie précédente. Le
  cooldown de 25 s évite le chevauchement des fenêtres du même côté. Un épisode
  acheteur et un épisode vendeur détectés ensemble comptent comme deux épisodes.
- BTC perp : notionnel USD ; BTC options : prime USD ; futures : contrats.
  Ces unités ne deviennent ni de l'OI ni un volume d'options cash.

Dans **Affichage des flux** (barre supérieure), régler séparément acheteurs agressifs absorbés
(bleu), vendeurs agressifs absorbés (jaune), mixte (violet) et opacité. Contour par
défaut pour conserver la couleur hausse/baisse ; corps ou marqueur seul en option.
Le bleu signifie que **l'achat agressif est absorbé par la vente passive**, pas un
signal acheteur. Le jaune signifie l'inverse. Les préférences sont locales au navigateur.

Le **Zoom de lecture des montants** élargit les bougies autour de la zone observée ;
**Vue d'ensemble** retrouve le cadrage initial. Sur une vue très dézoomée, les
marqueurs restent compacts mais les chiffres ne sont plus écrasés horizontalement :
ils apparaissent lorsque l’espacement est suffisant. Zoomer, survoler ou sélectionner
la bougie pour lire les montants dans l’inspecteur. Les données ne
sont pas supprimées quand on dézoome.

## Niveaux et dessins

Les libellés affichent **Call Wall / Put Wall / Zero Gamma** en toutes lettres,
dans le panneau **Niveaux du marché**. La liste flottant auparavant sur le prix
est retirée ; l’axe garde les prix principaux, pas la liste complète des noms. Ces niveaux calculés restent
pilotés par les données et les interrupteurs de niveaux : ils ne sont pas des
annotations déplaçables.

Pour un dessin, choisir l'outil puis tracer. Il est automatiquement sélectionné.
Le curseur de sélection permet de :

- déplacer tout le dessin en **temps et prix**, ou chacun de ses points ;
- régler couleur, épaisseur en pixels, opacité, trait continu/tirets/points et
  remplissage des rectangles ;
- verrouiller/déverrouiller, dupliquer, supprimer. Un dessin verrouillé reste
  sélectionnable pour le déverrouiller, mais ne bouge pas et résiste à « effacer ».
  Sa copie est indépendante et déverrouillée ;
- annuler **toutes** les modifications (pas uniquement le dernier ajout), puis
  rétablir : boutons, Ctrl/Cmd+Z, Ctrl/Cmd+Maj+Z ou Ctrl/Cmd+Y. Jusqu'à 100 opérations
  pour l'instrument actif ; l'historique d'annulation ne survit pas au rechargement.

Les dessins sont enregistrés localement par instrument (onglet), en coordonnées
**temps/prix**, pas en pixels ; zoom, intervalle et taille de fenêtre ne les
réécrivent pas. L'outil de navigation (main) rend le contrôle du graphique. Aucun
outil texte n'est ajouté dans cette livraison.

## Recette

`tests/test_exposure.py` vérifie conservation Gamma/Vanna, masquage d'expirations,
bornes, cellule absente/zéro et projection/API. Le navigateur de fixture teste
sélection liée, modes, préférences, lecture des snapshots, isolation de contrat,
0DTE vide, authentification et mises en page desktop/tablette/mobile. Ces données
de fixture ne sont jamais un flux live ni une validation fournisseur.

La recette des marqueurs/dessins est séparée : `tests/test_flow_markers.py` couvre
les totaux/côtés, changement d'intervalle, alignement horaire, rétention, séances,
non-recomptage, couverture/API et isolation perp/options. `tests/flow_draw_browser.cjs`
vérifie 60 bougies /120 marqueurs, chiffres absorption, couleurs, déplacement,
poignées, verrouillage, styles, annulation/rétablissement, persistance et mobile.
Pour les deux recettes navigateur : démarrer `tests/ui_fixture.py` sur 8010, puis
`node tests/browser.cjs` et `node tests/flow_draw_browser.cjs` (Playwright et Chromium
locaux dans `.cache/ui`). Ne pas remplacer le serveur réel par cette fixture.

## Cockpit unifié : conservation, inspection et relecture

- **Plan du cockpit** ouvre un schéma intégré de l’organisation. Le graphique,
  le contexte GEX et l’inspecteur gardent leurs emplacements à travers les vues.
- **Niveaux du marché** : principaux par défaut, secondaires en option, distance
  au prix et indicateur hors écran. Cases par famille, pas modification des prix
  calculés. Position à droite, à gauche ou flottante ; le bandeau du panneau
  flottant est déplaçable et sa position locale mémorisée. L’ancien profil global
  reste dans Classique ; la grille reste dans Analyse.
- **Inspecteur** sous le prix : survol pour suivre, clic pour épingler, bouton pour
  libérer. Une bougie sans agrégat reçu est inconnue, pas un zéro d’activité.
  Les trois cartes séparent montant big, activité estimée et delta du tape complet.
- **Diagnostic de couverture** : bougies reçues, associées aux OHLC, événementielles
  visibles, absentes du graphique, dernière transaction, état SQLite et erreurs.
  Les comptes ne constituent pas une attestation d’exhaustivité du fournisseur.
- **Journal** : résumés par bougie de la source/intervalle sélectionnés, filtrage
  par type, CSV, sélection liée au graphique et curseur de relecture des agrégats.
  Ce n’est pas un journal de tous les prints individuels ni un carnet d’ordres.
- **Alertes de franchissement** : source prix, contrat, filtre ALL du détecteur et
  timestamp de chaîne mémorisés dans la notification. Les gardes existants contre
  les prix SIM/STALE et les projections périmées restent actifs. Ce ne sont pas des
  instructions de trading ni une validation de la fraîcheur de toute la chaîne.
- **Objets du graphique** : sélection, affichage/masquage, verrouillage, duplication,
  suppression ; modifications intégrées à undo/redo. Aucun niveau calculé dans
  cette liste d’annotations.
- **Relecture combinée indépendante** : prix du tape, flux et niveaux historiquement
  enregistrés, intraday sur ES/NQ/GC directs ou BTC perp. Un agrégat complet n’est
  dévoilé qu’à la clôture nominale de sa bougie. Les niveaux proviennent uniquement
  d’un snapshot enregistré avant cette clôture, âgé de 90 s maximum, sans projection
  périmée ; le contrat futures doit correspondre explicitement. Sinon : inconnus.
  Aucun niveau actuel injecté dans le passé. Les proxies cash, options et quotidien
  sont exclus de cette relecture combinée pour éviter des équivalences trompeuses.
  Ce n’est ni du tick replay exhaustif ni une simulation d’ordres. La relecture
  existante des snapshots GEX reste également disponible dans Analyse / Replay.

Les options BTC sont présentées dans l’inspecteur comme **prime / index stable
(heuristique)** : ce n’est pas une absorption observée sur le carnet d’un contrat.
Le rendu sobre, les réglages en dialogue et le rail d’outils borné à la zone du
prix évitent de recouvrir l’inspecteur et les chandeliers.

Architecture ajoutée : `flow_store.py` (persistance bornée), `cockpit.js`
(composition et inspection) et `observed-replay.js` (relecture indépendante).
Le moteur existant n’est pas remplacé. Aucun abonnement ni accès ordres ajouté.
Sauvegarder `flow.sqlite` séparément avec l’outil SQLite de sauvegarde cohérente
si nécessaire ; ne pas copier à chaud un fichier de base en cours d’écriture.

Validation : restauration de checkpoints, déduplication crypto par ID récent,
retry d’erreur disque, arrivée pendant checkpoint, calibrage des contrats natifs,
recette navigateur de positionnement, journal, objets et non-utilisation des niveaux
futurs. Les fixtures isolent leurs moteurs des checkpoints de production.
**Recette de marché réelle / séance entière : non effectuée ici**, connexion
fournisseur toujours nécessaire. Les tests synthétiques ne valent pas ce sign-off.

## Vue essentielle — graphique prioritaire

La présentation **Essentielle** est désormais activée par défaut. Elle conserve
Classique / profil global et Analyse / grille par échéance, sans changer les
calculs ni les abonnements. **Outils avancés** réaffiche les panneaux détaillés ;
la préférence est conservée dans `gex.presentation`.

- Graphique dégagé, rail de niveaux hors des bougies, contexte à droite : régime,
  Net GEX, mouvement attendu, mode du prix, âge de chaîne et référence OI.
- **Cadrer le prix** revient aux bougies visibles sans imposer les niveaux éloignés.
  **Agrandir** active le mode Zen existant. Le cadrage initial dépend de la largeur
  (15 à 100 bougies), avec un intervalle de 5 min par défaut ; le dernier intervalle
  choisi est conservé dans `gex.chart.interval`.
- L’inspecteur reste compact, avec **Détails** pour les chiffres par bougie.
  **Journal / Replay / Dessins** ouvre les outils d’inspection dans une fenêtre
  distincte, sans réduire durablement le graphique.
- Sur mobile, le graphique conserve une hauteur minimale de 420 px ; le contexte
  et les niveaux restent accessibles plus bas, sans défilement horizontal de page.

Module de présentation : `frontend/chart-layout.js`. La recette
`tests/chart_layout_browser.cjs` utilise la fixture locale sur 8010 : modes,
intervalle et persistance après rechargement, cadrage, Zen, dialogue, absence de
débordement et tailles 1440×1000, 1366×768, 1024×900 et 390×844.
Ces contrôles ne constituent pas une validation du flux marché réel.

## Habillage Studio — animations et identités visuelles

`design.css` et `design.js` ajoutent une couche de présentation indépendante des
calculs et abonnements. Le bandeau défilant et son contrôle sont retirés de
l’interface, y compris après restauration d’une ancienne vue. Les nœuds masqués
restent pour la compatibilité ; leur rendu ticker est court-circuité.

- Navigation avec logos locaux d’actifs ou d’émetteurs/places, mini-courbes,
  sélection lumineuse et transitions. L’identité exacte de chaque logo figure
  dans son infobulle et `frontend/assets/instruments/README.md`.
- Relief des cartes, hiérarchie des chiffres, retour du mini-graphe du prix,
  animations d’entrée, clic, changement de présentation et valeurs GEX modifiées.
  Les animations décoratives ne représentent jamais des trades ni la fraîcheur.
- **Animations → Immersives / Discrètes / Désactivées** ; préférence `gex.motion`.
  Le réglage système `prefers-reduced-motion` impose la désactivation. Les boucles
  CSS sont suspendues lorsque l’onglet est masqué. Aucun moteur d’animation tiers,
  abonnement réseau ni boucle JavaScript d’animation permanente ajouté.
- La recette `tests/design_browser.cjs` vérifie huit identités locales, leur
  alignement, la suppression du bandeau, la préférence après rechargement,
  reduced-motion et le responsive. Le jeu de huit cotations est synthétique,
  injecté uniquement par le test navigateur, jamais par l’application.

Les marques tierces ne signifient pas une affiliation. Le pack de logos
comporte une licence **CC BY-NC-SA 4.0**, conservée avec les assets ; vérifier une
licence adaptée avant une redistribution commerciale.
