# Accusé de réception & relance automatisés

Pipeline sur-mesure qui lit chaque email entrant, envoie un accusé de
réception contextualisé automatiquement, prépare trois brouillons de
réponse dans la messagerie (validation humaine avant envoi), et relance
les dossiers restés sans réponse.

Deux connecteurs sont implémentés et interchangeables sans toucher au
reste du code: **Gmail** (compte de test) et **Outlook / Microsoft 365**
(messagerie de production, via Microsoft Graph). Le client connecte
lui-même l'un ou l'autre depuis une page web — voir
[Page de connexion](#3-page-de-connexion-le-client-branche-sa-boîte-lui-même).

## Ce que fait le pipeline

1. Scrute la boîte de réception (`src/scheduler.ts`, toutes les 2 minutes par défaut).
2. Pour chaque nouvel email, récupère le fil complet et le fait classifier par
   Claude (`src/ai/classify.ts`) selon les catégories définies dans
   [`config/categories.json`](config/categories.json).
3. Si la catégorie l'exige, envoie automatiquement un accusé de réception
   personnalisé (`src/ai/draftAcknowledgement.ts`), rédigé selon le ton
   défini dans [`config/brand-voice.md`](config/brand-voice.md).
4. Génère trois brouillons de réponse distincts (`src/ai/draftReplies.ts`)
   et les dépose en brouillon dans la messagerie — **aucun envoi automatique
   de réponse**, un humain choisit et envoie.
5. Toutes les 30 minutes, vérifie les dossiers dont le délai (SLA) est
   dépassé sans réponse envoyée (`src/pipeline/relanceCheck.ts`): rappel
   interne journalisé, ou relance externe automatique si la catégorie
   l'autorise.

## Où sont stockées les données

Tout est journalisé dans une base **SQLite locale**, un simple fichier sur
le disque de la machine qui fait tourner le service — pas de service
externe. Chemin par défaut: `./data/app.db` (configurable via `DB_PATH`),
soit concrètement `data/app.db` à la racine du projet. Utilise le module
natif `node:sqlite` — aucune dépendance native à compiler.

Dans le même dossier `data/` (exclu du dépôt via `.gitignore`):
- `connection.json` — quelle messagerie est active (Gmail ou Outlook) et
  quelle adresse est connectée.
- `gmail-token.json` / `graph-token.json` — jetons OAuth de la messagerie
  connectée.

Ce fichier contient des métadonnées d'emails clients (objet, adresse,
catégorie — pas le contenu complet des messages), à traiter comme donnée
personnelle (RGPD): accès restreint, sauvegardes chiffrées, durée de
rétention définie avec le client.

**SQLite convient au pilote** (une seule instance). Pour la production à
plus grande échelle, ou si l'hébergement choisi ne garantit pas un disque
persistant entre redéploiements (containers éphémères, plateformes
serverless), migrer vers une base gérée (Postgres) — voir
[Mise en production](#mise-en-production).

## Comment le système sait qu'il y a eu une réponse

`src/pipeline/relanceCheck.ts` compare, à chaque vérification (toutes les
30 minutes), l'horodatage de l'accusé de réception (`ack_sent_at`) à
l'ensemble des messages du fil récupéré depuis la messagerie connectée: si
un message envoyé par la boîte connectée existe après cet horodatage, le
dossier passe au statut "Répondu" et la relance s'arrête.

Ce mécanisme suppose que la réponse part **de la messagerie connectée**,
dans le **même fil** (thread Gmail / conversation Outlook) — ce qui est le
cas normal quand un agent choisit un des 3 brouillons générés et l'envoie.
Il a des angles morts, à connaître avant de compter dessus à 100%:

- **Réponse envoyée depuis une autre adresse** (compte personnel d'un
  agent, autre outil) — invisible, puisque le connecteur n'a accès qu'à la
  messagerie connectée.
- **Nouveau message au lieu d'une réponse dans le fil** — si l'agent
  compose un email neuf plutôt que de répondre à un des brouillons
  générés, le rattachement au fil peut se rompre (surtout si l'objet change).
- **Résolution hors email** (téléphone, en personne) — aucune visibilité
  possible par nature.

Pour couvrir ces cas, une page de suivi manuel existe:

### Suivi des dossiers (`npm run setup` → onglet "Suivi des dossiers")

Liste tous les dossiers avec leur statut, échéance et nombre de relances,
et propose un bouton **"Marquer répondu"** pour clôturer manuellement un
dossier que la détection automatique n'a pas vu passer. Règle d'usage à
donner à l'équipe: toujours répondre en utilisant un des 3 brouillons
générés (ou au moins en répondant dans le même fil) pour que la détection
automatique fonctionne; le bouton manuel reste le filet de sécurité.

## Installation

```bash
npm install
cp .env.example .env
```

### 1. Clé API Claude

Ajoutez `ANTHROPIC_API_KEY` dans `.env`.

Vous pouvez tester la couche IA seule (classification + rédaction), sans
aucun accès email, avec:

```bash
npm run test:pipeline
```

Ce script fait tourner le pipeline complet de rédaction sur un email
d'exemple codé en dur et affiche le résultat dans le terminal.

### 2. Configuration agence (une fois par client)

Ces identifiants sont ceux de l'**agence** (l'application OAuth), pas ceux
du client — le client, lui, ne fait qu'autoriser l'accès depuis la page de
connexion (étape 3).

**Gmail** — dans [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
1. Créez un projet, activez l'API Gmail.
2. Créez un identifiant OAuth de type **Application web**.
3. Dans "URI de redirection autorisés", ajoutez la valeur de
   `GOOGLE_REDIRECT_URI` (`http://localhost:4300/auth/gmail/callback` par défaut).
4. Renseignez `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` dans `.env`.

**Outlook / Microsoft 365** — dans le [Azure Portal](https://portal.azure.com) du client:
1. Azure Active Directory → App registrations → New registration.
2. Type de compte: selon si le pilote reste chez ce client uniquement
   (single tenant) ou doit resservir pour d'autres clients (multitenant).
3. Dans "Redirect URIs" (type **Web**), ajoutez la valeur de
   `AZURE_REDIRECT_URI` (`http://localhost:4300/auth/graph/callback` par défaut).
4. API permissions → Microsoft Graph → **Delegated permissions**:
   `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `User.Read`, `offline_access`.
   Ne demandez jamais de permissions applicatives tenant-wide pour ce projet.
5. Certificates & secrets → créez un client secret.
6. Renseignez `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID`
   dans `.env` (`AZURE_TENANT_ID=common` si multitenant, sinon l'ID du
   tenant du client).

### 3. Page de connexion (le client branche sa boîte lui-même)

```bash
npm run setup
```

Ouvre une page sur `http://localhost:4300` avec deux cartes, **Gmail** et
**Outlook / Microsoft 365**. Le client clique sur "Connecter", passe par
l'écran de consentement standard de son fournisseur, et revient
automatiquement — aucune manipulation de fichier `.env` ou de terminal de
son côté. La messagerie active et l'adresse connectée sont affichées en
haut de page, avec un bouton Déconnecter.

Le connecteur actif est mémorisé dans `data/connection.json`, créé
automatiquement au premier clic — se reconnecter sur l'autre fournisseur
bascule le pipeline sans redémarrage manuel de configuration.

**Protégez cette page dès qu'elle sort de votre poste local**: définissez
`SETUP_USERNAME` / `SETUP_PASSWORD` dans `.env` (authentification HTTP
Basic). Sans ça, n'importe qui connaissant l'URL peut reconnecter ou
déconnecter la messagerie. Un avertissement s'affiche au démarrage tant
que ces variables sont vides.

### 4. Personnalisation métier

- [`config/categories.json`](config/categories.json) — types de demandes,
  délai (SLA) par catégorie, et si la relance externe automatique est
  autorisée.
- [`config/brand-voice.md`](config/brand-voice.md) — ton de marque, exemples
  à suivre, ce qu'il faut éviter. À compléter avec le client pendant
  l'atelier de cadrage.

### 5. Lancement

```bash
npm run dev        # pipeline seul (scrutation + accusés + relances)
npm run setup      # page de connexion + suivi des dossiers, seule
npm run dev:all    # les deux dans un seul process (pratique en dev)
```

Utilise la messagerie connectée via la page de connexion. À défaut de
connexion existante, se rabat sur `EMAIL_CONNECTOR` dans `.env`.

## Mise en production

**À éviter pour ce projet: Vercel / Netlify.** Ce sont des plateformes
serverless — chaque requête tourne dans une fonction éphémère, sans
process persistant ni disque durable. Or le pipeline dépend d'un
`node-cron` qui doit rester actif en continu, et la base SQLite a besoin
d'un disque qui survit entre les requêtes. Les deux fonctionneraient sur
Vercel/Netlify seulement après avoir réécrit le scheduling (leurs "Cron
Jobs" déclenchent une route HTTP, pas un process qui tourne) et migré le
stockage vers une base hébergée — un vrai chantier, pas juste un choix
d'hébergeur.

### Option recommandée: Render, sans Docker

Render (comme Railway) fait tourner ce projet **tel quel**: un process
Node persistant + un disque qui survit aux redémarrages — exactement ce
que le pipeline attend, sans changement de code, et sans avoir besoin de
Docker (Render détecte `package.json` et construit directement avec
`npm install && npm run build`, puis lance `npm run start:all`).

Le fichier [`render.yaml`](render.yaml) décrit déjà le service (build,
démarrage, disque persistant monté sur `/var/data` pour la base SQLite et
les jetons OAuth). Pour aller en prod:

1. Poussez ce projet sur un dépôt GitHub/GitLab.
2. Sur [render.com](https://render.com) → New → Blueprint → sélectionnez le
   dépôt. Render lit `render.yaml` et propose le service tel que configuré.
3. **Choisissez le plan payant "Starter"** (pas le plan gratuit — celui-ci
   se met en veille après une période d'inactivité, ce qui couperait le
   `node-cron` et donc les accusés/relances automatiques).
4. Renseignez les variables marquées secrètes dans le tableau de bord
   Render (`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID/SECRET`,
   `AZURE_CLIENT_ID/SECRET/TENANT_ID`, `SETUP_USERNAME/PASSWORD`, et les
   `*_REDIRECT_URI` une fois l'URL Render connue, ex.
   `https://votre-service.onrender.com/auth/gmail/callback`).
5. Ajoutez ces mêmes URI de redirection dans Google Cloud Console et
   Azure Portal.
6. Render fournit HTTPS et un sous-domaine `.onrender.com` automatiquement;
   un domaine personnalisé se configure ensuite dans les réglages du service.

### Alternative: Docker (VPS, Azure Container Apps, etc.)

```bash
cp .env.example .env   # completez avec vos vraies valeurs
docker compose up -d --build
```

Le `Dockerfile` compile le projet (`npm run build`) puis lance
`node dist/main.js`, qui démarre à la fois la page de connexion/suivi et
le pipeline dans un seul process — un seul service à surveiller.
`docker-compose.yml` monte `./data` en volume pour que la base SQLite et
les jetons OAuth survivent aux redémarrages du conteneur. Utile si vous
préférez héberger vous-même (VPS) ou intégrer dans une stack Docker
existante côté client — sans lien avec les rumeurs de lenteur de Docker,
qui viennent surtout de Docker Desktop en développement sur Mac/Windows,
pas d'un conteneur Linux en production.

### Checklist avant d'exposer publiquement

1. **Domaine + HTTPS** — la page de connexion doit être servie derrière une
   URL HTTPS stable (reverse proxy Caddy/Nginx, ou le HTTPS géré par votre
   plateforme). Mettez à jour `GOOGLE_REDIRECT_URI` et `AZURE_REDIRECT_URI`
   avec ce domaine, et enregistrez les mêmes URI côté Google Cloud Console
   et Azure Portal (les URI de redirection doivent correspondre exactement).
2. **`SETUP_USERNAME` / `SETUP_PASSWORD`** — obligatoire dès que ce n'est
   plus `localhost`.
3. **Secrets** — `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_SECRET`,
   `AZURE_CLIENT_SECRET`, `SETUP_PASSWORD` via le gestionnaire de secrets
   de votre hébergeur (variables d'environnement du service), jamais un
   fichier `.env` committé.
4. **Process toujours actif** — le pipeline dépend d'un `node-cron` qui
   tourne dans le process; il faut donc un service "always on"
   (App Service avec "Always On" activé, VM + systemd/pm2, ou un
   orchestrateur de conteneurs), pas une fonction serverless qui s'éteint
   entre les requêtes.
5. **Base de données** — si l'hébergement ne garantit pas un disque
   persistant (containers éphémères redéployés, plusieurs instances),
   migrer `src/db.ts` de SQLite vers Postgres avant d'aller au-delà du
   pilote.
6. **Scrutation → webhooks** — au-delà du pilote, remplacer le polling par
   les souscriptions Microsoft Graph / Gmail push (Pub/Sub) pour un
   traitement en quasi temps réel et moins d'appels API.

Hébergeur suggéré si vous ciblez Outlook/M365 en priorité: Azure App
Service (Linux, Node) ou Azure Container Apps — cohérence avec
l'écosystème du client, simplifie la validation par son équipe IT.
Alternatives valables pour un pilote plus léger: Railway, Render, Fly.io.

## Structure du projet

```
config/
  categories.json         catégories, SLA, règles de relance
  brand-voice.md           ton de marque
src/
  connectors/               Gmail et Microsoft Graph (interface commune EmailConnector)
  web/server.ts             page de connexion + suivi des dossiers
  ai/                        classification + rédaction (Claude)
  pipeline/                  orchestration (email entrant, vérification des relances)
  scripts/                   auth Gmail en CLI (fallback), test de la couche IA sans email
  connectionState.ts         messagerie active (écrit par la page de connexion)
  db.ts                      suivi des dossiers (SQLite local)
  scheduler.ts, index.ts     pipeline seul
  main.ts                    pipeline + page web dans un seul process (prod/Docker)
render.yaml                       déploiement Render (recommandé, sans Docker)
Dockerfile, docker-compose.yml   déploiement Docker (alternatif)
```

## Note Windows

Le dossier parent (`SRA & Co`) contient un `&`, un caractère spécial pour
`cmd.exe`. Cela casse les raccourcis (`.cmd`) que npm génère habituellement
pour `tsc`/`tsx` sur Windows — d'où les scripts `package.json` qui appellent
`node ./node_modules/...` directement plutôt que les noms de commande nus.
`npm run dev`, `npm run setup`, etc. fonctionnent normalement avec cette
forme. Si d'autres outils (CI, Docker, VS Code tasks) posent le même
problème, la solution la plus durable est de renommer le dossier parent
sans `&` (ex. `SRA and Co`).

## Limites connues de ce prototype

- La scrutation de boîte se fait par intervalle (cron), pas par webhook —
  voir [Mise en production](#mise-en-production).
- Le rappel interne (`recordReminder`, kind `internal`) n'est aujourd'hui
  journalisé qu'en base et visible sur la page "Suivi des dossiers" — à
  brancher sur Slack/Teams/email d'équipe selon l'outil du client.
- SQLite local convient au pilote; prévoir Postgres pour la production à
  plus grande échelle (voir [Où sont stockées les données](#où-sont-stockées-les-données)).
- Un seul compte connecté à la fois par instance (`data/connection.json`).
  Pour plusieurs boîtes clientes en parallèle, faire tourner une instance
  du service par boîte plutôt que de partager l'état de connexion.
