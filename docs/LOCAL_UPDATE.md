# Récupérer la version publiée et la lancer en local

Publication sur la branche `arena/d2871f0f-gex-terminal-trading`. Elle n'est pas
encore fusionnée dans `main` : un simple pull de `main` ne suffit pas.

## 1. Préparer l'ancienne installation

Arrêter le serveur (Ctrl+C). Sauvegarder `.env` et `data/` à l'extérieur du dépôt.
Ils sont ignorés par Git et ne sont pas remplacés par la mise à jour.

Dans le dossier existant :

```bash
git status
```

Si des fichiers sont modifiés, les sauvegarder/committer avant de changer de
branche. Ne pas utiliser `git reset --hard`, `git clean -fdx` ou supprimer le
projet pour forcer la mise à jour. Ne jamais committer les secrets de `.env`.

## 2. Récupérer la branche publiée

```bash
git fetch origin
git switch arena/d2871f0f-gex-terminal-trading
git pull --ff-only origin arena/d2871f0f-gex-terminal-trading
```

Après fetch, Git crée normalement la branche locale en suivant la branche
homonyme d'origin si elle n'existe pas déjà. Si Git signale des changements
locaux ou une divergence, arrêter et conserver le message plutôt que forcer.

## 3. Installer et démarrer

Prérequis : Python 3.11+ et Node 24 LTS (ou Node 22.12+ dans la branche 22).
`python --version` / `py --version` et `node --version` permettent de vérifier.

Linux / macOS / WSL :

```bash
./scripts/run-production.sh
```

Windows PowerShell, avec Python et Node installés sous Windows :

```powershell
.\scripts\run-production.ps1
```

Si la politique PowerShell bloque les scripts, utiliser ces commandes manuelles
(ne nécessitent pas de changer la politique ni d'activer le venv) :

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
npm.cmd ci --prefix terminal-react
npm.cmd run build --prefix terminal-react
$env:GEX_DEMO_MODE = 'false'
.\.venv\Scripts\python.exe -m uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000
```

Si un ancien venv provient d'un autre OS ou d'une autre version de Python, ne pas
le réutiliser : fermer le serveur, le renommer en `.venv-old` et créer un nouveau
`.venv`. Ne pas renommer/supprimer `.env` ou `data/`. Le démarrage Linux a été
vérifié dans le sandbox ; le lanceur PowerShell n'a pas été exécuté sous Windows.

## 4. Ouvrir et contrôler

- Nouveau terminal : **http://localhost:8000/** (redirige vers `/react/`).
- Ancien terminal conservé : **http://localhost:8000/classic/**.
- Vérification : **Outils → Sources & connexion**.

Laisser le serveur ouvert. Le premier chargement des sources peut prendre du
temps. Si le port 8000 est déjà utilisé, arrêter l'ancien serveur ou choisir
`PORT=8001` (Bash) / `$env:PORT='8001'` (PowerShell) avant de lancer le script.

BTC public Deribit n'exige pas de compte. Les sources publiques actions sont
différées ; leur accès dépend de la disponibilité du fournisseur et du réseau.
Aucun succès de marché réel sur ton ordinateur n'a encore été constaté. Aucun
fallback automatique en simulation. Voir `REAL_DATA.md` pour les domaines réseau
et l'enregistrement optionnel nécessaire à une relecture de ticks ultérieure.

Pour les mises à jour suivantes, sur cette même branche : `git pull --ff-only`,
puis relancer le script pour installer/construire avant de redémarrer le backend.
