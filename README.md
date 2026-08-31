# Accusé de réception & relance automatisés

Pipeline sur-mesure qui lit chaque email entrant, le classe par IA, envoie
un accusé de réception contextualisé automatiquement, puis relance les
dossiers restés sans réponse — que ce soit l'équipe qui n'a pas encore
répondu, ou le client resté silencieux après notre réponse.

Deux connecteurs sont implémentés et interchangeables sans toucher au
reste du code: **Gmail** (compte de test) et **Outlook / Microsoft 365**
(messagerie de production, via Microsoft Graph). Le client connecte
lui-même l'un ou l'autre depuis une page web — voir
[Page de connexion](#4-page-de-connexion-le-client-branche-sa-boîte-lui-même).

## Ce que fait le pipeline

1. Scrute la boîte de réception (`src/scheduler.ts`, toutes les 2 minutes par défaut).
2. Pour chaque nouvel email, récupère le fil complet et le fait classifier par
   Claude (`src/ai/classify.ts`) selon les catégories définies dans
   [`config/categories.json`](config/categories.json).
3. Si la catégorie l'exige, envoie automatiquement un accusé de réception
   personnalisé (`src/ai/draftAcknowledgement.ts`), rédigé selon le ton
   défini dans [`config/brand-voice.md`](config/brand-voice.md).
4. Un humain répond de fond au client (ex: envoi d'un devis) — **le pipeline
   ne rédige et n'envoie jamais cette réponse à sa place**, uniquement
   l'accusé et les relances.
5. Toutes les 2 minutes, vérifie chaque dossier ouvert contre sa
   **séquence de relance** (`src/pipeline/relanceCheck.ts`): une suite
   d'étapes ordonnées, chacune déclenchée à échéance + un délai, qui est
   soit un simple rappel interne journalisé, soit une relance externe
   envoyée automatiquement au demandeur. Voir
   [Séquences de relance](#séquences-de-relance).

## Où sont stockées les données

Tout est journalisé dans une base **Postgres hébergée sur Supabase**
(`src/db.ts`, via le driver `pg`) — pas de fichier local. Chaque
environnement (dev, production) pointe vers son **propre projet Supabase**,
jamais partagé, configuré via la variable `DATABASE_URL`. Le schéma
(`supabase/migrations/0001_init.sql`) est appliqué automatiquement au
démarrage du service (`CREATE TABLE IF NOT EXISTS` — sans danger à
rejouer). Le ton de marque et les notes de style par catégorie vivent
également en base (tables `brand_voice`, `category_playbooks`) plutôt que
dans des fichiers — un fichier sur le disque d'un service Render ne
survivrait pas à un redéploiement.

Un dossier `data/` (exclu du dépôt via `.gitignore`) reste utilisé pour ce
qui doit rester local à l'instance:
- `connection.json` — quelle messagerie est active (Gmail ou Outlook) et
  quelle adresse est connectée.
- `gmail-token.json` / `graph-token.json` — jetons OAuth de la messagerie
  connectée.

La base contient des métadonnées d'emails clients (objet, adresse,
catégorie — pas systématiquement le contenu complet des messages, sauf le
mode test/carnet qui journalise le corps pour revue), à traiter comme
donnée personnelle (RGPD): accès restreint, sauvegardes chiffrées, durée de
rétention définie avec le client.

## Comment le système sait qu'il y a eu une réponse

`src/pipeline/relanceCheck.ts` compare, à chaque vérification (toutes les
2 minutes par défaut), le nombre de messages envoyés automatiquement par
le pipeline (`automated_outbound_count`) au nombre réel de messages
envoyés par la messagerie connectée dans le fil: si ce dernier est plus
grand, un humain a répondu, et le dossier passe au statut "Répondu" — la
relance vers l'équipe s'arrête, et la relance vers le client (si celui-ci
reste ensuite silencieux) prend le relais.

Ce mécanisme suppose que la réponse part **de la messagerie connectée**,
dans le **même fil** (thread Gmail / conversation Outlook). Il a des angles
morts, à connaître avant de compter dessus à 100%:

- **Réponse envoyée depuis une autre adresse** (compte personnel d'un
  agent, autre outil) — invisible, puisque le connecteur n'a accès qu'à la
  messagerie connectée.
- **Nouveau message au lieu d'une réponse dans le fil** — si l'agent
  compose un email neuf plutôt que de répondre dans le fil existant, le
  rattachement peut se rompre (surtout si l'objet change).
- **Résolution hors email** (téléphone, en personne) — aucune visibilité
  possible par nature.

Pour couvrir ces cas, une page de suivi manuel existe:

### Registre des dossiers (`npm run setup` → onglet "Registre des dossiers")

Liste tous les dossiers avec leur statut, échéance et nombre de relances,
et propose un bouton **"Marquer répondu"** pour clôturer manuellement un
dossier que la détection automatique n'a pas vu passer. Règle d'usage à
donner à l'équipe: toujours répondre dans le même fil pour que la
détection automatique fonctionne; le bouton manuel reste le filet de
sécurité.

Cliquer sur un dossier ouvre sa **page de détail**: dates, statut, séquence
de relance appliquée (avec quelles étapes sont déjà passées), et les
actions "Marquer répondu" / "Supprimer les données".

## Séquences de relance

Le cycle de vie d'un dossier a **deux phases indépendantes**, chacune avec
sa propre séquence de relance:

1. **Avant notre réponse** — personne chez nous n'a encore répondu de fond
   au client. Ancrée sur l'échéance SLA (`due_at`). S'arrête dès qu'un
   humain envoie une réponse de fond (un devis, par exemple) — le dossier
   passe alors en statut **"En attente du client"**.
2. **Après notre réponse** — on attend désormais la réponse du client à ce
   qu'on lui a envoyé. Ancrée sur l'heure de cette réponse
   (`human_replied_at`), pas sur l'échéance d'origine. S'arrête dès que le
   client répond; sinon, relance le CLIENT (pas notre équipe), en
   référençant ce qu'on lui a déjà envoyé.

Chaque phase, pour chaque **catégorie**, a sa propre liste ordonnée
d'étapes — un délai **en minutes** (affiché en minutes, heures ou jours
selon la grandeur: `+30min`, `+4h`, `J+2`) et un canal: **rappel interne**
(journalisé sur la page Journal *et* envoyé par email — à `NOTIFICATION_EMAIL`
si défini, sinon à la messagerie connectée elle-même) ou **relance externe**
(email envoyé automatiquement, rédigé par Claude — avec un ton différent
selon la phase: "toujours en cours de traitement" avant notre réponse,
"suivi de notre devis" après). Se règle depuis **Réglages** (`/reglages`),
par catégorie et par phase — pas de redéploiement nécessaire.

Un **dossier précis** peut avoir sa propre séquence (par phase),
indépendante de celle de sa catégorie: depuis sa page de détail,
"Personnaliser pour ce dossier" pré-remplit une séquence modifiable à
partir de la séquence effective du moment; tant qu'elle existe, elle
remplace entièrement la règle de la catégorie pour ce dossier et cette
phase. "Revenir à la règle de la catégorie" la supprime.

Techniquement, deux tables (`relance_steps` et `post_reply_relance_steps`
dans `src/db.ts`) portent chacune les deux cas — étapes rattachées à une
catégorie (`owner_type='category'`) ou à un dossier (`owner_type='thread'`)
— et `getEffectiveRelanceSteps(threadId, categoryId, phase)` résout
laquelle s'applique. `relance_count` / `post_reply_relance_count` sur le
dossier servent d'index dans leur séquence respective.

### Devis envoyé sans demande préalable du client

Un dossier n'est normalement créé que par un email **entrant** — si vous
envoyez un devis à froid (démarchage, prospect qui n'a jamais écrit),
aucun dossier n'existe pour ce fil et aucune relance ne peut se
déclencher. Pour couvrir ce cas, le pipeline scrute aussi le dossier
"Envoyés" (`src/pipeline/discoverOutbound.ts`): tout email sortant dont le
fil n'est pas déjà suivi devient automatiquement un dossier en phase
"après notre réponse", catégorie "autre" par défaut (à ajuster ensuite).
Seuls les envois **postérieurs au démarrage du process** sont pris en
compte, pour ne pas générer d'un coup un dossier par email de l'historique
au premier déploiement.

## Installation

```bash
npm install
cp .env.example .env
```

### 1. Clé API Claude

Ajoutez `ANTHROPIC_API_KEY` dans `.env`.

### 2. Base de données (Supabase)

1. Créez un projet sur [supabase.com](https://supabase.com) — un projet par
   environnement (`globallink-dev`, `globallink-prod`), jamais partagé entre
   les deux.
2. Dans le tableau de bord du projet: Settings → Database → Connection
   string. Copiez-la dans `.env` sous `DATABASE_URL`.
3. Aucune migration manuelle a lancer: `src/db.ts` applique automatiquement
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   au demarrage (`CREATE TABLE IF NOT EXISTS` — sans danger a rejouer),
   puis amorce les categories depuis `config/categories.json` si la base
   est vide.

### 3. Configuration agence (une fois par client)

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

### 4. Page de connexion (le client branche sa boîte lui-même)

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
`SETUP_USERNAME` et `SETUP_PASSWORD_HASH` dans `.env`. Générez le hash avec:

```bash
npm run auth:hash-password -- "votre-mot-de-passe"
```

et collez la ligne `SETUP_PASSWORD_HASH=...` affichée dans `.env`. Sans ces
variables, l'application n'est pas protégée — un avertissement s'affiche au
démarrage tant qu'elles sont vides. La page de login est désormais une page
brandée propre à l'application (plus le popup natif du navigateur), avec
session cookie, protection CSRF sur tous les formulaires, et une limite de
tentatives (5 essais / 15 min / IP).

`SETUP_PASSWORD` (mot de passe en clair) reste accepté pour compatibilité
ascendante mais est déprécié — préférez `SETUP_PASSWORD_HASH`.

### 5. Personnalisation métier

- **Catégories et séquences de relance** (SLA par catégorie, accusé
  automatique, et la séquence d'étapes de relance de chaque catégorie —
  voir [Séquences de relance](#séquences-de-relance)) se règlent désormais
  depuis l'application, onglet **Réglages** (`npm run setup` →
  `/reglages`) — **aucun redéploiement nécessaire**. Le fichier
  [`config/categories.json`](config/categories.json) ne sert plus qu'à
  l'amorçage initial de la base au premier démarrage; il est ensuite ignoré.
- [`config/brand-voice.md`](config/brand-voice.md) — ton de marque, exemples
  à suivre, ce qu'il faut éviter. À compléter avec le client pendant
  l'atelier de cadrage.
- **Image de marque de l'application** (nom, couleur, logo) — variables
  `BRAND_NAME`, `BRAND_PRIMARY_COLOR`, `BRAND_LOGO_URL` dans `.env`.

### Autres pages de l'application

- **Journal** (`/journal`) — historique des rappels internes et relances
  externes envoyées automatiquement (table `reminders`).
- **Confidentialité & rétention** (`/confidentialite`) — ce qui est stocké,
  pendant combien de temps, et comment supprimer les données d'un dossier
  (bouton "Supprimer les données" sur la page de détail du dossier).

### 6. Lancement

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
process persistant. Or le pipeline dépend d'un `node-cron` qui doit rester
actif en continu. Les deux fonctionneraient sur Vercel/Netlify seulement
après avoir réécrit le scheduling (leurs "Cron Jobs" déclenchent une route
HTTP, pas un process qui tourne) — un vrai chantier, pas juste un choix
d'hébergeur.

### Deux environnements: dev et production

Le projet tourne en **deux instances séparées**, chacune avec son propre
projet Supabase — jamais la même base ni la même messagerie connectée:

- **`globallink-dev`** — pour tester et corriger des bugs sans risque.
  Connectée à sa propre messagerie de test, et tourne avec `SHADOW_MODE=true`
  ("Mode test", bandeau rouge visible sur chaque page admin): le pipeline
  classe et rédige normalement, mais n'envoie jamais réellement d'accusé ni
  de relance externe. Deux garde-fous indépendants — la mauvaise
  configuration d'un seul des deux ne suffit donc jamais à joindre un vrai
  client.
- **`globallink-prod`** — la messagerie réelle du client, `SHADOW_MODE`
  désactivé.

[`render.yaml`](render.yaml) décrit les deux services sous forme de
blueprint. `globallink-prod` suit la branche `main`, `globallink-dev` suit
une branche `dev` — promouvoir un changement de dev vers la prod se fait en
mergeant `dev` dans `main`.

### Option recommandée: Render, sans Docker

Render (comme Railway) fait tourner ce projet **tel quel**: un process
Node persistant — exactement ce que le pipeline attend, sans changement de
code, et sans avoir besoin de Docker (Render détecte `package.json` et
construit directement avec `npm install && npm run build`, puis lance
`npm run start:all`).

Pour aller en prod:

1. Poussez ce projet sur un dépôt GitHub/GitLab, avec une branche `dev`.
2. Créez les deux projets Supabase (voir
   [Base de données](#2-base-de-données-supabase)) — un pour dev, un pour
   prod.
3. Sur [render.com](https://render.com) → New → Blueprint → sélectionnez le
   dépôt. Render lit `render.yaml` et propose les deux services tels que
   configurés.
4. **Choisissez le plan payant "Starter"** pour chacun (pas le plan
   gratuit — celui-ci se met en veille après une période d'inactivité, ce
   qui couperait le `node-cron` et donc les accusés/relances automatiques).
5. Pour **chaque service**, renseignez les variables marquées secrètes dans
   le tableau de bord Render — notamment `DATABASE_URL` (le projet Supabase
   correspondant, jamais le même sur les deux services), `ANTHROPIC_API_KEY`,
   `GOOGLE_CLIENT_ID/SECRET`, `AZURE_CLIENT_ID/SECRET/TENANT_ID`,
   `SETUP_USERNAME/PASSWORD`, et les `*_REDIRECT_URI` une fois l'URL Render
   connue, ex. `https://globallink-prod.onrender.com/auth/gmail/callback`.
6. Ajoutez ces mêmes URI de redirection dans Google Cloud Console et
   Azure Portal.
7. Render fournit HTTPS et un sous-domaine `.onrender.com` automatiquement;
   un domaine personnalisé se configure ensuite dans les réglages du service.

### Alternative: Docker (VPS, Azure Container Apps, etc.)

```bash
cp .env.example .env   # completez avec vos vraies valeurs, dont DATABASE_URL
docker compose up -d --build
```

Le `Dockerfile` compile le projet (`npm run build`) puis lance
`node dist/main.js`, qui démarre à la fois la page de connexion/suivi et
le pipeline dans un seul process — un seul service à surveiller.
`docker-compose.yml` monte `./data` en volume pour que `connection.json` et
les jetons OAuth survivent aux redémarrages du conteneur (la base
applicative, elle, vit sur Supabase — voir `DATABASE_URL`). Utile si vous
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
2. **`SETUP_USERNAME` / `SETUP_PASSWORD_HASH`** — obligatoire dès que ce
   n'est plus `localhost`.
3. **`ENCRYPTION_KEY`** — recommandé pour chiffrer au repos les jetons OAuth
   Gmail/Outlook stockés sur disque (`data/gmail-token.json`,
   `data/graph-token.json`). Sans elle, ces fichiers restent en clair.
4. **Secrets** — `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_SECRET`,
   `AZURE_CLIENT_SECRET`, `SETUP_PASSWORD_HASH`, `ENCRYPTION_KEY` via le
   gestionnaire de secrets de votre hébergeur (variables d'environnement du
   service), jamais un fichier `.env` committé.
5. **Process toujours actif** — le pipeline dépend d'un `node-cron` qui
   tourne dans le process; il faut donc un service "always on"
   (App Service avec "Always On" activé, VM + systemd/pm2, ou un
   orchestrateur de conteneurs), pas une fonction serverless qui s'éteint
   entre les requêtes.
6. **`DATABASE_URL`** — pointe vers le projet Supabase de PRODUCTION, jamais
   celui de dev.
7. **Scrutation → webhooks** — au-delà du pilote, remplacer le polling par
   les souscriptions Microsoft Graph / Gmail push (Pub/Sub) pour un
   traitement en quasi temps réel et moins d'appels API.

Hébergeur suggéré si vous ciblez Outlook/M365 en priorité: Azure App
Service (Linux, Node) ou Azure Container Apps — cohérence avec
l'écosystème du client, simplifie la validation par son équipe IT.
Alternatives valables pour un pilote plus léger: Railway, Render, Fly.io.

## Ce que ce dépôt ne peut pas faire à votre place

Ces points nécessitent un accès direct aux consoles Google Cloud / Azure du
client (comptes, écrans de consentement, soumissions de vérification) —
aucune modification de code ne peut les couvrir:

- **Google OAuth — écran de consentement + vérification.** Tant que
  l'app OAuth reste en mode "Testing", les utilisateurs voient "Google
  n'a pas vérifié cette application" à l'écran de consentement. À faire
  dans [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
  OAuth consent screen: renseigner nom, logo, domaine, politique de
  confidentialité et conditions d'utilisation, puis soumettre l'app à
  vérification (obligatoire pour les scopes sensibles `gmail.send` /
  `gmail.readonly`). Ce projet publie désormais une page
  [Confidentialité & rétention](#4-page-de-connexion-le-client-branche-sa-boîte-lui-même)
  (`/confidentialite`) qui peut servir de base à la politique de
  confidentialité demandée par Google.
- **Azure — image de marque de l'inscription d'application.** Dans le
  [Azure Portal](https://portal.azure.com) du client → Entra ID → App
  registrations → Branding & properties: ajouter logo et domaine
  d'éditeur, sinon l'écran de consentement Microsoft affiche un nom
  générique sans logo.
- **URI de redirection de production.** `GOOGLE_REDIRECT_URI` et
  `AZURE_REDIRECT_URI` pointent vers `localhost` par défaut
  ([`.env.example`](.env.example)) — à remplacer par l'URL HTTPS réelle et à
  enregistrer à l'identique côté Google Cloud Console et Azure Portal avant
  toute autorisation en production (voir
  [Checklist avant d'exposer publiquement](#checklist-avant-dexposer-publiquement)).

## Tests

```bash
npm test          # tests unitaires (node:test), sans accès email ni clé API
npm run typecheck
```

`npm test` couvre les unités isolables (utilitaires, chiffrement des jetons,
authentification/session/CSRF, résolution des catégories, résolution des
séquences de relance catégorie/dossier) — voir
[`test/`](test). La logique du pipeline complet (classification + rédaction
+ envoi réel) suppose un accès Claude/connecteur réel et n'est donc pas
couverte par des tests automatisés.
Le workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) fait
tourner `typecheck` + `test` sur chaque push/PR.

## Structure du projet

```
config/
  categories.json         catégories, SLA, règles de relance — amorçage initial uniquement (voir /reglages)
  brand-voice.md           ton de marque — amorçage initial uniquement (voir /ton-de-marque)
supabase/
  migrations/0001_init.sql  schéma Postgres, appliqué automatiquement au démarrage (voir src/db.ts)
src/
  connectors/               Gmail et Microsoft Graph (interface commune EmailConnector)
  web/server.ts             login + connexion messagerie + suivi des dossiers + réglages + journal
  web/auth.ts                sessions, CSRF, hash de mot de passe, limitation des tentatives
  crypto.ts                  chiffrement AES-256-GCM des jetons OAuth au repos
  settings.ts                categories/seuils de relance, lus depuis la base
  ai/                        classification + rédaction (Claude)
  pipeline/                  orchestration (email entrant, vérification des relances)
  scripts/                   auth Gmail en CLI (fallback), hash de mot de passe
  connectionState.ts         messagerie active (écrit par la page de connexion)
  dbPool.ts                  pool de connexion Postgres partagé (injectable par les tests, voir test/_pgTestDb.ts)
  db.ts                      dossiers, catégories, séquences de relance (par catégorie ou par dossier), journal (Postgres/Supabase)
  scheduler.ts, index.ts     pipeline seul
  main.ts                    pipeline + page web dans un seul process (prod/Docker)
test/                      tests unitaires (node:test, exécutés via tsx, base pg-mem isolée par fichier)
render.yaml                       déploiement Render, deux services (dev + prod)
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
- Le rappel interne (`recordReminder`, kind `internal`) est journalisé en
  base et visible sur la page **Journal** (`/journal`) — à brancher sur
  Slack/Teams/email d'équipe selon l'outil du client pour une notification
  active plutôt qu'une simple consultation.
- Aucune purge automatique des données anciennes: suppression uniquement
  manuelle, dossier par dossier, depuis sa page de détail (voir
  [Confidentialité & rétention](#autres-pages-de-lapplication)).
- Un seul compte connecté à la fois par instance (`data/connection.json`).
  Pour plusieurs boîtes clientes en parallèle, faire tourner une instance
  du service par boîte plutôt que de partager l'état de connexion.
