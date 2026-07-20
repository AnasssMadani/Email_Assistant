import express, { type Request, type Response, Router } from "express";
import { config, loadBrandVoice, saveBrandVoice } from "../config.js";
import { getConnectionState } from "../connectionState.js";
import {
  getClientMonthlyStats,
  getClientThreadDetail,
  listClientCategories,
  listClientSendHistory,
  listClientThreads,
  setThreadStatus,
  updateClientCategorySla,
  type ClientThreadSummary,
} from "../db.js";
import { csrfField, escapeHtml, formatDateTime, sharedStyles } from "./shared.js";
import { requireCsrf } from "./auth.js";

/**
 * Dashboard client — routes neuves, vues dediees (jamais les vues admin
 * filtrees a la volee). Monte sous /client dans server.ts, deja protege par
 * requireClientAuth avant d'atteindre ce routeur: chaque handler ici peut
 * donc supposer une session valide (client ou admin en previsualisation).
 */
export const clientRouter: Router = express.Router();
clientRouter.use(express.urlencoded({ extended: false }));

function query(req: Request): Record<string, string> {
  return req.query as unknown as Record<string, string>;
}

// ---------- Gabarit commun ----------

type ActiveClientPage = "accueil" | "dossiers" | "historique" | "ton-de-marque" | "connexion" | "categories";

function clientPageShell(
  active: ActiveClientPage,
  title: string,
  sub: string,
  body: string,
  csrfToken: string | undefined,
  backLink?: string
): string {
  const brand = config.branding;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>${escapeHtml(brand.name)} — ${escapeHtml(title)}</title>
<style>${sharedStyles(brand.primaryColor)}</style>
</head>
<body>
<main>
  <header class="brand">
    ${
      brand.logoUrl
        ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" />`
        : `<span class="seal">${escapeHtml(brand.name.trim().charAt(0).toUpperCase() || "A")}</span>`
    }
    <span class="name">${escapeHtml(brand.name)}</span>
  </header>
  <nav>
    <a href="/client" class="${active === "accueil" ? "active" : ""}">Accueil</a>
    <a href="/client/dossiers" class="${active === "dossiers" ? "active" : ""}">Mes dossiers</a>
    <a href="/client/historique" class="${active === "historique" ? "active" : ""}">Historique</a>
    <a href="/client/ton-de-marque" class="${active === "ton-de-marque" ? "active" : ""}">Ton de marque</a>
    <a href="/client/connexion" class="${active === "connexion" ? "active" : ""}">Connexion messagerie</a>
    <a href="/client/categories" class="${active === "categories" ? "active" : ""}">Catégories &amp; délais</a>
    <form method="POST" action="/logout">
      <input type="hidden" name="fromClient" value="1" />
      <button class="btn-link" type="submit">Déconnexion</button>
    </form>
  </nav>
  ${backLink ? `<a class="back-link" href="${backLink}">&larr; Retour</a>` : ""}
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${sub}</p>
  ${csrfToken ? "" : ""}
  ${body}
</main>
</body>
</html>`;
}

function htmlPage(res: Response, html: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

// ---------- Accueil / apercu du mois ----------

clientRouter.get("/", (_req: Request, res: Response) => {
  const stats = getClientMonthlyStats();
  const delaiLabel =
    stats.delaiMoyenReponseMinutes === null
      ? "—"
      : stats.delaiMoyenReponseMinutes < 60
        ? `${stats.delaiMoyenReponseMinutes} min`
        : `${(stats.delaiMoyenReponseMinutes / 60).toFixed(1)} h`;

  const body = `
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">Emails traités ce mois</div>
        <div class="metric-value">${stats.emailsTraites}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Délai moyen jusqu'à notre réponse</div>
        <div class="metric-value">${escapeHtml(delaiLabel)}</div>
        <div class="metric-sub">Temps moyen avant qu'un membre de l'équipe réponde personnellement.</div>
      </div>
      <div class="metric">
        <div class="metric-label">Relances envoyées ce mois</div>
        <div class="metric-value">${stats.relancesEnvoyees}</div>
        <div class="metric-sub">Suivis automatiques envoyés en votre nom quand une réponse tardait.</div>
      </div>
      <div class="metric">
        <div class="metric-label">Dossiers en cours</div>
        <div class="metric-value">${stats.dossiersEnCours}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Dossiers résolus</div>
        <div class="metric-value">${stats.dossiersResolus}</div>
      </div>
    </div>
    <div class="cards">
      <div class="card">
        <div>
          <h2>Voir le détail de chaque dossier</h2>
          <p>Suivez l'avancement de chaque échange avec vos clients, étape par étape.</p>
        </div>
        <a class="btn btn-primary" href="/client/dossiers">Mes dossiers</a>
      </div>
    </div>
  `;
  htmlPage(
    res,
    clientPageShell(
      "accueil",
      "Aperçu du mois",
      "Un coup d'œil sur l'activité de votre messagerie automatisée.",
      body,
      res.locals.csrfToken as string | undefined
    )
  );
});

// ---------- Mes dossiers ----------

function threadRowHtml(t: ClientThreadSummary): string {
  const dueLabel = t.dueAt ? formatDateTime(t.dueAt) : "—";
  return `
    <div class="ledger-row">
      <div class="ledger-main">
        <a class="subject-link" href="/client/dossiers/${encodeURIComponent(t.threadId)}">${escapeHtml(t.subject)}</a>
        <div class="ledger-meta">${escapeHtml(t.senderName ? `${t.senderName} — ${t.senderEmail}` : t.senderEmail)}</div>
      </div>
      <div class="ledger-facts">
        <div class="ledger-fact">
          <span class="fact-label">Catégorie</span>
          <span class="fact-value">${escapeHtml(t.categoryLabel)}</span>
        </div>
        <div class="ledger-fact">
          <span class="fact-label">Échéance</span>
          <span class="fact-value">${escapeHtml(dueLabel)}</span>
        </div>
        <div class="ledger-fact">
          <span class="fact-label">Statut</span>
          <span class="fact-value">${t.resolved ? "Résolu" : "En cours"}</span>
        </div>
      </div>
    </div>
  `;
}

clientRouter.get("/dossiers", (req: Request, res: Response) => {
  const q = query(req);
  const filter = q.filtre === "resolus" ? "resolus" : q.filtre === "tous" ? "tous" : "en_cours";
  const all = listClientThreads();
  const filtered = all.filter((t) => {
    if (filter === "tous") return true;
    if (filter === "resolus") return t.resolved;
    return !t.resolved;
  });

  const tabs = `
    <div class="filter-tabs">
      <a href="/client/dossiers?filtre=en_cours" class="${filter === "en_cours" ? "active" : ""}">En cours</a>
      <a href="/client/dossiers?filtre=resolus" class="${filter === "resolus" ? "active" : ""}">Résolus</a>
      <a href="/client/dossiers?filtre=tous" class="${filter === "tous" ? "active" : ""}">Tous</a>
    </div>
  `;

  const list = filtered.length
    ? `<div class="ledger">${filtered.map(threadRowHtml).join("")}</div>`
    : `<div class="empty">Aucun dossier dans cette vue.</div>`;

  htmlPage(
    res,
    clientPageShell(
      "dossiers",
      "Mes dossiers",
      "L'état de chaque échange avec vos clients, en un coup d'œil.",
      tabs + list,
      res.locals.csrfToken as string | undefined
    )
  );
});

function checklistItem(label: string, done: boolean, extra?: string): string {
  return `
    <div class="checklist-item ${done ? "done" : ""}">
      <span class="box">${done ? "✓" : ""}</span>
      <span class="label">${escapeHtml(label)}</span>
      ${extra ? `<span class="box-delay">${escapeHtml(extra)}</span>` : ""}
    </div>
  `;
}

clientRouter.get("/dossiers/:threadId", (req: Request, res: Response) => {
  const detail = getClientThreadDetail(req.params.threadId);
  if (!detail) {
    res.status(404).send("Dossier introuvable.");
    return;
  }

  const c = detail.checklist;
  const checklist = `
    <div class="checklist">
      ${checklistItem("Accusé envoyé", c.accuseEnvoye.done, c.accuseEnvoye.at ? formatDateTime(c.accuseEnvoye.at) : undefined)}
      ${checklistItem("Relance interne (rappel à l'équipe)", c.relanceInterne.done)}
      ${checklistItem("Relance client (avant réponse)", c.relanceClientAvantReponse.done)}
      ${checklistItem(
        "Réponse envoyée par l'équipe",
        c.reponseEquipe.done,
        c.reponseEquipe.delayLabel ? `répondu en ${c.reponseEquipe.delayLabel}` : undefined
      )}
      ${checklistItem("Relance après réponse (client silencieux)", c.relanceApresReponse.done)}
      ${checklistItem("Dossier clôturé", c.cloture.done)}
    </div>
  `;

  const action = detail.resolved
    ? ""
    : `
    <form method="POST" action="/client/dossiers/${encodeURIComponent(detail.threadId)}/resoudre">
      ${csrfField(res.locals.csrfToken as string | undefined)}
      <button class="btn btn-primary" type="submit">Marquer comme résolu</button>
    </form>
  `;

  const body = `
    <div class="detail-header">
      <div class="subject-static">${escapeHtml(detail.subject)}</div>
      <div class="ledger-meta">${escapeHtml(detail.senderName ? `${detail.senderName} — ${detail.senderEmail}` : detail.senderEmail)}</div>
      <div class="detail-facts">
        <div class="ledger-fact">
          <span class="fact-label">Catégorie</span>
          <span class="fact-value">${escapeHtml(detail.categoryLabel)}</span>
        </div>
        <div class="ledger-fact">
          <span class="fact-label">Reçu le</span>
          <span class="fact-value">${escapeHtml(formatDateTime(detail.receivedAt))}</span>
        </div>
      </div>
      ${checklist}
      <div class="detail-actions">${action}</div>
    </div>
  `;

  htmlPage(
    res,
    clientPageShell(
      "dossiers",
      "Détail du dossier",
      "Progression de ce dossier, étape par étape.",
      body,
      res.locals.csrfToken as string | undefined,
      "/client/dossiers"
    )
  );
});

clientRouter.post("/dossiers/:threadId/resoudre", requireCsrf, (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  if (getClientThreadDetail(threadId)) {
    setThreadStatus(threadId, "closed");
  }
  res.redirect(`/client/dossiers/${encodeURIComponent(threadId)}`);
});

// ---------- Historique des envois automatiques ----------

clientRouter.get("/historique", (_req: Request, res: Response) => {
  const entries = listClientSendHistory();
  const list = entries.length
    ? `<div class="ledger">${entries
        .map(
          (e) => `
      <div class="ledger-row">
        <div class="ledger-main">
          <div class="subject-static">${escapeHtml(e.sentence)}</div>
          <div class="ledger-meta">${escapeHtml(formatDateTime(e.at))}</div>
        </div>
      </div>
    `
        )
        .join("")}</div>`
    : `<div class="empty">Aucun envoi automatique pour le moment.</div>`;

  htmlPage(
    res,
    clientPageShell(
      "historique",
      "Historique des envois automatiques",
      "Chaque accusé et chaque relance envoyés en votre nom.",
      list,
      res.locals.csrfToken as string | undefined
    )
  );
});

// ---------- Ton de marque ----------

clientRouter.get("/ton-de-marque", (req: Request, res: Response) => {
  const q = query(req);
  const banner = q.saved
    ? `<div class="banner banner-ok">Ton de marque enregistré.</div>`
    : q.error
      ? `<div class="banner banner-error">Une erreur est survenue.</div>`
      : "";
  const content = loadBrandVoice();
  const body = `
    ${banner}
    <form method="POST" action="/client/ton-de-marque">
      ${csrfField(res.locals.csrfToken as string | undefined)}
      <textarea class="brand-voice-editor" name="content" rows="16">${escapeHtml(content)}</textarea>
      <div style="margin-top: 14px;">
        <button class="btn btn-primary" type="submit">Enregistrer</button>
      </div>
    </form>
  `;
  htmlPage(
    res,
    clientPageShell(
      "ton-de-marque",
      "Ton de marque",
      "Ajustez le ton des emails générés automatiquement pour qu'ils vous ressemblent.",
      body,
      res.locals.csrfToken as string | undefined
    )
  );
});

clientRouter.post("/ton-de-marque", requireCsrf, (req: Request, res: Response) => {
  try {
    saveBrandVoice(((req.body as Record<string, string>).content ?? "").toString());
    res.redirect("/client/ton-de-marque?saved=1");
  } catch {
    res.redirect("/client/ton-de-marque?error=1");
  }
});

// ---------- Connexion messagerie ----------

clientRouter.get("/connexion", (req: Request, res: Response) => {
  const q = query(req);
  const state = getConnectionState();
  const googleReady = Boolean(config.google.clientId && config.google.clientSecret);
  const azureReady = Boolean(config.azure.clientId && config.azure.clientSecret);

  const banner = q.error
    ? `<div class="banner banner-error">${escapeHtml(q.error)}</div>`
    : q.connected
      ? `<div class="banner banner-ok">Messagerie reconnectée avec succès.</div>`
      : "";

  const statusBlock = state
    ? `
    <div class="status">
      <div>
        <div class="label">Statut</div>
        <div class="value">Connectée — ${escapeHtml(state.email)}</div>
      </div>
      <a class="btn btn-secondary" href="/auth/${state.provider}/start?from=client">Reconnecter</a>
    </div>
  `
    : `
    <div class="status">
      <div>
        <div class="label">Statut</div>
        <div class="value">Non connectée</div>
      </div>
      <div style="display:flex; gap:8px;">
        ${googleReady ? `<a class="btn btn-primary" href="/auth/gmail/start?from=client">Connecter Gmail</a>` : ""}
        ${azureReady ? `<a class="btn btn-primary" href="/auth/graph/start?from=client">Connecter Outlook</a>` : ""}
      </div>
    </div>
  `;

  htmlPage(
    res,
    clientPageShell(
      "connexion",
      "Connexion messagerie",
      "L'état de la connexion à votre boîte email — reconnectez-la si besoin, en un clic.",
      banner + statusBlock,
      res.locals.csrfToken as string | undefined
    )
  );
});

// ---------- Categories & delais ----------

clientRouter.get("/categories", (req: Request, res: Response) => {
  const q = query(req);
  const banner = q.saved ? `<div class="banner banner-ok">Délai mis à jour.</div>` : "";
  const categories = listClientCategories();
  const rows = categories
    .map(
      (c) => `
    <form method="POST" action="/client/categories/${encodeURIComponent(c.id)}" class="category-head-form" style="grid-template-columns: 2fr 1fr auto;">
      ${csrfField(res.locals.csrfToken as string | undefined)}
      <div>
        <span class="field-label">Catégorie</span>
        ${escapeHtml(c.label)}
      </div>
      <div>
        <span class="field-label">Délai de réponse promis (min)</span>
        <input type="number" name="slaMinutes" min="1" value="${c.slaMinutes}" required />
      </div>
      <div>
        <button class="btn btn-secondary btn-sm" type="submit">Enregistrer</button>
      </div>
    </form>
  `
    )
    .join("");

  const body = `${banner}<div class="cards">${rows}</div>`;
  htmlPage(
    res,
    clientPageShell(
      "categories",
      "Catégories & délais",
      "Le délai de réponse que nous promettons à vos clients, par type de demande.",
      body,
      res.locals.csrfToken as string | undefined
    )
  );
});

clientRouter.post("/categories/:id", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const slaMinutes = Math.max(1, Number(body.slaMinutes) || 1440);
  updateClientCategorySla(req.params.id, slaMinutes);
  res.redirect("/client/categories?saved=1");
});
