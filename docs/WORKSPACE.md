# Cockpit d’analyse : guide et limites

## Organisation

L’espace **Analyse** place le graphique et une heatmap par échéance côte à côte.
Le panneau est redimensionnable à la souris ; son séparateur est accessible au
clavier (flèches gauche/droite). Sous 1180 px, les outils passent sous le graphique.

Trois vues : **Analyse**, **Focus graphique**, **Recherche**. La dernière retrouve
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

## Recette

`tests/test_exposure.py` vérifie conservation Gamma/Vanna, masquage d'expirations,
bornes, cellule absente/zéro et projection/API. Le navigateur de fixture teste
sélection liée, modes, préférences, lecture des snapshots, isolation de contrat,
0DTE vide, authentification et mises en page desktop/tablette/mobile. Ces données
de fixture ne sont jamais un flux live ni une validation fournisseur.
