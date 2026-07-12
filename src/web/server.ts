import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getConnectionState, saveConnectionState, clearConnectionState } from "../connectionState.js";
import { buildGmailAuthUrl, exchangeCodeForGmailToken } from "../connectors/gmailAuth.js";
import { buildGraphAuthUrl, exchangeCodeForGraphToken } from "../connectors/graphAuth.js";
import { GmailConnector } from "../connectors/gmailConnector.js";
import { GraphConnector } from "../connectors/graphConnector.js";
import {
  deleteThreadData,
  listCategories,
  listReminders,
  listRecentThreads,
  getRelanceSettingsRow,
  setThreadStatus,
  updateCategory,
  updateRelanceSettingsRow,
  type ReminderRow,
  type ThreadRow,
} from "../db.js";
import type { CategoryConfig, RelanceConfig } from "../types.js";
import {
  authConfigured,
  clearSessionCookie,
  createSession,
  destroySession,
  isLoginRateLimited,
  parseCookies,
  recordLoginFailure,
  requireAuth,
  requireCsrf,
  resetLoginAttempts,
  setSessionCookie,
  verifyLogin,
} from "./auth.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));

function query(req: Request): Record<string, string> {
  return req.query as unknown as Record<string, string>;
}

// ---------- Favicon (public, avant l'authentification) ----------

app.get("/favicon.svg", (_req: Request, res: Response) => {
  const initial = escapeHtml(config.branding.name.trim().charAt(0).toUpperCase() || "A");
  const color = config.branding.primaryColor;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="14" fill="${color}"/>` +
      `<text x="32" y="43" font-family="Arial, sans-serif" font-size="30" font-weight="700" ` +
      `fill="#ffffff" text-anchor="middle">${initial}</text></svg>`
  );
});

// ---------- Connexion (page de login applicative) ----------

app.get("/login", (req: Request, res: Response) => {
  const q = query(req);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderLoginPage({ next: q.next ?? "/", error: q.error }));
});

app.post("/login", (req: Request, res: Response) => {
  const ip = req.ip ?? "unknown";
  const body = req.body as Record<string, string>;
  const next = body.next && body.next.startsWith("/") ? body.next : "/";

  if (isLoginRateLimited(ip)) {
    res.redirect(
      `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(
        "Trop de tentatives. Reessayez dans quelques minutes."
      )}`
    );
    return;
  }

  if (!authConfigured() || verifyLogin(body.username ?? "", body.password ?? "")) {
    resetLoginAttempts(ip);
    const { token } = createSession();
    setSessionCookie(res, token, req.secure);
    res.redirect(next);
    return;
  }

  recordLoginFailure(ip);
  res.redirect(
    `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(
      "Identifiants incorrects."
    )}`
  );
});

app.post("/logout", (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  destroySession(cookies.sess);
  clearSessionCookie(res);
  res.redirect("/login");
});

// ---------- Tout ce qui suit necessite une session valide ----------

app.use(requireAuth);

function setStateCookie(res: Response, name: string, value: string): void {
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
  );
}

app.get("/", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderConnectionPage(query(req), res.locals.csrfToken as string | undefined));
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

app.post("/auth/disconnect", requireCsrf, (_req: Request, res: Response) => {
  clearConnectionState();
  res.redirect("/?disconnected=1");
});

// ---------- Suivi des dossiers ----------

app.get("/dossiers", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderDossiersPage(listRecentThreads(150), res.locals.csrfToken as string | undefined));
});

app.post("/dossiers/:threadId/cloturer", requireCsrf, (req: Request, res: Response) => {
  setThreadStatus(req.params.threadId, "closed");
  res.redirect("/dossiers");
});

app.post("/dossiers/:threadId/supprimer", requireCsrf, (req: Request, res: Response) => {
  deleteThreadData(req.params.threadId);
  res.redirect("/dossiers");
});

// ---------- Reglages (categories + seuils de relance) ----------

app.get("/reglages", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderReglagesPage(
      listCategories(),
      getRelanceSettingsRow(),
      res.locals.csrfToken as string | undefined,
      query(req).saved
    )
  );
});

app.post("/reglages/categories/:id", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  updateCategory(req.params.id, {
    label: (body.label ?? "").trim() || req.params.id,
    slaHours: Math.max(0, Number(body.slaHours) || 0),
    acknowledgeAutomatically: body.acknowledgeAutomatically === "on",
    allowExternalRelance: body.allowExternalRelance === "on",
  });
  res.redirect("/reglages?saved=1");
});

app.post("/reglages/relance", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  updateRelanceSettingsRow({
    internalReminderAfterHours: Math.max(0, Number(body.internalReminderAfterHours) || 0),
    externalRelanceAfterHours: Math.max(0, Number(body.externalRelanceAfterHours) || 0),
    maxRelances: Math.max(0, Math.floor(Number(body.maxRelances) || 0)),
  });
  res.redirect("/reglages?saved=1");
});

// ---------- Journal (audit des relances) ----------

app.get("/journal", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderJournalPage(listReminders(150)));
});

// ---------- Confidentialite / retention ----------

app.get("/confidentialite", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfidentialitePage());
});

// ---------- Gabarit commun ----------

type ActivePage = "connexion" | "dossiers" | "reglages" | "journal" | "confidentialite";

function pageShell(active: ActivePage, title: string, sub: string, body: string): string {
  const brand = config.branding;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>${escapeHtml(brand.name)} — ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --brand-primary: ${brand.primaryColor}; --brand-primary-ink: #ffffff; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 20px 60px; min-height: 100vh;
    background: #F3F5F4; color: #16202A;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    display: flex; justify-content: center;
  }
  @media (prefers-color-scheme: dark) { body { background: #12181F; color: #E7ECE9; } }
  main { width: 100%; max-width: 780px; }
  header.brand { display: flex; align-items: center; gap: 10px; padding: 28px 0 18px; }
  header.brand img, header.brand .logo {
    width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  }
  header.brand .logo {
    background: var(--brand-primary); color: var(--brand-primary-ink);
    display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px;
  }
  header.brand .name { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
  nav { display: flex; gap: 18px; margin-bottom: 26px; font-size: 13.5px; flex-wrap: wrap; }
  nav a { color: #7C8B92; text-decoration: none; padding-bottom: 4px; border-bottom: 2px solid transparent; }
  nav a.active { color: #16202A; font-weight: 600; border-color: var(--brand-primary); }
  @media (prefers-color-scheme: dark) {
    nav a.active { color: #E7ECE9; }
  }
  nav form { margin-left: auto; }
  nav .btn-link {
    background: none; border: none; color: #7C8B92; font-size: 13.5px; cursor: pointer; padding: 0;
    text-decoration: underline;
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.sub { color: #5B6B72; margin: 0 0 28px; font-size: 14.5px; max-width: 60ch; }
  @media (prefers-color-scheme: dark) { p.sub { color: #92A3AA; } }
  .banner { padding: 12px 16px; border-radius: 6px; font-size: 14px; margin-bottom: 20px; }
  .banner-ok { background: #E4F3EA; color: #205C3C; }
  .banner-error { background: #FBE7E4; color: #8A2E20; }
  .banner-info { background: #E9EEF3; color: #2B4A5E; }
  @media (prefers-color-scheme: dark) {
    .banner-ok { background: #163827; color: #8FD8AE; }
    .banner-error { background: #3A2019; color: #F1A493; }
    .banner-info { background: #1B2A34; color: #9FC2D8; }
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
  .btn-primary { background: var(--brand-primary); color: var(--brand-primary-ink); }
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
  .badge-internal { background: #E9EEF3; color: #2B4A5E; }
  @media (prefers-color-scheme: dark) { .badge-internal { background: #1B2A34; color: #9FC2D8; } }
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
  .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .settings-section { margin-bottom: 32px; }
  .settings-section h2 { font-size: 15px; margin: 0 0 12px; }
  .settings-table { border: 1px solid #D8DEDA; border-radius: 8px; overflow: hidden; background: #FFFFFF; }
  @media (prefers-color-scheme: dark) { .settings-table { background: #182028; border-color: #2C3841; } }
  .settings-head, .settings-row {
    display: grid; grid-template-columns: 1.6fr .8fr 1fr 1.1fr .6fr;
    gap: 10px; align-items: center; padding: 10px 14px;
  }
  .settings-head {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #7C8B92;
    border-bottom: 1px solid #D8DEDA;
  }
  @media (prefers-color-scheme: dark) { .settings-head { border-color: #2C3841; } }
  .settings-row { border-bottom: 1px solid #E7EBE7; }
  .settings-row:last-child { border-bottom: none; }
  @media (prefers-color-scheme: dark) { .settings-row { border-color: #202A31; } }
  .settings-row input[type=text], .settings-row input[type=number], .relance-form input[type=number] {
    width: 100%; padding: 7px 9px; border-radius: 6px; border: 1px solid #D8DEDA;
    background: #F8F9F8; color: inherit; font-size: 13.5px;
  }
  @media (prefers-color-scheme: dark) {
    .settings-row input[type=text], .settings-row input[type=number], .relance-form input[type=number] {
      background: #12181F; border-color: #2C3841;
    }
  }
  .settings-row .cat-id { font-size: 11px; color: #97A2A0; display: block; margin-top: 2px; }
  .checkbox-cell { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .relance-form {
    border: 1px solid #D8DEDA; border-radius: 8px; padding: 18px 20px; background: #FFFFFF;
    display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    align-items: end;
  }
  @media (prefers-color-scheme: dark) { .relance-form { background: #182028; border-color: #2C3841; } }
  .relance-form label { font-size: 12px; color: #7C8B92; display: block; margin-bottom: 6px; }
  .field-group { display: grid; gap: 4px; }
  .login-wrap { max-width: 360px; margin: 60px auto 0; }
  .login-wrap form { display: grid; gap: 14px; }
  .login-wrap input {
    width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #D8DEDA;
    background: #F8F9F8; color: inherit; font-size: 14px;
  }
  @media (prefers-color-scheme: dark) { .login-wrap input { background: #12181F; border-color: #2C3841; } }
  .login-wrap label { font-size: 13px; font-weight: 600; }
</style>
</head>
<body>
<main>
  <header class="brand">
    ${
      brand.logoUrl
        ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" />`
        : `<span class="logo">${escapeHtml(brand.name.trim().charAt(0).toUpperCase() || "A")}</span>`
    }
    <span class="name">${escapeHtml(brand.name)}</span>
  </header>
  <nav>
    <a href="/" class="${active === "connexion" ? "active" : ""}">Connexion</a>
    <a href="/dossiers" class="${active === "dossiers" ? "active" : ""}">Suivi des dossiers</a>
    <a href="/reglages" class="${active === "reglages" ? "active" : ""}">Réglages</a>
    <a href="/journal" class="${active === "journal" ? "active" : ""}">Journal</a>
    <form method="POST" action="/logout"><button class="btn-link" type="submit">Déconnexion</button></form>
  </nav>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${sub}</p>
  ${body}
</main>
</body>
</html>`;
}

function csrfField(csrfToken: string | undefined): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken ?? "")}" />`;
}

// ---------- Page de connexion applicative (login) ----------

function renderLoginPage(opts: { next: string; error?: string }): string {
  const brand = config.branding;
  const banner = opts.error ? `<div class="banner banner-error">${escapeHtml(opts.error)}</div>` : "";
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>${escapeHtml(brand.name)} — Connexion</title>
<style>
  :root { color-scheme: light dark; --brand-primary: ${brand.primaryColor}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #F3F5F4; color: #16202A; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #12181F; color: #E7ECE9; } }
  .login-wrap { width: 100%; max-width: 360px; padding: 20px; }
  .brand-row { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
  .logo {
    width: 32px; height: 32px; border-radius: 8px; background: var(--brand-primary); color: #fff;
    display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;
  }
  h1 { font-size: 19px; margin: 0 0 20px; }
  form { display: grid; gap: 14px; }
  label { font-size: 13px; font-weight: 600; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #D8DEDA;
    background: #FFFFFF; color: inherit; font-size: 14px; margin-top: 6px;
  }
  @media (prefers-color-scheme: dark) { input { background: #182028; border-color: #2C3841; } }
  button {
    padding: 11px 18px; border-radius: 6px; border: none; background: var(--brand-primary); color: #fff;
    font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .banner-error { background: #FBE7E4; color: #8A2E20; padding: 12px 16px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) { .banner-error { background: #3A2019; color: #F1A493; } }
</style>
</head>
<body>
  <div class="login-wrap">
    <div class="brand-row">
      <span class="logo">${escapeHtml(brand.name.trim().charAt(0).toUpperCase() || "A")}</span>
      <strong>${escapeHtml(brand.name)}</strong>
    </div>
    <h1>Connexion</h1>
    ${banner}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(opts.next)}" />
      <div>
        <label for="username">Identifiant</label>
        <input id="username" name="username" type="text" autocomplete="username" required />
      </div>
      <div>
        <label for="password">Mot de passe</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>
      <button type="submit">Se connecter</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------- Page de connexion messagerie ----------

function renderConnectionPage(q: Record<string, string>, csrfToken: string | undefined): string {
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
  ${renderStatus(state, csrfToken)}
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

function renderStatus(state: ReturnType<typeof getConnectionState>, csrfToken: string | undefined): string {
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
      ${csrfField(csrfToken)}
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

function renderDossiersPage(threads: ThreadRow[], csrfToken: string | undefined): string {
  const categoryLabels = new Map(listCategories().map((c) => [c.id, c.label]));
  const rows = threads.map((row) => renderThreadRow(row, csrfToken, categoryLabels)).join("");
  const table = threads.length
    ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>Dossier</th><th>Catégorie</th><th>Statut</th><th>Échéance</th><th>Relances</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<div class="table-wrap"><div class="empty">Aucun dossier pour le moment — ils apparaissent ici dès qu'un email entrant est traité.</div></div>`;

  const retentionBanner = `<div class="banner banner-info">Les données des dossiers (sujet, expéditeur, dates, nombre de relances) sont conservées indéfiniment tant qu'elles ne sont pas supprimées manuellement. Voir la <a href="/confidentialite">page confidentialité &amp; rétention</a>.</div>`;

  return pageShell(
    "dossiers",
    "Suivi des dossiers",
    "Détection automatique de réponse à partir du fil email connecté. Si un dossier a été traité autrement (autre boîte, téléphone), clôturez-le ici manuellement.",
    retentionBanner + table
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

function renderThreadRow(
  row: ThreadRow,
  csrfToken: string | undefined,
  categoryLabels: Map<string, string>
): string {
  const statusInfo = STATUS_LABELS[row.status] ?? { label: row.status, badgeClass: "badge-skip" };
  const isOverdue =
    row.due_at !== null &&
    new Date(row.due_at).getTime() < Date.now() &&
    !["responded", "closed", "skipped"].includes(row.status);
  const badgeClass = isOverdue ? "badge-late" : statusInfo.badgeClass;
  const statusLabel = isOverdue ? `${statusInfo.label} (en retard)` : statusInfo.label;

  const dueLabel = row.due_at ? new Date(row.due_at).toLocaleString("fr-FR") : "—";
  const canClose = !["responded", "closed", "skipped"].includes(row.status);
  const categoryLabel = categoryLabels.get(row.category_id) ?? row.category_id;

  return `<tr>
    <td>
      <div class="subject">${escapeHtml(row.subject)}</div>
      <div class="meta">${escapeHtml(row.sender_name ? `${row.sender_name} — ` : "")}${escapeHtml(row.sender_email)}</div>
    </td>
    <td>${escapeHtml(categoryLabel)}</td>
    <td><span class="badge ${badgeClass}">${escapeHtml(statusLabel)}</span></td>
    <td>${escapeHtml(dueLabel)}</td>
    <td>${row.relance_count}</td>
    <td>
      <div class="row-actions">
        ${
          canClose
            ? `<form method="POST" action="/dossiers/${encodeURIComponent(row.thread_id)}/cloturer">
                 ${csrfField(csrfToken)}
                 <button class="btn btn-ghost btn-sm" type="submit">Marquer répondu</button>
               </form>`
            : ""
        }
        <form method="POST" action="/dossiers/${encodeURIComponent(row.thread_id)}/supprimer"
              onsubmit="return confirm('Supprimer definitivement les donnees de ce dossier ?');">
          ${csrfField(csrfToken)}
          <button class="btn btn-ghost btn-sm" type="submit">Supprimer les données</button>
        </form>
      </div>
    </td>
  </tr>`;
}

// ---------- Reglages ----------

function renderReglagesPage(
  categories: CategoryConfig[],
  relance: RelanceConfig,
  csrfToken: string | undefined,
  saved: string | undefined
): string {
  const banner = saved ? `<div class="banner banner-ok">Modifications enregistrées — aucun redéploiement nécessaire.</div>` : "";

  const categoryRows = categories
    .map(
      (cat) => `
    <form class="settings-row" method="POST" action="/reglages/categories/${encodeURIComponent(cat.id)}">
      ${csrfField(csrfToken)}
      <div>
        <input type="text" name="label" value="${escapeHtml(cat.label)}" />
        <span class="cat-id">${escapeHtml(cat.id)}</span>
      </div>
      <div><input type="number" name="slaHours" value="${cat.slaHours}" min="0" step="0.5" /></div>
      <div class="checkbox-cell">
        <input type="checkbox" id="ack-${escapeHtml(cat.id)}" name="acknowledgeAutomatically" ${cat.acknowledgeAutomatically ? "checked" : ""} />
        <label for="ack-${escapeHtml(cat.id)}">Accusé auto.</label>
      </div>
      <div class="checkbox-cell">
        <input type="checkbox" id="ext-${escapeHtml(cat.id)}" name="allowExternalRelance" ${cat.allowExternalRelance ? "checked" : ""} />
        <label for="ext-${escapeHtml(cat.id)}">Relance externe</label>
      </div>
      <div><button class="btn btn-primary btn-sm" type="submit">Enregistrer</button></div>
    </form>`
    )
    .join("");

  const body = `
    ${banner}
    <div class="settings-section">
      <h2>Catégories</h2>
      <div class="settings-table">
        <div class="settings-head">
          <div>Libellé</div><div>SLA (h)</div><div>Accusé</div><div>Relance externe</div><div></div>
        </div>
        ${categoryRows}
      </div>
    </div>
    <div class="settings-section">
      <h2>Seuils de relance globaux</h2>
      <form class="relance-form" method="POST" action="/reglages/relance">
        ${csrfField(csrfToken)}
        <div class="field-group">
          <label for="internalReminderAfterHours">Rappel interne après (h)</label>
          <input id="internalReminderAfterHours" type="number" name="internalReminderAfterHours" min="0" step="0.5" value="${relance.internalReminderAfterHours}" />
        </div>
        <div class="field-group">
          <label for="externalRelanceAfterHours">Relance externe après (h)</label>
          <input id="externalRelanceAfterHours" type="number" name="externalRelanceAfterHours" min="0" step="0.5" value="${relance.externalRelanceAfterHours}" />
        </div>
        <div class="field-group">
          <label for="maxRelances">Nombre max. de relances</label>
          <input id="maxRelances" type="number" name="maxRelances" min="0" step="1" value="${relance.maxRelances}" />
        </div>
        <div><button class="btn btn-primary" type="submit">Enregistrer les seuils</button></div>
      </form>
    </div>`;

  return pageShell(
    "reglages",
    "Réglages",
    "SLA par catégorie, accusé automatique, autorisation de relance externe, et seuils globaux de relance — modifiables ici, sans redéploiement.",
    body
  );
}

// ---------- Journal (audit) ----------

function renderJournalPage(reminders: ReminderRow[]): string {
  const rows = reminders.map(renderReminderRow).join("");
  const table = reminders.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Dossier</th><th>Type</th><th>Note</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<div class="table-wrap"><div class="empty">Aucune entrée pour le moment — les rappels internes et relances externes apparaissent ici.</div></div>`;

  return pageShell(
    "journal",
    "Journal",
    "Historique des rappels internes et relances externes envoyées automatiquement par le pipeline.",
    table
  );
}

function renderReminderRow(row: ReminderRow): string {
  const kindLabel = row.kind === "external" ? "Relance externe" : "Rappel interne";
  const kindClass = row.kind === "external" ? "badge-late" : "badge-internal";
  return `<tr>
    <td>
      <div class="subject">${escapeHtml(row.subject)}</div>
      <div class="meta">${escapeHtml(row.sender_email)}</div>
    </td>
    <td><span class="badge ${kindClass}">${escapeHtml(kindLabel)}</span></td>
    <td>${escapeHtml(row.note ?? "—")}</td>
    <td>${escapeHtml(new Date(row.created_at).toLocaleString("fr-FR"))}</td>
  </tr>`;
}

// ---------- Confidentialite / retention ----------

function renderConfidentialitePage(): string {
  const body = `
    <div class="cards">
      <div class="card" style="flex-direction:column; align-items:flex-start; gap:8px;">
        <h2>Ce qui est stocké</h2>
        <p>Pour chaque dossier: le sujet de l'email, le nom et l'adresse de l'expéditeur, la catégorie détectée,
        les dates de réception/accusé/relance, et le nombre de relances envoyées. Le contenu (corps) des messages
        n'est jamais persisté en base — il transite uniquement vers le connecteur email (Gmail/Outlook) et
        l'API Claude au moment du traitement.</p>
      </div>
      <div class="card" style="flex-direction:column; align-items:flex-start; gap:8px;">
        <h2>Durée de conservation</h2>
        <p>Les données sont conservées indéfiniment tant qu'un dossier n'est pas supprimé manuellement depuis
        la page <a href="/dossiers">Suivi des dossiers</a> (bouton "Supprimer les données"). Il n'y a pas de
        purge automatique à ce jour.</p>
      </div>
      <div class="card" style="flex-direction:column; align-items:flex-start; gap:8px;">
        <h2>Demande de suppression</h2>
        <p>Pour supprimer les données d'un dossier précis, utilisez le bouton "Supprimer les données" sur la
        ligne correspondante dans <a href="/dossiers">Suivi des dossiers</a>. Cette action supprime le dossier,
        ses brouillons associés et son historique de relances.</p>
      </div>
    </div>`;

  return pageShell(
    "confidentialite",
    "Confidentialité & rétention",
    "Ce que cette application stocke, pendant combien de temps, et comment demander une suppression.",
    body
  );
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
