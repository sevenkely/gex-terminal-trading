# GEX React — direction et contrat visuel

## Direction

Un poste de travail de marché **graphite / sauge / ambre**, pas un dashboard SaaS.
Le job principal est de lire le prix et ses niveaux sans quitter les bougies.
Références : captures du terminal fournies dans cette conversation, dont les
problèmes de texte minuscule, logos trop petits, indicateurs peu paramétrables
et états périmés trop peu différenciés. Pas de reprise d'un template générique.

- Le graphique est le contenu principal dès l'ouverture ; aucune landing page.
- Les couleurs des données restent sémantiques : menthe call/positif, rose
  put/négatif, ambre Zero Gamma/avertissement. Ce ne sont pas des conseils d'achat.
- IBM Plex Sans pour l'interface, IBM Plex Mono pour les nombres. Fontes locales
  existantes et leur licence OFL conservées. Titres sobres, capitales uniquement
  pour les repères courts, pas de lettres espacées partout.
- Signature `GEX / TERMINAL`, monogramme latéral et monogramme vectoriel G×.
  Ce sont des éléments SVG/typographiques, pas des images générées.
- Les vrais logos de Bitcoin et d'émetteurs/places existants sont réutilisés avec
  leur provenance et leur licence. Les wordmarks horizontaux restent moins
  lisibles que des symboles à petite taille : pas de faux logo inventé pour les ETF.
- Sélection d'actif partagée, micro-interactions Motion, retour de clic et
  transitions de dialogues. Pas d'animation des bougies, de métriques aléatoires,
  de faux histogrammes GEX ni de latence inventée. Préférence `off` et réduction
  système prioritaires, animations CSS suspendues en onglet masqué.

## Hiérarchie et dimensions

1. Navigation d'actifs indépendante et prix sélectionné.
2. Graphique + commandes courtes : intervalle, échéance, outils, VP/VWAP.
3. Contexte GEX à droite et provenance à proximité des valeurs.
4. Inspecteur sous le prix ; détails dans des dialogues natifs accessibles.

1440×1000, 1366×768 : colonnes prix/contexte, contexte défilable indépendamment.
1024×900 : contexte sous le graphique. 390×844 : navigation horizontale d'actifs,
commandes repliées et graphique d'au moins 435 px, dialogues en une colonne.
Pas de défilement horizontal de la page. Focus agrandit le graphique.

## États obligatoires

| Déclencheur | Retour visible | Suite sûre |
|---|---|---|
| API en attente | Cadre stable, progression | Attendre ; changer d'actif annule la requête |
| Aucune bougie | Vide explicite | Réessayer, ne pas générer de prix |
| 0DTE vide | Aucun niveau, aucune valeur à zéro | Bouton ALL, sans bascule silencieuse |
| Source en erreur | Indisponible / actualisation échouée | Réessayer, conserver seulement les observations identifiées |
| Snapshot ancien / basis périmé | Badge directement sur les niveaux | Lire la provenance, ne pas promettre précision |
| Flux absent | Inconnu, pas zéro | Afficher couverture et contrat |
| Accès expiré | Formulaire de lecture | Cookie HttpOnly du backend, aucun token localStorage |
| Action de dessin | Repère, deux points, annulation | Undo / Échap, stockage React séparé |
| Paramètres modifiés | Application immédiate et préférence mémorisée | Revenir aux paramètres, conserver l'ancienne interface |

## Tokens

`src/styles.css` est la source des CSS variables. `design-tokens.json` est un
inventaire lisible des décisions, pas un deuxième moteur de thème. Les dialogues
et composants partagent les mêmes primitives. Les messages d'erreur ne reposent
pas seulement sur une couleur. Focus clavier visible, boutons nommés, inputs
étiquetés, dialogues natifs avec confinement du focus et Échap.

## Vérification

Test navigateur sur le build réel : quatre dimensions, clavier, réduit/off,
0DTE vide, source indisponible, paramètres/ancrages, dessins/undo, journal et
formulaire de lecture. Données de recette explicitement synthétiques ; ce test
ne prouve pas le débit en marché réel ou la parité de tous les outils avancés.

## Atelier natif React

Échéances, heatmaps, scénarios, dessins, recherche, relecture combinée, alertes
et sources sont présentés dans un dialogue large, tabs horizontaux défilables
sur mobile. Chaque outil a ses requêtes annulables et son état source/vide/erreur,
sans ouvrir automatiquement un frontend différent. Diagnostic réel visible
lorsque les sources manquent ; aucune illustration de marché factice pour
remplir le chart. Le classique sert de référence de comparaison.
