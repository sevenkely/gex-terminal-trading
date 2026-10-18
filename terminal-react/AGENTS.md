# Travail sur le cockpit React

- Lire `DESIGN.md`, `../docs/REACT_MIGRATION.md` et les guides ECC sélectionnés
  dans `../.agents/skills/` avant de modifier architecture ou direction visuelle.
- React + TypeScript strict + Vite. API backend existante, URLs relatives.
- Un WebSocket partagé par instrument/filtre ; aucun compte d'ordres ajouté.
- Le chart est impératif et chargé à la demande. Ne pas placer un tick dans
  l'état global de tout l'arbre React ni recréer le chart sur chaque quote.
- Réutiliser `frontend/indicator-math.js`, ne pas redéfinir les formules en JSX.
- Inconnu n'est pas zéro ; SIM n'est pas live ; le VP OHLCV n'est pas un TPO.
- Préserver le frontend classique et ses préférences jusqu'à validation de parité.
- Vérifier build, TypeScript, ESLint, tests, audit npm et recette navigateur.
- Ne pas mettre dist/, node_modules/, captures ni bases de données dans Git.
