import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getConnectionState, saveConnectionState, clearConnectionState } from "../connectionState.js";
import { buildGmailAuthUrl, exchangeCodeForGmailToken } from "../connectors/gmailAuth.js";
import { buildGraphAuthUrl, exchangeCodeForGraphToken } from "../connectors/graphAuth.js";
import { GmailConnector } from "../connectors/gmailConnector.js";
import { GraphConnector } from "../connectors/graphConnector.js";
import { listRecentThreads, setThreadStatus, type ThreadRow } from "../db.js";

const app = express();

const SETUP_USERNAME = process.env.SETUP_USERNAME ?? "";
const SETUP_PASSWORD = process.env.SETUP_PASSWORD ?? "";

if (!SETUP_USERNAME || !SETUP_PASSWORD) {
  console.warn(
    "[avertissement] SETUP_USERNAME / SETUP_PASSWORD non definis: cette page n'est pas protegee. " +
      "A ne jamais laisser ainsi en dehors de localhost."
  );
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!SETUP_USERNAME || !SETUP_PASSWORD) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(header.slice(6), "base64").toString("utf-8").split(":");
    if (user === SETUP_USERNAME && pass === SETUP_PASSWORD) {
      next();
      return;
    }
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Accuse de reception"');
  res.status(401).send("Authentification requise.");
}

app.use(requireAuth);

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  (header ?? "").split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setStateCookie(res: Response, name: string, value: string): void {
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
  );
}

function query(req: Request): Record<string, string> {
  return req.query as unknown as Record<string, string>;
}

app.get("/", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderConnectionPage(query(req)));
});

app.get("/auth/gmail/start", (_req: Request, res: Response) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    res.redirect("/?error=" + encodeURIComponent("Configuration Google manquante cote agence."));
    return;
  }
  const state = randomUUID();
  setStateCookie(res, "gmail_oauth_state", state);
  res.redirect(buildGmailAuthUrl(state));
});

app.get("/auth/gmail/callback", async (req: Request, res: Response) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const { code, state, error } = query(req);
    if (error) throw new Error(`Autorisation refusee: ${error}`);
    if (!code || !state || state !== cookies.gmail_oauth_state) {
      throw new Error("Requete invalide ou expiree, merci de reessayer.");
    }
    await exchangeCodeForGmailToken(code);
    const email = await new GmailConnector().getOwnEmailAddress();
    saveConnectionState({ provider: "gmail", email, connectedAt: new Date().toISOString() });
    res.redirect("/?connected=gmail");
  } catch (err) {
    res.redirect("/?error=" + encodeURIComponent((err as Error).message));
  }
});

app.get("/auth/graph/start", (_req: Request, res: Response) => {
  if (!config.azure.clientId || !config.azure.clientSecret) {
    res.redirect("/?error=" + encodeURIComponent("Configuration Microsoft manquante cote agence."));
    return;
  }
  const state = randomUUID();
  setStateCookie(res, "graph_oauth_state", state);
  res.redirect(buildGraphAuthUrl(state));
});

app.get("/auth/graph/callback", async (req: Request, res: Response) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const { code, state, error, error_description: errorDescription } = query(req);
    if (error) throw new Error(`Autorisation refusee: ${errorDescription ?? error}`);
    if (!code || !state || state !== cookies.graph_oauth_state) {
      throw new Error("Requete invalide ou expiree, merci de reessayer.");
    }
    await exchangeCodeForGraphToken(code);
    const email = await new GraphConnector().getOwnEmailAddress();
    saveConnectionState({ provider: "graph", email, connectedAt: new Date().toISOString() });
    res.redirect("/?connected=graph");
  } catch (err) {
    res.redirect("/?error=" + encodeURIComponent((err as Error).message));
  }
});

app.post("/auth/disconnect", (_req: Request, res: Response) => {
  clearConnectionState();
  res.redirect("/?disconnected=1");
});

app.get("/dossiers", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderDossiersPage(listRecentThreads(150)));
});

app.post("/dossiers/:threadId/cloturer", (req: Request, res: Response) => {
  setThreadStatus(req.params.threadId, "closed");
  res.redirect("/dossiers");
});

// ---------- Gabarit commun ----------

function pageShell(active: "connexion" | "dossiers", title: string, sub: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 20px 60px; min-height: 100vh;
    background: #F3F5F4; color: #16202A;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    display: flex; justify-content: center;
  }
  @media (prefers-color-scheme: dark) { body { background: #12181F; color: #E7ECE9; } }
  main { width: 100%; max-width: 760px; }
  nav { display: flex; gap: 18px; margin-bottom: 26px; font-size: 13.5px; }
  nav a { color: #7C8B92; text-decoration: none; padding-bottom: 4px; border-bottom: 2px solid transparent; }
  nav a.active { color: #16202A; font-weight: 600; border-color: #16202A; }
  @media (prefers-color-scheme: dark) {
    nav a.active { color: #E7ECE9; border-color: #E7ECE9; }
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.sub { color: #5B6B72; margin: 0 0 28px; font-size: 14.5px; max-width: 60ch; }
  @media (prefers-color-scheme: dark) { p.sub { color: #92A3AA; } }
  .banner { padding: 12px 16px; border-radius: 6px; font-size: 14px; margin-bottom: 20px; }
  .banner-ok { background: #E4F3EA; color: #205C3C; }
  .banner-error { background: #FBE7E4; color: #8A2E20; }
  @media (prefers-color-scheme: dark) {
    .banner-ok { background: #163827; color: #8FD8AE; }
    .banner-error { background: #3A2019; color: #F1A493; }
  }
  .status {
    border: 1px solid #D8DEDA; border-radius: 8px; padding: 16px 20px;
    margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center;
    background: #FFFFFF; flex-wrap: wrap; gap: 12px;
  }
  @media (prefers-color-scheme: dark) { .status { background: #182028; border-color: #2C3841; } }
  .status .label { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #7C8B92; margin-bottom: 4px; }
  .status .value { font-size: 15px; font-weight: 600; }
  .cards { display: grid; gap: 14px; }
  .card {
    border: 1px solid #D8DEDA; border-radius: 8px; padding: 20px;
    background: #FFFFFF; display: flex; justify-content: space-between; align-items: center; gap: 16px;
  }
  @media (prefers-color-scheme: dark) { .card { background: #182028; border-color: #2C3841; } }
  .card h2 { font-size: 16px; margin: 0 0 4px; }
  .card p { font-size: 13.5px; color: #5B6B72; margin: 0; }
  @media (prefers-color-scheme: dark) { .card p { color: #92A3AA; } }
  .btn {
    display: inline-block; padding: 10px 18px; border-radius: 6px; text-decoration: none;
    font-size: 14px; font-weight: 600; white-space: nowrap; border: none; cursor: pointer;
  }
  .btn-sm { padding: 6px 12px; font-size: 12.5px; }
  .btn-primary { background: #16202A; color: #fff; }
  @media (prefers-color-scheme: dark) { .btn-primary { background: #E7ECE9; color: #12181F; } }
  .btn-ghost { background: transparent; color: #8A2E20; border: 1px solid #D8B7B0; }
  .btn-disabled { background: #E9ECEA; color: #97A2A0; pointer-events: none; }
  @media (prefers-color-scheme: dark) { .btn-disabled { background: #222C33; color: #5A6870; } }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #E4F3EA; color: #205C3C; margin-left: 8px; white-space: nowrap; }
  @media (prefers-color-scheme: dark) { .badge { background: #163827; color: #8FD8AE; } }
  .badge-wait { background: #FBF0DA; color: #8A5A0F; }
  @media (prefers-color-scheme: dark) { .badge-wait { background: #3A2E12; color: #E0B15C; } }
  .badge-late { background: #FBE7E4; color: #8A2E20; }
  @media (prefers-color-scheme: dark) { .badge-late { background: #3A2019; color: #F1A493; } }
  .badge-done { background: #E4F3EA; color: #205C3C; }
  @media (prefers-color-scheme: dark) { .badge-done { background: #163827; color: #8FD8AE; } }
  .badge-skip { background: #E9ECEA; color: #6B7A80; }
  @media (prefers-color-scheme: dark) { .badge-skip { background: #222C33; color: #92A3AA; } }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #7C8B92; padding: 8px 10px; border-bottom: 1px solid #D8DEDA; }
  @media (prefers-color-scheme: dark) { th { border-color: #2C3841; } }
  td { padding: 10px; border-bottom: 1px solid #E7EBE7; vertical-align: top; }
  @media (prefers-color-scheme: dark) { td { border-color: #202A31; } }
  .subject { font-weight: 600; }
  .meta { color: #7C8B92; font-size: 12px; }
  .table-wrap { overflow-x: auto; border: 1px solid #D8DEDA; border-radius: 8px; background: #FFFFFF; }
  @media (prefers-color-scheme: dark) { .table-wrap { background: #182028; border-color: #2C3841; } }
  .table-wrap table { min-width: 620px; }
  .empty { padding: 40px 20px; text-align: center; color: #7C8B92; font-size: 14px; }
  footer { margin-top: 28px; font-size: 12.5px; color: #7C8B72; }
</style>
</head>
<body>
<main>
  <nav>
    <a href="/" class="${active === "connexion" ? "active" : ""}">Connexion</a>
    <a href="/dossiers" class="${active === "dossiers" ? "active" : ""}">Suivi des dossiers</a>
  </nav>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${sub}</p>
  ${body}
</main>
</body>
</html>`;
}

// ---------- Page de connexion ----------

function renderConnectionPage(q: Record<string, string>): string {
  const state = getConnectionState();
  const googleReady = Boolean(config.google.clientId && config.google.clientSecret);
  const azureReady = Boolean(config.azure.clientId && config.azure.clientSecret);

  const banner = q.error
    ? `<div class="banner banner-error">${escapeHtml(q.error)}</div>`
    : q.connected
      ? `<div class="banner banner-ok">Compte ${escapeHtml(q.connected === "gmail" ? "Gmail" : "Outlook")} connecte avec succes.</div>`
      : q.disconnected
        ? `<div class="banner banner-ok">Messagerie deconnectee.</div>`
        : "";

  const body = `
  ${banner}
  ${renderStatus(state)}
  <div class="cards">
    ${renderProviderCard({
      title: "Gmail",
      description: "Compte de test pour le pilote.",
      provider: "gmail",
      ready: googleReady,
      readyLabel: "Configuration Google manquante côté agence (.env)",
      state,
    })}
    ${renderProviderCard({
      title: "Outlook / Microsoft 365",
      description: "Messagerie de production du client.",
      provider: "graph",
      ready: azureReady,
      readyLabel: "Configuration Microsoft manquante côté agence (.env)",
      state,
    })}
  </div>
  <footer>Une seule messagerie active à la fois. Se reconnecter avec l'autre bascule le pipeline automatiquement.</footer>`;

  return pageShell(
    "connexion",
    "Connexion de la messagerie",
    "Le client choisit sa messagerie et autorise l'accès depuis cette page — aucune configuration manuelle de son côté.",
    body
  );
}

function renderStatus(state: ReturnType<typeof getConnectionState>): string {
  if (!state) {
    return `<div class="status"><div><div class="label">Statut</div><div class="value">Aucune messagerie connectée</div></div></div>`;
  }
  const providerLabel = state.provider === "gmail" ? "Gmail" : "Outlook / Microsoft 365";
  const since = new Date(state.connectedAt).toLocaleString("fr-FR");
  return `<div class="status">
    <div>
      <div class="label">Statut</div>
      <div class="value">${escapeHtml(state.email)} <span class="badge">${providerLabel}</span></div>
      <div class="label" style="margin-top:6px;">Connecté depuis le ${escapeHtml(since)}</div>
    </div>
    <form method="POST" action="/auth/disconnect">
      <button class="btn btn-ghost" type="submit">Déconnecter</button>
    </form>
  </div>`;
}

function renderProviderCard(opts: {
  title: string;
  description: string;
  provider: "gmail" | "graph";
  ready: boolean;
  readyLabel: string;
  state: ReturnType<typeof getConnectionState>;
}): string {
  const isActive = opts.state?.provider === opts.provider;
  const actionLabel = isActive ? "Reconnecter" : "Connecter";

  const button = !opts.ready
    ? `<span class="btn btn-disabled">${escapeHtml(opts.readyLabel)}</span>`
    : `<a class="btn btn-primary" href="/auth/${opts.provider}/start">${actionLabel}</a>`;

  return `<div class="card">
    <div>
      <h2>${escapeHtml(opts.title)}${isActive ? '<span class="badge">Active</span>' : ""}</h2>
      <p>${escapeHtml(opts.description)}</p>
    </div>
    ${button}
  </div>`;
}

// ---------- Suivi des dossiers ----------

function renderDossiersPage(threads: ThreadRow[]): string {
  const rows = threads.map(renderThreadRow).join("");
  const table = threads.length
    ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>Dossier</th><th>Catégorie</th><th>Statut</th><th>Échéance</th><th>Relances</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<div class="table-wrap"><div class="empty">Aucun dossier pour le moment — ils apparaissent ici dès qu'un email entrant est traité.</div></div>`;

  return pageShell(
    "dossiers",
    "Suivi des dossiers",
    "Détection automatique de réponse à partir du fil email connecté. Si un dossier a été traité autrement (autre boîte, téléphone), clôturez-le ici manuellement.",
    table
  );
}

const STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  received: { label: "Reçu", badgeClass: "badge-wait" },
  skipped: { label: "Sans suite requise", badgeClass: "badge-skip" },
  ack_sent: { label: "Accusé envoyé", badgeClass: "badge-wait" },
  drafts_ready: { label: "Brouillons prêts", badgeClass: "badge-wait" },
  responded: { label: "Répondu", badgeClass: "badge-done" },
  relance_sent: { label: "Relancé", badgeClass: "badge-late" },
  closed: { label: "Clôturé", badgeClass: "badge-done" },
};

function renderThreadRow(row: ThreadRow): string {
  const statusInfo = STATUS_LABELS[row.status] ?? { label: row.status, badgeClass: "badge-skip" };
  const isOverdue =
    row.due_at !== null &&
    new Date(row.due_at).getTime() < Date.now() &&
    !["responded", "closed", "skipped"].includes(row.status);
  const badgeClass = isOverdue ? "badge-late" : statusInfo.badgeClass;
  const statusLabel = isOverdue ? `${statusInfo.label} (en retard)` : statusInfo.label;

  const dueLabel = row.due_at ? new Date(row.due_at).toLocaleString("fr-FR") : "—";
  const canClose = !["responded", "closed", "skipped"].includes(row.status);

  return `<tr>
    <td>
      <div class="subject">${escapeHtml(row.subject)}</div>
      <div class="meta">${escapeHtml(row.sender_name ? `${row.sender_name} — ` : "")}${escapeHtml(row.sender_email)}</div>
    </td>
    <td>${escapeHtml(row.category_id)}</td>
    <td><span class="badge ${badgeClass}">${escapeHtml(statusLabel)}</span></td>
    <td>${escapeHtml(dueLabel)}</td>
    <td>${row.relance_count}</td>
    <td>${
      canClose
        ? `<form method="POST" action="/dossiers/${encodeURIComponent(row.thread_id)}/cloturer">
             <button class="btn btn-ghost btn-sm" type="submit">Marquer répondu</button>
           </form>`
        : ""
    }</td>
  </tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.listen(config.webPort, () => {
  console.log(`Page de connexion disponible sur http://localhost:${config.webPort}`);
});
