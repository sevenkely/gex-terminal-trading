# Exploitation avec les vraies sources

## Ce qui a changé

Le serveur de démonstration n'est plus utilisé pour l'aperçu utilisateur. Le
lancement normal utilise `app:app`, jamais `ui_fixture:app`, et impose
`GEX_DEMO_MODE=false`. Les fixtures synthétiques sont réservées à la recette
isolée sur 8010 et sont arrêtées après les tests.

Le build React est maintenant l'accueil `/` → `/react/`. Le classique reste à
`/classic/` pour comparaison et retour arrière, pas comme dépendance des outils
React portés. Sans build, `/react/` donne une erreur 503 explicite et le classique
reste accessible.

## Un démarrage reproductible

Sur un PC ou serveur disposant de Python 3.11+, de Node 22.12+ (22), 24 LTS ou
26+, et d'un accès Internet aux fournisseurs :

```bash
./scripts/run-production.sh
# http://adresse-du-serveur:8000/ → /react/
```

Le script crée le venv, installe les dépendances verrouillées, construit React,
et démarre **le vrai backend**. Il ne crée aucun compte, ne demande aucun secret
en ligne de commande et ne se connecte pas aux plants d'ordres. Les données sont
conservées dans `data/` selon les politiques existantes. Pour une exposition
Internet, appliquer `docs/OPERATIONS.md`, configurer HTTPS, les hôtes autorisés
et, si nécessaire, l'accès de lecture privé. Ne pas publier un serveur admin
sans jeton et ne pas committer `.env`.

## Réseau nécessaire (sortant)

| Fournisseur | Hôte | Transport | Données |
|---|---|---|---|
| Deribit | `www.deribit.com` | HTTPS + WSS, 443 | BTC public : prix, options, bougies, tape |
| CBOE | `cdn.cboe.com` | HTTPS, 443 | Options actions publiques différées |
| Yahoo | `query1.finance.yahoo.com` | HTTPS, 443 | Bougies et cotations publiques différées |
| Rithmic (facultatif) | Gateway autorisé configuré | WSS, 443 | Market data avec les droits correspondants |

Une interface React ne peut pas rendre accessibles des domaines refusés par
l'hébergeur. Lors de la vérification du **18 octobre 2026**, les appels HTTPS
réels à Deribit, CBOE et Yahoo depuis le sandbox ont échoué avec une fermeture
TLS/SSL (EOF). Le WSS Deribit est également refusé (ConnectionResetError).
Le backend démarre mais indique `waiting_for_data`, `demo:false`, sans chaîne.
Ce résultat n'est pas une validation de marché réussie. Aucun proxy clandestin,
cache synthétique ou contournement de la restriction réseau n'est ajouté.

Le 18 octobre est un dimanche : hors séance US, les derniers cours cash peuvent
rester figés même sur un hébergement avec réseau fonctionnel. Cela ne rend pas
les données fictives. Les sources gratuites actions restent différées ; rendre
ces cours live nécessite les droits market data correspondants, pas une option
CSS. Les futures GEX restent des projections du sous-jacent cash identifiées.

## Diagnostic dans React

**Outils → Sources & connexion** affiche :

- domaines et transports nécessaires, chaînes effectivement chargées ;
- dernières tentatives réussies/échouées et leurs horaires ;
- état Deribit / Rithmic et absence de dernier succès quand il n'existe pas ;
- administration Rithmic protégée (facultative, sans stockage des secrets dans
  le navigateur).

API `GET /api/data-status` : lecture soumise à l'accès de lecture existant,
pas de connexion réseau sur chaque GET, noms de types d'erreur uniquement,
registre borné aux fournisseurs et instruments connus, aucun secret/config.
`GET /api/health` distingue la disponibilité du processus des données reçues.
Ne pas annoncer « live » parce que le processus est démarré.

## Enregistrement et relecture

La relecture combinée utilise les **événements réellement enregistrés** et les
snapshots GEX, sur un même curseur en heure de réception. Les bougies sont
construites seulement à partir des ticks prix DERIBIT/RITHMIC enregistrés, jamais
à partir des prix des snapshots. Des trous sont possibles et annoncés.

`GEX_RECORD_EVENTS=true` dans l'environnement active l'enregistrement futur,
**uniquement si les droits de conservation du fournisseur le permettent**.
Redémarrer ensuite le backend. L'interface n'active pas cette rétention sans
accord et ne fabrique pas l'historique antérieur à l'activation. Un historique
vide après un premier lancement est un état réel, pas un replay complet caché.

## Validation après déploiement

```bash
PYTHONPATH=backend .venv/bin/python backend/acceptance.py \
  --base-url http://127.0.0.1:8000 --symbols SPX,ES,BTC \
  --samples 1 --output data/acceptance.json
```

Ce contrôle refuse les chaînes absentes et indique les données périmées ou
non live. Pour une recette réelle en séance, utiliser les options documentées
et vérifier les sources, droits et dates de marché. Les tests offline ne
remplacent pas cette validation.

Résultat de la recette réelle dans cet environnement : `api_checks:
attention_required`, `live_signoff:false`, code de sortie 2 (chaînes manquantes
pour BTC/SPX/ES, ALL et 0DTE). Résultat des vérifications offline séparées :
19 tests React, 70 tests Python, build/typecheck/lint et trois recettes navigateur
(deux React et une classique) réussis. Audit npm : aucune vulnérabilité signalée.
Le succès offline n'annule pas l'échec de connectivité réelle.
