import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante: ${name}. Copiez .env.example vers .env et completez-la.`
    );
  }
  return value;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // PORT: injectee automatiquement par la plupart des PaaS (Render, Railway,
  // Heroku...). WEB_PORT reste prioritaire pour un usage local/personnalise.
  webPort: Number(process.env.WEB_PORT ?? process.env.PORT ?? 4300),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4300/auth/gmail/callback",
    tokenPath: process.env.GOOGLE_TOKEN_PATH ?? "./data/gmail-token.json",
  },
  azure: {
    clientId: process.env.AZURE_CLIENT_ID ?? "",
    clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
    tenantId: process.env.AZURE_TENANT_ID ?? "common",
    redirectUri: process.env.AZURE_REDIRECT_URI ?? "http://localhost:4300/auth/graph/callback",
    tokenPath: process.env.AZURE_TOKEN_PATH ?? "./data/graph-token.json",
  },
  pollIntervalCron: process.env.POLL_INTERVAL_CRON ?? "*/2 * * * *",
  // Cadence de verification des relances/rappels dus. A 30 min (l'ancien
  // defaut), une relance ciblee a 15 min pouvait arriver avec jusqu'a 45 min
  // de retard reel. Alignee sur pollIntervalCron pour des delais courts
  // (quelques minutes, meme jour) fiables — reste ajustable via l'env si
  // besoin d'un intervalle different.
  relanceCheckCron: process.env.RELANCE_CHECK_CRON ?? "*/2 * * * *",
  // Chaine de connexion Postgres/Supabase (postgresql://user:pass@host:port/db).
  // Une instance par environnement (dev/prod) — voir README, section Supabase.
  databaseUrl: process.env.DATABASE_URL ?? "",
  categoriesConfigPath: process.env.CATEGORIES_CONFIG_PATH ?? "./config/categories.json",
  // Contenu par defaut, lu UNE SEULE FOIS au tout premier demarrage (base
  // vide) pour amorcer la ligne `brand_voice` en base — modifiable ensuite
  // uniquement depuis /ton-de-marque, jamais relu depuis ce fichier. Le
  // stockage en base (plutot que ce fichier seul) evite que Render ne
  // reinitialise silencieusement les modifications a chaque redeploiement
  // (le disque de build n'est pas persistant, contrairement a /var/data).
  brandVoicePath: process.env.BRAND_VOICE_PATH ?? "./config/brand-voice.md",
  connectionStatePath: process.env.CONNECTION_STATE_PATH ?? "./data/connection.json",
  emailConnector: (process.env.EMAIL_CONNECTOR ?? "gmail") as "gmail" | "graph" | "imap",
  // Boite IMAP/SMTP classique (ex: Roundcube/cPanel) — utilisee quand
  // EMAIL_CONNECTOR=imap. Pas de flux OAuth: identifiants lus ici
  // uniquement, jamais versionnes (voir .env.example). La lecture IMAP est
  // strictement passive (EXAMINE + BODY.PEEK, voir imapReadOnlyGuard.ts).
  imap: {
    host: process.env.IMAP_HOST ?? "",
    port: Number(process.env.IMAP_PORT ?? 993),
    // true = TLS des la connexion (port 993) ; false = STARTTLS (port 143).
    secure: (process.env.IMAP_SECURE ?? "true") !== "false",
    user: process.env.IMAP_USER ?? "",
    password: process.env.IMAP_PASSWORD ?? "",
    // Mode "boite copie": IMAP_USER/IMAP_PASSWORD sont ceux d'une boite
    // dediee (ex: assistant@domaine) qui recoit, par une redirection cPanel,
    // une copie de chaque email arrivant sur l'adresse partagee. On ne se
    // connecte alors jamais a la boite du client. Renseigner ici l'adresse
    // partagee (ex: contact@domaine) pour reconnaitre les reponses de
    // l'equipe (recues en Cci). Vide = SMTP_FROM, puis IMAP_USER.
    mailboxAddress: process.env.IMAP_MAILBOX_ADDRESS ?? "",
    inboxFolder: process.env.IMAP_INBOX_FOLDER ?? "INBOX",
    // Vide = detection automatique via LIST (attribut special-use \Sent),
    // avec repli sur les noms usuels cPanel/Dovecot ("INBOX.Sent", "Sent").
    sentFolder: process.env.IMAP_SENT_FOLDER ?? "",
    // Fenetre de recherche des messages d'un fil (getThread). Sur une boite
    // de ~800 emails/jour, une recherche d'en-tete sans borne de date
    // parcourrait des centaines de milliers de messages a chaque cycle.
    threadLookbackDays: Number(process.env.IMAP_THREAD_LOOKBACK_DAYS ?? 60),
  },
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 465),
    // true = TLS des la connexion (port 465) ; false = STARTTLS (port 587).
    secure: (process.env.SMTP_SECURE ?? "true") !== "false",
    // Vides = memes identifiants que l'IMAP (cas cPanel standard).
    user: process.env.SMTP_USER ?? "",
    password: process.env.SMTP_PASSWORD ?? "",
    // Adresse "From" des envois et adresse comparee pour isFromUs. Vide =
    // IMAP_USER (sur cPanel, l'identifiant EST l'adresse email).
    fromAddress: process.env.SMTP_FROM ?? "",
  },
  // Cle AES-256 (64 caracteres hexadecimaux) pour chiffrer les jetons OAuth au
  // repos. Generer avec: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Si absente, les jetons restent en clair sur disque (avertissement au demarrage).
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  // Destinataire des rappels internes (email). Vide par defaut: la
  // notification part alors vers la messagerie connectee elle-meme, comme
  // un pense-bete dans sa propre boite plutot que dans le vide.
  notificationEmail: process.env.NOTIFICATION_EMAIL ?? "",
  // Plafond d'environnement de l'etape d'activation (voir src/stage.ts).
  // L'etape elle-meme vit en base et se bascule depuis /etape ; ce plafond
  // permet a un deploiement (ex: globallink-dev, voir render.yaml) de rester
  // verrouille en silencieux quoi qu'on choisisse dans le back-office.
  // Ancien SHADOW_MODE=true toujours honore (= MAX_STAGE=0) pour ne pas
  // lever le verrou d'un deploiement existant a la mise a jour.
  maxStage: parseMaxStage(process.env.MAX_STAGE, process.env.SHADOW_MODE),
  // Plafond de categories creees automatiquement par la classification sur
  // 24h glissantes (voir createCategoryFromAi dans db.ts) — au-dela, l'email
  // tombe dans la categorie de repli. 0 desactive la creation automatique.
  aiCategoriesMaxPerDay: Math.max(0, Number(process.env.AI_CATEGORIES_MAX_PER_DAY ?? 3) || 0),
  // Dossier des notes de style par categorie, generees a partir du corpus des
  // vraies reponses de l'equipe (voir src/pipeline/corpusAnalysis.ts) et
  // relues par le prompt de redaction de l'accuse. Le contenu vit en base
  // (table category_playbooks) — ce dossier ne sert plus que de source pour
  // d'eventuels fichiers de depart versionnes avec le projet.
  categoryPlaybooksDir: process.env.CATEGORY_PLAYBOOKS_DIR ?? "./config/category-playbooks",
  // Frequence de la passe d'analyse du corpus (voir corpusAnalysis.ts). Nuit,
  // faible trafic — un declenchement manuel depuis /carnet reste disponible
  // pour ne pas attendre l'horaire planifie avant la reunion de fin de semaine.
  dailyAnalysisCron: process.env.DAILY_ANALYSIS_CRON ?? "0 3 * * *",
  // Purge automatique de shadow_log (corps complet des emails entrants +
  // accuses rediges, voir db.ts) au-dela de ce nombre de jours — la page
  // /confidentialite decrit cette retention, elle doit rester le reflet exact
  // de ce qui tourne reellement (voir purgeShadowLogOlderThan dans db.ts et
  // SEC-003 de l'audit securite). 0 ou negatif desactive la purge.
  shadowLogRetentionDays: Number(process.env.SHADOW_LOG_RETENTION_DAYS ?? 90),
  auth: {
    username: process.env.SETUP_USERNAME ?? "",
    // Format "salt:hash" genere par `npm run auth:hash-password -- "motdepasse"`.
    passwordHash: process.env.SETUP_PASSWORD_HASH ?? "",
    // Ancien mode de passe en clair, conserve uniquement pour compatibilite
    // ascendante. A migrer vers SETUP_PASSWORD_HASH.
    legacyPlaintextPassword: process.env.SETUP_PASSWORD ?? "",
  },
  branding: {
    name: process.env.BRAND_NAME ?? "Accusé & Relance",
    primaryColor: process.env.BRAND_PRIMARY_COLOR ?? "#16202A",
    logoUrl: process.env.BRAND_LOGO_URL ?? "",
  },
  // Tarifs Claude en $ par million de tokens, utilises uniquement pour l'estimation
  // de cout affichee dans /consommation — ce sont des valeurs indicatives par
  // defaut, a verifier/ajuster sur la page de tarification Anthropic actuelle
  // pour le modele reellement facture (voir CLAUDE_MODEL dans src/ai/client.ts).
  pricing: {
    inputPerMillionTokensUsd: Number(process.env.CLAUDE_INPUT_PRICE_PER_MTOK ?? 3),
    outputPerMillionTokensUsd: Number(process.env.CLAUDE_OUTPUT_PRICE_PER_MTOK ?? 15),
  },
  // Fuseau d'affichage des dates dans l'admin. Sans ceci, toLocaleString()
  // rend dans le fuseau du serveur d'hebergement (souvent UTC), pas celui de
  // l'equipe — un decalage silencieux d'1h+ selon ou l'app est deployee.
  timezone: process.env.APP_TIMEZONE ?? "Africa/Casablanca",
  // Garde-fou anti-rafale: nombre maximal de relances EXTERNES (celles vues
  // par un client) que le planificateur peut envoyer en un seul cycle de
  // verification. Un rattrapage apres arret du planificateur, ou simplement
  // beaucoup de dossiers configures avec des delais courts arrivant a
  // echeance au meme moment, ne doit jamais se traduire par une rafale
  // d'emails identiques envoyes d'un coup a plusieurs clients — le surplus
  // attend simplement le cycle suivant. Les rappels internes (jamais vus
  // par un client) ne sont pas concernes par cette limite.
  maxExternalRelancesPerCycle: Number(process.env.MAX_EXTERNAL_RELANCES_PER_CYCLE ?? 5),
  // Rapport du matin (voir src/pipeline/morningReport.ts). Heures locales
  // dans config.timezone. Le rapport couvre les 24 h precedant `hour`; la
  // "nuit" (emails arrives hors horaires de bureau, Chine, Turquie...) va de
  // `nightStartHour` la veille jusqu'a `hour`. L'envoi par email lui-meme
  // s'active depuis le back-office (/rapport), jamais par variable d'env.
  morningReport: {
    hour: Number(process.env.MORNING_REPORT_HOUR ?? 9),
    nightStartHour: Number(process.env.MORNING_REPORT_NIGHT_START_HOUR ?? 18),
    // Apres un redemarrage tardif, un rapport pas encore envoye ne part plus
    // au-dela de ce delai apres l'heure prevue (un "rapport du matin" recu a
    // 16 h induit en erreur) — il reste consultable dans le back-office.
    sendCutoffHours: Number(process.env.MORNING_REPORT_SEND_CUTOFF_HOURS ?? 3),
  },
};

/**
 * Valeur invalide (texte, hors 0..3) => 0: un plafond mal saisi doit
 * verrouiller les envois, jamais les ouvrir.
 */
function parseMaxStage(raw: string | undefined, legacyShadowMode: string | undefined): 0 | 1 | 2 | 3 {
  if (legacyShadowMode === "true") return 0;
  if (raw === undefined || raw.trim() === "") return 3;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? (n as 0 | 1 | 2 | 3) : 0;
}

export function requireAnthropicApiKey(): string {
  return config.anthropicApiKey || required("ANTHROPIC_API_KEY");
}

/**
 * Distingue "deploiement reel exposant l'app au public" de "poste local de
 * dev/test" — sert de gate pour les garde-fous fail-closed (auth
 * obligatoire, chiffrement des jetons OAuth obligatoire). NODE_ENV=production
 * est explicitement positionne par render.yaml ; en local/CI, NODE_ENV n'est
 * pas defini (ou vaut autre chose), donc ces garde-fous restent desactives et
 * n'ajoutent aucune friction au developpement.
 */
export function isProductionLike(): boolean {
  return process.env.NODE_ENV === "production";
}
