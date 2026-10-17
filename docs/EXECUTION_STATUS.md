# Ordre d'exécution et état vérifiable — 17 octobre 2026

Cette page distingue **code livré**, **test hors ligne** et **validation réelle**.
Un test synthétique réussi ne devient jamais une validation de données live.

| Ordre | Travail | Livré / vérifié ici | Validation restante |
|---|---|---|---|
| 1 | Recette live | CLI API + comparaison optionnelle avec URLs publiques fixes, contrôle timestamps/strikes/Greeks, rapports et soak borné | Réseau fournisseur, comparaison avec terminal de référence, droits Rithmic, coupure/reconnexion et séance entière : **non exécutés** |
| 2 | Conventions | Calendriers XNYS/CMES/COMEX, early closes, rejet d'échéances non ouvrées, taux/rendements/courbe explicitement configurables, basis synchronisé, détection de rollover | Confirmation des spécifications officielles par produit et courbes de marché : **non attestée** |
| 3 | Historique | Journal opt-in des évènements reçus, pagination/cursors persistants, niveaux connus, simulation next-tick avec coûts, MAE/MFE, segmentation chronologique et exclusions | Constitution d'un historique réel complet, échantillon suffisant et validation hors échantillon indépendante : **non effectuées** |
| 4 | Option Flow actions/CME | Contrat d'ingestion normalisé, authentification séparée, déduplication, quotes synchronisées, importateur à blanc, affichage par instrument | **Fournisseur et licence non choisis/connectés**. L'adaptateur générique ne constitue pas un connecteur fournisseur live |
| 5 | Exploitation | Lecture privée facultative HTTP/WS, sessions HttpOnly, quotas et bornes de charge, diagnostics/metrics, backups/restores vérifiés, CI | Déploiement TLS réel, supervision externe, mesure d'une journée et dimensionnement : **à exécuter sur l'environnement cible** |

## Preuves disponibles dans le dépôt

Dernier passage : **66 tests pytest réussis**, tests `crypto_feed` hors ligne
réussis et contrôles de syntaxe JavaScript réussis. Un avertissement de
dépréciation Starlette/httpx (TestClient) subsiste, sans échec.

- `tests/test_calendars_acceptance.py` : jours fériés, fermeture anticipée, CME,
  synchronisation du basis, non-fabrication de fraîcheur, taux sans look-ahead,
  gamma comparé à une dérivée numérique d'un pricing scalaire indépendant.
- `tests/test_evaluation_events.py` : next-tick, coûts, MAE/MFE, futurs niveaux
  inaccessibles, gaps, changement de contrat, purge du split, queue bornée,
  pagination, IDs non réutilisés, API d'évaluation et refus de troncature.
- `tests/test_operations_access_ingest.py` : cookies/signatures/expiration,
  séparation des rôles, quotas et limites de corps streamés, import normalisé,
  sauvegarde/restauration et détection de rollover sans reconnexion silencieuse.
- Tests précédents : GEX, 0DTE, stale, max pain, OI, scénarios et risk.
- Tests navigateur : login de lecture, 0DTE plein/vide, retour ALL, STALE, sessions,
  scénario temps, onglets recherche/validation, refus de simuler un indice.

### Charge synthétique locale (pas une certification)

100 requêtes HTTP GEX ALL/0DTE, 4 threads clients, source **synthetic_fixture** :
100 réponses 200, aucune erreur serveur/réseau, p50 ~14 ms, p95 ~27 ms sur ce
sandbox. Un seul petit dataset/caches chaudes, pas des flux exchange. Le résultat
ne mesure ni les pointes d'une séance ni la capacité WebSocket multi-utilisateur.
Les rapports détaillés sont dans `data/` ignoré par Git.

La recette API de la même fixture retourne volontairement `attention_required`,
code 2, car les prix sont SIM. Elle conserve `live_signoff=false`. Aucune
comparaison fournisseur ni validation de droits n'a été déclarée réussie.

## Ce que « terminé » doit vouloir dire avant usage réel

Ne pas signer une mise en service tant que ces éléments n'ont pas de preuve :

1. Prix/source/timestamps et contrats réconciliés sur chaque instrument choisi.
2. 0DTE contrôlé avant et après expiration, y compris une fermeture anticipée.
3. Interruption volontaire du réseau : prix figé, alertes suspendues, récupération
   propre, changement de contrat explicite et trou de journal identifié.
4. Séance enregistrée sans drops/erreurs ; vérifier le disque, les droits de
   conservation et les sauvegardes. Tester une restauration dans un nouveau chemin.
5. Recette historique sur données réelles, coûts adaptés au compte et résultats
   réellement indépendants. Des statistiques descriptives ne prouvent pas un edge.
6. Fournisseur options actions/CME choisi, licence vérifiée et mapping validé.
7. TLS, hosts, tokens séparés et monitoring configurés sur la cible.

Les commandes et limites sont détaillées dans [OPERATIONS.md](OPERATIONS.md).


## Cockpit inspiré des références visuelles

Implémentation suivante : graphique et heatmap par échéance ancrés, Gamma/Vanna,
cellules liées, niveaux/concentrations, vues Analyse/Focus/Recherche enregistrables,
replay des observations et tableau de flow enrichi avec isolation par contrat.
Tests navigateur desktop/tablette/mobile et tests de conservation des calculs.
Voir [WORKSPACE.md](WORKSPACE.md) pour les unités, plafonds et limites.

Restent conditionnés aux sources : dark pool, flow actions/CME effectif,
pourcentages de variation d'une grille depuis l'ouverture et replay complet des
bougies avec historique d'exposition. Aucun de ces éléments n'a été remplacé par
une reconstitution présentée comme observée. Le lecteur livré porte uniquement
sur les snapshots réellement enregistrés ; les bandes sont des concentrations du
snapshot courant, pas une reproduction de la formule propriétaire de Bullflow.

## Graphique : marqueurs et édition des dessins

Livré : résumés big trades / absorption séparés par bougie, historique observé
borné, montants et épisodes absorption, noms complets des niveaux, couleurs
personnalisables et édition des dessins temps/prix avec undo/redo. Mode d'emploi
et limites : [WORKSPACE.md](WORKSPACE.md).

Vérifié hors ligne : 7 tests dédiés flow/API et recette navigateur dédiée, plus
la recette complète du cockpit (desktop/tablette/mobile). Les tests utilisent
des événements contrôlés : ils ne prouvent ni un historique fournisseur exhaustif,
ni une détection certaine d'absorption, ni une validation live d'une séance entière.

### Cockpit unifié et flux conservés

Checkpoints SQLite bornés avec restauration et diagnostic, panneau de niveaux
repositionnable hors du prix, inspecteur/journal liés aux bougies, gestionnaire
d’annotations et relecture indépendante de bougies closes avec niveaux connus.
66 tests pytest, plus les recettes navigateur cockpit et flux/dessins hors ligne.
L’interface expose les données manquantes au lieu de les assimiler à zéro.
La cause exacte sur l’installation utilisateur et le sign-off de marché restent
à confronter à son flux réel : aucun backfill fournisseur ni couverture exhaustive
n’est promis. Les observations antérieures à la conservation ne sont pas recréées.

### Livraison graphique prioritaire

Vue essentielle par défaut, contexte réduit aux informations importantes,
intervalle mémorisé, cadrage du prix, agrandissement et inspecteur compact.
Classique, Analyse et outils avancés sont conservés. Journal, diagnostics de
couverture, replay et gestionnaire de dessins sont regroupés dans un dialogue.

Validation : 66 tests Python, suite crypto hors ligne et trois recettes navigateur
(cockpit, flux/dessins, nouvelle présentation) réussies. Quatre dimensions d’écran
vérifiées, sans débordement horizontal. Les données de recette sont synthétiques.

Limite externe inchangée : la connexion Deribit de cet environnement est refusée
(ConnectionReset / TLS EOF). La couverture réelle au-delà des trois dernières
bougies et une séance continue ne sont donc pas certifiées ici. La persistance
conserve les observations reçues, mais ne reconstitue ni des prints jamais reçus,
ni un historique tick exhaustif. Aucun compte de trading ni abonnement ajouté.

### Passe frontend Studio

Habillage anthracite/cyan, mini-courbes rétablies, logos locaux et cartes
hiérarchisées. Bandeau défilant retiré. Animations riches par défaut, intensité
réglable et réduction des mouvements respectée. Aucun changement de calcul,
de source ou de moteur de graphique.

Vérifications : quatre recettes navigateur réussies (cockpit, flux/dessins,
présentation essentielle, design/animations), 66 tests Python et syntaxe des
scripts. Les huit onglets et quatre dimensions d’écran sont testés ; la recette
visuelle reste synthétique et ne certifie pas la couverture du marché réel.
