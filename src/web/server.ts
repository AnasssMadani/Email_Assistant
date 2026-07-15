import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { config, loadBrandVoice, saveBrandVoice } from "../config.js";
import { getConnectionState, saveConnectionState, clearConnectionState } from "../connectionState.js";
import { buildGmailAuthUrl, exchangeCodeForGmailToken } from "../connectors/gmailAuth.js";
import { buildGraphAuthUrl, exchangeCodeForGraphToken } from "../connectors/graphAuth.js";
import { GmailConnector } from "../connectors/gmailConnector.js";
import { GraphConnector } from "../connectors/graphConnector.js";
import { createEmailConnector } from "../connectors/index.js";
import { cleanupUnusedDrafts } from "../pipeline/draftCleanup.js";
import { checkPostReplyThread, checkPreReplyThread } from "../pipeline/relanceCheck.js";
import { sendAcknowledgementAndDrafts } from "../pipeline/processIncoming.js";
import { getCategory } from "../settings.js";
import {
  addCategoryRelanceStep,
  addThreadRelanceStep,
  clearThreadRelanceOverride,
  createCategory,
  deleteCategoryRelanceStep,
  deleteThreadData,
  deleteThreadRelanceStep,
  getAiUsageSummarySince,
  getCategoryRelanceSteps,
  getEffectiveRelanceSteps,
  getThreadRelanceOverride,
  getThreadRow,
  hasThreadRelanceOverride,
  listCategories,
  listDraftsForThread,
  listPipelineErrors,
  listRecentAiUsage,
  listReminders,
  listRecentThreads,
  markMessageProcessed,
  recordPipelineError,
  setThreadHumanReplied,
  setThreadStatus,
  updateCategory,
  upsertThreadReceived,
  type AiUsageEventRow,
  type AiUsageSummary,
  type PipelineErrorRow,
  type RelancePhase,
  type ReminderRow,
  type ThreadRow,
} from "../db.js";
import type { CategoryConfig, EmailMessage, RelanceChannel, RelanceStep } from "../types.js";
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

/**
 * Number() rejette silencieusement une virgule decimale ("1,5") en retournant
 * NaN, ce qui retombe sur 0 via `|| 0` — un utilisateur en locale FR qui tape
 * une virgule voit alors son etape/SLA enregistree a 0 sans aucun message
 * d'erreur, ce qui a ete signale comme "ca ne marche pas". On normalise donc
 * la virgule en point avant de parser.
 */
function parseLocaleNumber(raw: string | undefined): number {
  const normalized = (raw ?? "").trim().replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

function parseStep(body: Record<string, string>): { channel: RelanceChannel; delayMinutes: number } {
  const channel: RelanceChannel = body.channel === "external" ? "external" : "internal";
  const delayMinutes = Math.max(0, parseLocaleNumber(body.delayMinutes));
  return { channel, delayMinutes };
}

/**
 * Un seul menu deroulant, plutot que d'exposer directement "enabled" +
 * "min_urgency" comme deux controles separes — objectif: pouvoir dire en un
 * clic "n'alerte l'equipe que sur les dossiers vraiment urgents" sans avoir a
 * comprendre le modele de donnees sous-jacent.
 */
const ALERT_MODES = {
  never: { enabled: false, minUrgency: "high" as const },
  high: { enabled: true, minUrgency: "high" as const },
  normal: { enabled: true, minUrgency: "normal" as const },
  always: { enabled: true, minUrgency: "low" as const },
};

function alertModeOf(cat: CategoryConfig): keyof typeof ALERT_MODES {
  if (!cat.internalAlertsEnabled) return "never";
  if (cat.internalAlertsMinUrgency === "high") return "high";
  if (cat.internalAlertsMinUrgency === "low") return "always";
  return "normal";
}

function parseAlertMode(value: string | undefined): { enabled: boolean; minUrgency: "low" | "normal" | "high" } {
  return ALERT_MODES[(value as keyof typeof ALERT_MODES) ?? "normal"] ?? ALERT_MODES.normal;
}

/** Empeche une nouvelle etape d'avoir un delai plus court que la precedente (sequence croissante). */
function clampAfterLastStep(steps: RelanceStep[], delayMinutes: number): number {
  const lastDelay = steps.length ? steps[steps.length - 1].delayMinutes : 0;
  return Math.max(delayMinutes, lastDelay);
}

// ---------- Sceau (public, avant l'authentification) ----------

app.get("/favicon.svg", (_req: Request, res: Response) => {
  const initial = escapeHtml(config.branding.name.trim().charAt(0).toUpperCase() || "A");
  const color = config.branding.primaryColor;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<circle cx="32" cy="32" r="30" fill="${color}"/>` +
      `<text x="32" y="43" font-family="Georgia, serif" font-size="30" font-weight="700" ` +
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

type DossierFilter = "a_traiter" | "en_retard" | "resolus" | "tous";

function parseDossierFilter(value: string | undefined): DossierFilter {
  return value === "en_retard" || value === "resolus" || value === "tous" ? value : "a_traiter";
}

app.get("/dossiers", (req: Request, res: Response) => {
  const threads = listRecentThreads(150);
  const usageSummary = getAiUsageSummarySince(currentMonthStartIso());
  const filter = parseDossierFilter(query(req).filtre);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderDossiersPage(threads, res.locals.csrfToken as string | undefined, usageSummary, filter));
});

app.get("/dossiers/:threadId", (req: Request, res: Response) => {
  const thread = getThreadRow(req.params.threadId);
  if (!thread) {
    res.redirect("/dossiers");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderDossierDetailPage(thread, res.locals.csrfToken as string | undefined, query(req).saved, query(req).error)
  );
});

app.post("/dossiers/:threadId/cloturer", requireCsrf, async (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  setThreadStatus(threadId, "closed");
  await attemptCleanup(threadId);
  res.redirect(req.body?._redirect === "detail" ? `/dossiers/${encodeURIComponent(threadId)}` : "/dossiers");
});

app.post("/dossiers/:threadId/supprimer", requireCsrf, async (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  await attemptCleanup(threadId);
  deleteThreadData(threadId);
  res.redirect("/dossiers");
});

app.post("/dossiers/:threadId/nettoyer-brouillons", requireCsrf, async (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  await attemptCleanup(threadId);
  res.redirect(`/dossiers/${encodeURIComponent(threadId)}?saved=1`);
});

app.post("/dossiers/:threadId/relancer-maintenant", requireCsrf, async (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  const thread = getThreadRow(threadId);
  if (thread) {
    const isPostReply = thread.status === "awaiting_client_reply";
    const phase = isPostReply ? "post_reply" : "pre_reply";
    const { steps } = getEffectiveRelanceSteps(threadId, thread.category_id, phase);
    const nextStep = steps[isPostReply ? thread.post_reply_relance_count : thread.relance_count];
    if (nextStep) {
      try {
        const connector = createEmailConnector();
        if (isPostReply) {
          await checkPostReplyThread(connector, thread, nextStep);
        } else {
          await checkPreReplyThread(connector, thread, nextStep);
        }
      } catch (err) {
        console.error(`[relance manuelle] erreur sur le dossier ${threadId}:`, err);
        recordPipelineError("relance_check", threadId, (err as Error).message);
      }
    }
  }
  res.redirect(`/dossiers/${encodeURIComponent(threadId)}?saved=1`);
});

/** Nettoyage best-effort: une messagerie non connectee ou une erreur API ne doit jamais bloquer l'action principale de la route appelante. */
async function attemptCleanup(threadId: string): Promise<void> {
  try {
    await cleanupUnusedDrafts(createEmailConnector(), threadId);
  } catch (err) {
    recordPipelineError("draft_cleanup", threadId, (err as Error).message);
  }
}

/** Journalise et redirige avec une banniere d'erreur au lieu de laisser une route synchrone planter jusqu'a la page 500 generique. */
function runOrRedirectError(res: Response, context: string, threadId: string, action: () => void): void {
  try {
    action();
  } catch (err) {
    console.error(`[${context}] erreur sur le dossier ${threadId}:`, err);
    recordPipelineError(context, threadId, (err as Error).message);
    res.redirect(`/dossiers/${encodeURIComponent(threadId)}?error=1`);
    return;
  }
  res.redirect(`/dossiers/${encodeURIComponent(threadId)}?saved=1`);
}

function phaseFromBody(body: Record<string, string>): RelancePhase {
  return body.phase === "post_reply" ? "post_reply" : "pre_reply";
}

app.post("/dossiers/:threadId/relance-steps", requireCsrf, (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  const body = req.body as Record<string, string>;
  const phase = phaseFromBody(body);
  runOrRedirectError(res, "relance_step_add", threadId, () => {
    // Le clamp doit porter sur la propre sequence du dossier (vide au premier
    // ajout), pas sur celle de la categorie de repli — sinon la premiere etape
    // d'une nouvelle surcharge se retrouve poussee au delai de la derniere
    // etape de la categorie au lieu de rester libre.
    const existing = getThreadRelanceOverride(threadId, phase);
    const parsed = parseStep(body);
    addThreadRelanceStep(threadId, { ...parsed, delayMinutes: clampAfterLastStep(existing, parsed.delayMinutes) }, phase);
  });
});

app.post("/dossiers/:threadId/relance-steps/personnaliser", requireCsrf, (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  const phase = phaseFromBody(req.body as Record<string, string>);
  runOrRedirectError(res, "relance_step_personnaliser", threadId, () => {
    const thread = getThreadRow(threadId);
    if (thread && !hasThreadRelanceOverride(threadId, phase)) {
      const { steps } = getEffectiveRelanceSteps(threadId, thread.category_id, phase);
      const base = steps.length > 0 ? steps : [{ channel: "internal" as const, delayMinutes: 1440 }];
      for (const step of base) addThreadRelanceStep(threadId, { channel: step.channel, delayMinutes: step.delayMinutes }, phase);
    }
  });
});

app.post("/dossiers/:threadId/relance-steps/reset", requireCsrf, (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  const phase = phaseFromBody(req.body as Record<string, string>);
  runOrRedirectError(res, "relance_step_reset", threadId, () => {
    clearThreadRelanceOverride(threadId, phase);
  });
});

app.post("/dossiers/:threadId/relance-steps/:order/delete", requireCsrf, (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  const phase = phaseFromBody(req.body as Record<string, string>);
  runOrRedirectError(res, "relance_step_delete", threadId, () => {
    deleteThreadRelanceStep(threadId, Number(req.params.order), phase);
  });
});

/**
 * Recuperation manuelle d'un dossier mal classifie: un vrai email client
 * marque a tort "sans suite requise" (ex: confondu avec une newsletter) n'a
 * jamais reçu d'accuse ni de brouillons. Cette route reprend le fil depuis
 * la messagerie, applique la categorie choisie par l'admin, et declenche
 * l'accuse + les 3 brouillons comme si la classification avait ete bonne
 * des le depart.
 */
app.post("/dossiers/:threadId/traiter", requireCsrf, async (req: Request, res: Response) => {
  const threadId = req.params.threadId;
  const threadRow = getThreadRow(threadId);
  const body = req.body as Record<string, string>;
  if (threadRow && body.categoryId) {
    try {
      const connector = createEmailConnector();
      const thread = await connector.getThread(threadId);
      const lastInbound = [...thread.messages].reverse().find((m) => !m.isFromUs);
      if (!lastInbound) throw new Error("Aucun message entrant trouve dans ce fil.");
      const category = getCategory(body.categoryId);
      const dueAt = new Date(Date.now() + category.slaMinutes * 60_000).toISOString();
      upsertThreadReceived({
        threadId,
        subject: threadRow.subject,
        senderEmail: lastInbound.from.email,
        senderName: lastInbound.from.name ?? null,
        categoryId: category.id,
        urgency: threadRow.urgency,
        slaMinutes: category.slaMinutes,
        status: "received",
        dueAt,
      });
      await sendAcknowledgementAndDrafts(connector, thread, lastInbound, category);
    } catch (err) {
      console.error(`[traitement manuel] erreur sur le dossier ${threadId}:`, err);
      recordPipelineError("manual_override", threadId, (err as Error).message);
    }
  }
  res.redirect(`/dossiers/${encodeURIComponent(threadId)}?saved=1`);
});

// ---------- Reglages (categories + sequences de relance) ----------

app.get("/reglages", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderReglagesPage(
      listCategories(),
      res.locals.csrfToken as string | undefined,
      query(req).saved,
      query(req).error
    )
  );
});

/** Meme filet de securite que runOrRedirectError, mais pour les routes /reglages (redirection sans threadId). */
function runOrRedirectReglagesError(res: Response, context: string, action: () => void): void {
  try {
    action();
  } catch (err) {
    console.error(`[${context}] erreur:`, err);
    recordPipelineError(context, null, (err as Error).message);
    res.redirect("/reglages?error=1");
    return;
  }
  res.redirect("/reglages?saved=1");
}

app.post("/reglages/categories", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  runOrRedirectReglagesError(res, "category_create", () => {
    const label = (body.label ?? "").trim();
    if (!label) throw new Error("Le nom de la catégorie ne peut pas être vide.");
    createCategory({
      label,
      slaMinutes: Math.max(0, parseLocaleNumber(body.slaMinutes) || 1440),
      acknowledgeAutomatically: body.acknowledgeAutomatically === "on",
    });
  });
});

app.post("/reglages/categories/:id", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const alertMode = parseAlertMode(body.alertMode);
  runOrRedirectReglagesError(res, "category_update", () => {
    updateCategory(req.params.id, {
      label: (body.label ?? "").trim() || req.params.id,
      slaMinutes: Math.max(0, parseLocaleNumber(body.slaMinutes)),
      acknowledgeAutomatically: body.acknowledgeAutomatically === "on",
      internalAlertsEnabled: alertMode.enabled,
      internalAlertsMinUrgency: alertMode.minUrgency,
    });
  });
});

app.post("/reglages/categories/:id/relance-steps", requireCsrf, (req: Request, res: Response) => {
  const categoryId = req.params.id;
  const body = req.body as Record<string, string>;
  const phase = phaseFromBody(body);
  runOrRedirectReglagesError(res, "category_relance_step_add", () => {
    const existing = getCategoryRelanceSteps(categoryId, phase);
    const parsed = parseStep(body);
    addCategoryRelanceStep(categoryId, { ...parsed, delayMinutes: clampAfterLastStep(existing, parsed.delayMinutes) }, phase);
  });
});

app.post("/reglages/categories/:id/relance-steps/:order/delete", requireCsrf, (req: Request, res: Response) => {
  const phase = phaseFromBody(req.body as Record<string, string>);
  runOrRedirectReglagesError(res, "category_relance_step_delete", () => {
    deleteCategoryRelanceStep(req.params.id, Number(req.params.order), phase);
  });
});

// ---------- Journal (audit des relances) ----------

app.get("/journal", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderJournalPage(listReminders(150), listPipelineErrors(100)));
});

// ---------- Consommation IA (tokens Claude & cout estime) ----------

/** Debut du mois calendaire courant en UTC — borne explicite et sans ambiguite, plutot que le fuseau du serveur d'hebergement (souvent different de celui de l'equipe). */
function currentMonthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

app.get("/consommation", (_req: Request, res: Response) => {
  const summary = getAiUsageSummarySince(currentMonthStartIso());
  const recent = listRecentAiUsage(50);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderConsommationPage(summary, recent));
});

// ---------- Envois sans dossier (suivi manuel) ----------

/**
 * Complement manuel a la detection automatique (discoverOutbound.ts): celle-ci
 * ignore volontairement tout ce qui a ete envoye avant le demarrage du
 * process (pour ne pas suivre des annees d'historique au premier deploiement)
 * et ne tourne qu'au rythme du polling — un envoi tres recent peut donc ne
 * pas encore apparaitre. Cette page permet de forcer le suivi immediatement.
 */
app.get("/envois", async (req: Request, res: Response) => {
  try {
    const connector = createEmailConnector();
    const sent = await connector.listRecentSentMessages(25);
    const untracked = sent.filter((m) => !getThreadRow(m.threadId));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderNewSentPage(untracked, res.locals.csrfToken as string | undefined, query(req).saved, undefined)
    );
  } catch (err) {
    recordPipelineError("web_request", null, `[Messagerie — lecture des envois] ${(err as Error).message}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderNewSentPage(
        [],
        res.locals.csrfToken as string | undefined,
        undefined,
        "Impossible de récupérer les emails envoyés — voir le Journal pour le détail."
      )
    );
  }
});

app.post("/envois/suivre", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  try {
    if (!getThreadRow(body.threadId)) {
      // deja suivi entre-temps (double-clic, etc.) sinon
      const category = getCategory(body.categoryId || "autre");
      upsertThreadReceived({
        threadId: body.threadId,
        subject: body.subject,
        senderEmail: body.recipientEmail,
        senderName: body.recipientName || null,
        categoryId: category.id,
        urgency: "normal",
        slaMinutes: category.slaMinutes,
        status: "awaiting_client_reply",
        dueAt: null,
      });
      setThreadHumanReplied(body.threadId, body.sentAt || undefined, body.hasAttachments === "1");
      if (body.messageId) markMessageProcessed(body.messageId, body.threadId);
    }
    res.redirect(`/dossiers/${encodeURIComponent(body.threadId)}?saved=1`);
  } catch (err) {
    console.error(`[suivi manuel d'un envoi] erreur sur ${body.threadId}:`, err);
    recordPipelineError("discover_outbound", body.threadId || null, (err as Error).message);
    res.redirect("/envois?error=1");
  }
});

// ---------- Ton de marque (gabarit lu par l'IA avant chaque redaction) ----------

app.get("/ton-de-marque", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderBrandVoicePage(loadBrandVoice(), res.locals.csrfToken as string | undefined, query(req).saved, query(req).error)
  );
});

app.post("/ton-de-marque", requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  try {
    saveBrandVoice(body.content ?? "");
    res.redirect("/ton-de-marque?saved=1");
  } catch (err) {
    recordPipelineError("web_request", null, `[Ton de marque] ${(err as Error).message}`);
    res.redirect("/ton-de-marque?error=1");
  }
});

// ---------- Confidentialite / retention ----------

app.get("/confidentialite", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfidentialitePage());
});

// ---------- Gabarit commun ----------

type ActivePage =
  | "connexion"
  | "dossiers"
  | "reglages"
  | "journal"
  | "envois"
  | "consommation"
  | "ton-de-marque"
  | "confidentialite";

function pageShell(active: ActivePage, title: string, sub: string, body: string, backLink?: string): string {
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
    <a href="/" class="${active === "connexion" ? "active" : ""}">Connexion</a>
    <a href="/dossiers" class="${active === "dossiers" ? "active" : ""}">Registre des dossiers</a>
    <a href="/reglages" class="${active === "reglages" ? "active" : ""}">Réglages</a>
    <a href="/journal" class="${active === "journal" ? "active" : ""}">Journal</a>
    <a href="/envois" class="${active === "envois" ? "active" : ""}">Envois</a>
    <a href="/consommation" class="${active === "consommation" ? "active" : ""}">Consommation IA</a>
    <a href="/ton-de-marque" class="${active === "ton-de-marque" ? "active" : ""}">Ton de marque</a>
    <form method="POST" action="/logout"><button class="btn-link" type="submit">Déconnexion</button></form>
  </nav>
  ${backLink ? `<a class="back-link" href="${backLink}">&larr; Retour</a>` : ""}
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${sub}</p>
  ${body}
</main>
</body>
</html>`;
}

function sharedStyles(primaryColor: string): string {
  return `
  :root {
    color-scheme: light dark;
    --brand-primary: ${primaryColor};
    --brand-primary-ink: #ffffff;
    --paper: #F6F1E7;
    --paper-raised: #FFFDF9;
    --ink: #211D17;
    --ink-soft: #6E6455;
    --ink-faint: #9C927E;
    --rule: #E2D8C3;
    --rule-strong: #CBBEA0;
    --stamp-wait: #8A5D16;
    --stamp-late: #A23B2E;
    --stamp-done: #3F6B4A;
    --stamp-skip: #8C8371;
    --stamp-internal: #3D5A73;
    --font-display: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #1A1712; --paper-raised: #242019; --ink: #EDE6D6; --ink-soft: #B0A48D; --ink-faint: #7C7361;
      --rule: #392F22; --rule-strong: #4A3E2C;
      --stamp-wait: #D2A64C; --stamp-late: #E08573; --stamp-done: #7FBE93; --stamp-skip: #A79C89; --stamp-internal: #8FB4D1;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 20px 60px; min-height: 100vh;
    background-color: var(--paper); color: var(--ink);
    background-image: radial-gradient(circle at 1px 1px, rgba(0,0,0,.035) 1px, transparent 0);
    background-size: 15px 15px;
    font-family: var(--font-body);
    display: flex; justify-content: center;
  }
  @media (prefers-color-scheme: dark) {
    body { background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,.03) 1px, transparent 0); }
  }
  main { width: 100%; max-width: 820px; }
  header.brand { display: flex; align-items: center; gap: 11px; padding: 30px 0 20px; }
  header.brand img, header.brand .seal { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }
  header.brand .seal {
    background: var(--brand-primary); color: var(--brand-primary-ink); font-family: var(--font-display);
    display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;
    transform: rotate(-4deg); box-shadow: 0 1px 2px rgba(0,0,0,.25);
  }
  header.brand .name { font-family: var(--font-display); font-weight: 700; font-size: 16.5px; letter-spacing: -.01em; }
  nav {
    display: flex; gap: 22px; margin-bottom: 30px; font-size: 12.5px; flex-wrap: wrap;
    border-bottom: 1px solid var(--rule); padding-bottom: 0;
  }
  nav a {
    color: var(--ink-soft); text-decoration: none; padding-bottom: 10px; border-bottom: 2px solid transparent;
    text-transform: uppercase; letter-spacing: .06em; font-weight: 600;
  }
  nav a.active { color: var(--ink); border-color: var(--brand-primary); }
  nav a:hover { color: var(--ink); }
  nav form { margin-left: auto; }
  nav .btn-link {
    background: none; border: none; color: var(--ink-soft); font-size: 12.5px; cursor: pointer; padding: 0 0 10px;
    text-transform: uppercase; letter-spacing: .06em; font-weight: 600; font-family: inherit;
  }
  nav .btn-link:hover { color: var(--ink); }
  .back-link {
    display: inline-block; font-size: 12.5px; color: var(--ink-soft); text-decoration: none; margin-bottom: 14px;
  }
  .back-link:hover { color: var(--ink); text-decoration: underline; }
  h1 { font-family: var(--font-display); font-size: 25px; margin: 0 0 6px; font-weight: 700; }
  p.sub { color: var(--ink-soft); margin: 0 0 28px; font-size: 14px; max-width: 62ch; line-height: 1.5; }
  .banner { padding: 12px 16px; border-radius: 3px; font-size: 13.5px; margin-bottom: 20px; border-left: 3px solid; }
  .banner-ok { background: rgba(63,107,74,.1); color: var(--stamp-done); border-color: var(--stamp-done); }
  .banner-error { background: rgba(162,59,46,.1); color: var(--stamp-late); border-color: var(--stamp-late); }
  .banner-info { background: rgba(61,90,115,.1); color: var(--stamp-internal); border-color: var(--stamp-internal); }
  .status {
    border: 1px solid var(--rule); border-radius: 4px; padding: 16px 20px;
    margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center;
    background: var(--paper-raised); flex-wrap: wrap; gap: 12px;
  }
  .status .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); margin-bottom: 4px; }
  .status .value { font-size: 15px; font-weight: 600; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 26px; }
  .metric { border: 1px solid var(--rule); border-radius: 4px; padding: 14px 16px; background: var(--paper-raised); }
  .metric .metric-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); margin-bottom: 6px; }
  .metric .metric-value { font-family: var(--font-display); font-size: 21px; font-weight: 700; }
  .metric .metric-sub { font-size: 11.5px; color: var(--ink-soft); margin-top: 3px; }
  .metric.metric-warn .metric-value { color: var(--stamp-late); }
  .cards { display: grid; gap: 14px; }
  .card {
    border: 1px solid var(--rule); border-radius: 4px; padding: 20px;
    background: var(--paper-raised); display: flex; justify-content: space-between; align-items: center; gap: 16px;
  }
  .card h2 { font-family: var(--font-display); font-size: 16.5px; margin: 0 0 4px; }
  .card p { font-size: 13.5px; color: var(--ink-soft); margin: 0; line-height: 1.5; }
  .btn {
    display: inline-block; padding: 9px 16px; border-radius: 3px; text-decoration: none;
    font-size: 13.5px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; cursor: pointer;
    font-family: var(--font-body);
  }
  .btn-sm { padding: 6px 11px; font-size: 12px; }
  .btn-primary { background: var(--brand-primary); color: var(--brand-primary-ink); }
  .btn-secondary { background: transparent; color: var(--ink); border-color: var(--rule-strong); }
  .btn-secondary:hover { border-color: var(--ink-soft); }
  .btn-ghost { background: transparent; color: var(--stamp-late); border-color: var(--stamp-late); opacity: .85; }
  .btn-ghost:hover { opacity: 1; }
  .btn-disabled { background: var(--rule); color: var(--ink-faint); pointer-events: none; border-color: var(--rule); }
  .stamp {
    display: inline-block; font-size: 10.5px; padding: 2px 8px; border-radius: 3px; margin-left: 8px;
    text-transform: uppercase; letter-spacing: .05em; font-weight: 700; border: 1px solid currentColor;
    white-space: nowrap; line-height: 1.6;
  }
  .stamp-wait { color: var(--stamp-wait); }
  .stamp-late { color: var(--stamp-late); }
  .stamp-done { color: var(--stamp-done); }
  .stamp-skip { color: var(--stamp-skip); }
  .stamp-internal { color: var(--stamp-internal); }
  .stamp-external { color: var(--brand-primary); }
  .ledger { border: 1px solid var(--rule); border-radius: 4px; background: var(--paper-raised); overflow: hidden; }
  .ledger-head {
    display: flex; gap: 16px; padding: 10px 18px; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--ink-faint); border-bottom: 1px solid var(--rule);
  }
  .ledger-row { display: flex; gap: 16px; padding: 15px 18px; border-bottom: 1px solid var(--rule); flex-wrap: wrap; align-items: flex-start; }
  .ledger-row:last-child { border-bottom: none; }
  .ledger-main { flex: 1 1 240px; min-width: 0; }
  .ledger-main a.subject-link { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--ink); text-decoration: none; }
  .ledger-main a.subject-link:hover { text-decoration: underline; }
  .ledger-main .subject-static { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
  .ledger-meta { color: var(--ink-soft); font-size: 12px; margin-top: 3px; }
  .ledger-facts { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; font-size: 12px; }
  .ledger-fact .fact-label { text-transform: uppercase; font-size: 9.5px; letter-spacing: .06em; color: var(--ink-faint); display: block; margin-bottom: 2px; }
  .ledger-fact .fact-value { font-family: var(--font-mono); font-size: 12px; color: var(--ink); }
  .ledger-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; align-items: flex-start; }
  .empty { padding: 48px 20px; text-align: center; color: var(--ink-faint); font-size: 14px; font-family: var(--font-display); }
  footer { margin-top: 28px; font-size: 12px; color: var(--ink-faint); }
  .settings-section { margin-bottom: 34px; }
  .settings-section h2 { font-family: var(--font-display); font-size: 16.5px; margin: 0 0 4px; }
  .settings-section .section-hint { font-size: 12.5px; color: var(--ink-soft); margin: 0 0 14px; }
  .category-block { border: 1px solid var(--rule); border-radius: 4px; background: var(--paper-raised); margin-bottom: 14px; overflow: hidden; }
  .category-head-form {
    display: grid; grid-template-columns: 1.8fr .8fr 1fr 1.5fr auto; gap: 12px; align-items: center;
    padding: 14px 16px; border-bottom: 1px solid var(--rule);
  }
  .category-head-form select { width: 100%; padding: 7px 9px; border-radius: 3px; border: 1px solid var(--rule-strong); background: var(--paper-raised); color: var(--ink); font-family: inherit; font-size: 12.5px; }
  .field-label { display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-faint); margin-bottom: 3px; }
  .field-hint { display: block; font-size: 10.5px; color: var(--ink-faint); margin-top: 3px; font-family: var(--font-mono); }
  details.advanced-steps { margin-top: 2px; }
  details.advanced-steps > summary { cursor: pointer; padding: 10px 16px; font-size: 12px; color: var(--ink-soft); user-select: none; }
  details.advanced-steps > summary:hover { color: var(--ink); }
  details.advanced-steps[open] > summary { border-bottom: 1px solid var(--rule); }
  .new-category-form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 16px; border: 1px dashed var(--rule-strong); border-radius: 4px; margin-top: 4px; }
  .new-category-form input[type=text] { flex: 1 1 220px; padding: 7px 9px; border-radius: 3px; border: 1px solid var(--rule-strong); background: var(--paper-raised); color: var(--ink); }
  .new-category-form input[type=number] { width: 80px; padding: 7px 9px; border-radius: 3px; border: 1px solid var(--rule-strong); background: var(--paper-raised); color: var(--ink); }
  .new-category-form .checkbox-cell { font-size: 12.5px; color: var(--ink-soft); }
  .brand-voice-editor { width: 100%; padding: 14px; border-radius: 4px; border: 1px solid var(--rule-strong); background: var(--paper-raised); color: var(--ink); font-family: var(--font-mono); font-size: 13px; line-height: 1.6; resize: vertical; }
  .live-toggle { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-soft); margin-bottom: 18px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-faint); }
  .live-dot.live-dot-on { background: var(--stamp-done); box-shadow: 0 0 0 0 var(--stamp-done); animation: live-pulse 1.6s infinite; }
  @keyframes live-pulse { 0% { box-shadow: 0 0 0 0 rgba(63,107,74,.5); } 70% { box-shadow: 0 0 0 6px rgba(63,107,74,0); } 100% { box-shadow: 0 0 0 0 rgba(63,107,74,0); } }
  .filter-tabs { display: flex; gap: 6px; margin-bottom: 18px; flex-wrap: wrap; }
  .filter-tabs a { padding: 6px 13px; border-radius: 999px; border: 1px solid var(--rule-strong); font-size: 12.5px; color: var(--ink-soft); text-decoration: none; }
  .filter-tabs a:hover { border-color: var(--ink-soft); color: var(--ink); }
  .filter-tabs a.active { background: var(--brand-primary); color: var(--brand-primary-ink); border-color: var(--brand-primary); }
  .category-head-form input[type=text], .category-head-form input[type=number] {
    width: 100%; padding: 7px 9px; border-radius: 3px; border: 1px solid var(--rule-strong);
    background: var(--paper); color: inherit; font-size: 13.5px; font-family: inherit;
  }
  .category-head-form .cat-id { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-faint); display: block; margin-top: 3px; }
  .checkbox-cell { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .steps-panel { padding: 14px 16px; }
  .steps-panel .steps-title { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); margin-bottom: 10px; }
  .step-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .step-item {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--rule);
    border-radius: 3px; background: var(--paper); font-size: 13px; flex-wrap: wrap;
  }
  .step-item .step-order { font-family: var(--font-mono); color: var(--ink-faint); font-size: 12px; width: 18px; }
  .step-item .step-delay { font-family: var(--font-mono); font-weight: 600; min-width: 52px; }
  .step-item .step-raw { color: var(--ink-faint); font-size: 11px; }
  .step-item .step-absolute { color: var(--ink-soft); font-size: 12px; font-family: var(--font-mono); }
  .step-item form { margin-left: auto; }
  .step-add-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .step-add-form select, .step-add-form input[type=number] {
    padding: 7px 9px; border-radius: 3px; border: 1px solid var(--rule-strong); background: var(--paper);
    color: inherit; font-size: 13px; font-family: inherit;
  }
  .step-add-form input[type=number] { width: 90px; }
  .step-empty { font-size: 12.5px; color: var(--ink-faint); font-style: italic; margin-bottom: 12px; }
  .detail-header { border: 1px solid var(--rule); border-radius: 4px; background: var(--paper-raised); padding: 20px 22px; margin-bottom: 24px; }
  .detail-header .subject-static { font-family: var(--font-display); font-size: 19px; font-weight: 700; margin-bottom: 4px; }
  .detail-header .ledger-meta { margin-bottom: 14px; }
  .detail-facts { display: flex; gap: 26px; flex-wrap: wrap; margin-bottom: 16px; }
  .detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .override-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding: 10px 14px; border-radius: 3px; margin-bottom: 14px; font-size: 12.5px; }
  .override-banner.is-custom { background: rgba(61,90,115,.1); color: var(--stamp-internal); }
  .override-banner.is-default { background: var(--rule); color: var(--ink-soft); }
  .field-group { display: grid; gap: 4px; }
  .login-wrap { max-width: 360px; margin: 60px auto 0; }
  .login-wrap form { display: grid; gap: 14px; }
  .login-wrap input {
    width: 100%; padding: 10px 12px; border-radius: 3px; border: 1px solid var(--rule-strong);
    background: var(--paper-raised); color: inherit; font-size: 14px; font-family: inherit;
  }
  .login-wrap label { font-size: 13px; font-weight: 600; }
  @media (max-width: 640px) {
    .category-head-form { grid-template-columns: 1fr; }
    .ledger-actions { margin-left: 0; }
  }`;
}

function csrfField(csrfToken: string | undefined): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken ?? "")}" />`;
}

function phaseField(phase: RelancePhase): string {
  return `<input type="hidden" name="phase" value="${phase}" />`;
}

function formatDelay(minutes: number): string {
  if (minutes === 0) return "immédiat";
  if (minutes < 60) return `+${trimNumber(minutes)}min`;
  if (minutes < 1440) return `+${trimNumber(minutes / 60)}h`;
  return `J+${trimNumber(minutes / 1440)}`;
}

/**
 * Toutes les dates affichees dans l'admin doivent passer par ici. Sans le
 * timeZone explicite, toLocaleString() rend dans le fuseau du PROCESSUS
 * serveur (souvent UTC sur un hebergement PaaS), pas celui de l'equipe —
 * decalage silencieux d'1h+ observe en production (config.timezone, par
 * defaut Africa/Casablanca).
 */
function formatDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("fr-FR", { timeZone: config.timezone });
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * "internal"/"external" restent les valeurs techniques stockees en base (ne
 * pas renommer sans migration), mais l'equipe trouvait "Rappel interne" /
 * "Relance externe" opaques — le libelle affiche dit maintenant directement
 * QUI reçoit le message: l'equipe, ou le client.
 */
function channelLabel(channel: RelanceChannel): string {
  return channel === "external" ? "Relancer le client" : "Notifier l'équipe";
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
  ${sharedStyles(brand.primaryColor)}
  body { align-items: center; padding: 20px; }
  .login-card {
    width: 100%; max-width: 380px; border: 1px solid var(--rule); border-radius: 4px;
    background: var(--paper-raised); padding: 34px 32px; box-shadow: 0 2px 14px rgba(0,0,0,.06);
  }
  .brand-row { display: flex; align-items: center; gap: 11px; margin-bottom: 26px; }
  .seal {
    width: 34px; height: 34px; border-radius: 50%; background: var(--brand-primary); color: #fff;
    display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;
    font-family: var(--font-display); transform: rotate(-4deg); box-shadow: 0 1px 2px rgba(0,0,0,.25);
  }
  .brand-row strong { font-family: var(--font-display); font-size: 16px; }
  .login-card h1 { font-size: 19px; margin: 0 0 20px; }
  .login-card form { display: grid; gap: 14px; }
  .login-card label { font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); }
  .login-card input {
    width: 100%; padding: 10px 12px; border-radius: 3px; border: 1px solid var(--rule-strong);
    background: var(--paper); color: inherit; font-size: 14px; margin-top: 6px; font-family: inherit;
  }
  .login-card button {
    padding: 11px 18px; border-radius: 3px; border: none; background: var(--brand-primary); color: var(--brand-primary-ink);
    font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
</style>
</head>
<body>
  <div class="login-card">
    <div class="brand-row">
      <span class="seal">${escapeHtml(brand.name.trim().charAt(0).toUpperCase() || "A")}</span>
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
  const since = formatDateTime(state.connectedAt);
  return `<div class="status">
    <div>
      <div class="label">Statut</div>
      <div class="value">${escapeHtml(state.email)} <span class="stamp stamp-done">${providerLabel}</span></div>
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
      <h2>${escapeHtml(opts.title)}${isActive ? '<span class="stamp stamp-done">Active</span>' : ""}</h2>
      <p>${escapeHtml(opts.description)}</p>
    </div>
    ${button}
  </div>`;
}

// ---------- Registre des dossiers ----------

const DOSSIER_FILTER_LABELS: Record<DossierFilter, string> = {
  a_traiter: "À traiter",
  en_retard: "En retard",
  resolus: "Résolus",
  tous: "Tous",
};

function matchesDossierFilter(row: ThreadRow, filter: DossierFilter): boolean {
  const isResolved = ["responded", "closed", "skipped"].includes(row.status);
  switch (filter) {
    case "tous":
      return true;
    case "resolus":
      return isResolved;
    case "en_retard":
      return statusStamp(row).label.includes("en retard");
    case "a_traiter":
    default:
      return !isResolved;
  }
}

function renderDossiersPage(
  threads: ThreadRow[],
  csrfToken: string | undefined,
  usageSummary: AiUsageSummary,
  filter: DossierFilter
): string {
  const categoryLabels = new Map(listCategories().map((c) => [c.id, c.label]));

  // Les compteurs et le filtre "En retard" portent toujours sur l'ensemble des
  // dossiers charges (pas seulement ceux affiches), pour que le tableau de
  // bord reste une vue fiable de la situation reelle meme quand on regarde
  // un sous-ensemble filtre.
  const overdueCount = threads.filter((t) => statusStamp(t).label.includes("en retard")).length;
  const awaitingClientCount = threads.filter((t) => t.status === "awaiting_client_reply").length;
  const openCount = threads.filter((t) => !["responded", "closed", "skipped"].includes(t.status)).length;
  const costThisMonth = estimateCostUsd(usageSummary.total.inputTokens, usageSummary.total.outputTokens);

  const summary = `<div class="metric-grid">
    <div class="metric"><div class="metric-label">Dossiers en cours</div><div class="metric-value">${openCount}</div></div>
    <div class="metric ${overdueCount > 0 ? "metric-warn" : ""}"><div class="metric-label">En retard</div><div class="metric-value">${overdueCount}</div></div>
    <div class="metric"><div class="metric-label">En attente du client</div><div class="metric-value">${awaitingClientCount}</div></div>
    <div class="metric"><div class="metric-label">Coût IA ce mois-ci</div><div class="metric-value">${formatUsd(costThisMonth)}</div><div class="metric-sub"><a href="/consommation">Détail →</a></div></div>
  </div>`;

  const filterTabs = `<div class="filter-tabs">
    ${(Object.keys(DOSSIER_FILTER_LABELS) as DossierFilter[])
      .map(
        (f) =>
          `<a href="/dossiers?filtre=${f}" class="${f === filter ? "active" : ""}">${escapeHtml(DOSSIER_FILTER_LABELS[f])}</a>`
      )
      .join("")}
  </div>`;

  const visibleThreads = threads.filter((t) => matchesDossierFilter(t, filter));
  const rows = visibleThreads.map((row) => renderThreadRow(row, csrfToken, categoryLabels)).join("");
  const list = visibleThreads.length
    ? `<div class="ledger">
        <div class="ledger-head"><span>Dossier</span></div>
        ${rows}
      </div>`
    : `<div class="ledger"><div class="empty">${
        filter === "tous"
          ? "Aucun dossier pour le moment — ils apparaissent ici dès qu'un email entrant est traité."
          : "Rien à afficher dans ce filtre."
      }</div></div>`;

  const retentionBanner = `<div class="banner banner-info">Les données des dossiers (sujet, expéditeur, dates, nombre de relances) sont conservées indéfiniment tant qu'elles ne sont pas supprimées manuellement. Voir la <a href="/confidentialite">page confidentialité &amp; rétention</a>.</div>`;

  return pageShell(
    "dossiers",
    "Registre des dossiers",
    "Détection automatique de réponse à partir du fil email connecté. Ouvrez un dossier pour consulter ou personnaliser sa séquence de relance.",
    summary + filterTabs + retentionBanner + list
  );
}

const STATUS_LABELS: Record<string, { label: string; stampClass: string }> = {
  received: { label: "Reçu", stampClass: "stamp-wait" },
  skipped: { label: "Sans suite requise", stampClass: "stamp-skip" },
  ack_sent: { label: "Accusé envoyé", stampClass: "stamp-wait" },
  drafts_ready: { label: "Brouillons prêts", stampClass: "stamp-wait" },
  responded: { label: "Répondu", stampClass: "stamp-done" },
  relance_sent: { label: "Relancé", stampClass: "stamp-late" },
  awaiting_client_reply: { label: "En attente du client", stampClass: "stamp-internal" },
  closed: { label: "Clôturé", stampClass: "stamp-done" },
};

const URGENCY_LABELS: Record<string, { label: string; stampClass: string; hint: string }> = {
  high: {
    label: "Urgence haute",
    stampClass: "stamp-late",
    hint: "Le client semble pressé, mécontent ou attend une décision rapide — à traiter en priorité.",
  },
  normal: {
    label: "Urgence normale",
    stampClass: "stamp-wait",
    hint: "Demande standard, sans signal d'urgence particulier — traiter dans le délai SLA habituel.",
  },
  low: {
    label: "Urgence basse",
    stampClass: "stamp-skip",
    hint: "Demande informative ou sans échéance — peut attendre sans risque.",
  },
};

function urgencyStamp(urgency: string): { label: string; stampClass: string; hint: string } {
  return URGENCY_LABELS[urgency] ?? { label: urgency, stampClass: "stamp-skip", hint: "" };
}

function statusStamp(row: ThreadRow): { label: string; stampClass: string } {
  const info = STATUS_LABELS[row.status] ?? { label: row.status, stampClass: "stamp-skip" };
  // "Échéance" (due_at) est l'ancrage du cycle pre_reply — non pertinent une
  // fois qu'on est passe en attente de la reponse du client (son propre
  // ancrage est human_replied_at), donc jamais marque "en retard" ici.
  const isOverdue =
    row.due_at !== null &&
    new Date(row.due_at).getTime() < Date.now() &&
    !["responded", "closed", "skipped", "awaiting_client_reply"].includes(row.status);
  return isOverdue ? { label: `${info.label} (en retard)`, stampClass: "stamp-late" } : info;
}

function renderThreadRow(
  row: ThreadRow,
  csrfToken: string | undefined,
  categoryLabels: Map<string, string>
): string {
  const stamp = statusStamp(row);
  const dueLabel = row.due_at ? formatDateTime(row.due_at) : "—";
  const canClose = !["responded", "closed", "skipped"].includes(row.status);
  const categoryLabel = categoryLabels.get(row.category_id) ?? row.category_id;
  const detailHref = `/dossiers/${encodeURIComponent(row.thread_id)}`;

  return `<div class="ledger-row">
    <div class="ledger-main">
      <a class="subject-link" href="${detailHref}">${escapeHtml(row.subject)}</a>
      <div class="ledger-meta">${escapeHtml(row.sender_name ? `${row.sender_name} — ` : "")}${escapeHtml(row.sender_email)}</div>
    </div>
    <div class="ledger-facts">
      <div class="ledger-fact"><span class="fact-label">Catégorie</span><span class="fact-value">${escapeHtml(categoryLabel)}</span></div>
      <div class="ledger-fact"><span class="fact-label">Statut</span><span class="stamp ${stamp.stampClass}">${escapeHtml(stamp.label)}</span></div>
      <div class="ledger-fact"><span class="fact-label">Urgence</span><span class="stamp ${urgencyStamp(row.urgency).stampClass}" title="${escapeHtml(urgencyStamp(row.urgency).hint)}">${escapeHtml(urgencyStamp(row.urgency).label)}</span></div>
      <div class="ledger-fact"><span class="fact-label">Échéance</span><span class="fact-value">${escapeHtml(dueLabel)}</span></div>
      <div class="ledger-fact"><span class="fact-label">Relances</span><span class="fact-value">${row.relance_count}</span></div>
    </div>
    <div class="ledger-actions">
      ${
        canClose
          ? `<form method="POST" action="/dossiers/${encodeURIComponent(row.thread_id)}/cloturer">
               ${csrfField(csrfToken)}
               <button class="btn btn-secondary btn-sm" type="submit">Marquer répondu</button>
             </form>`
          : ""
      }
      <a class="btn btn-secondary btn-sm" href="${detailHref}">Ouvrir</a>
    </div>
  </div>`;
}

// ---------- Detail d'un dossier ----------

function renderDossierDetailPage(
  thread: ThreadRow,
  csrfToken: string | undefined,
  saved: string | undefined,
  error: string | undefined
): string {
  const categoryLabels = new Map(listCategories().map((c) => [c.id, c.label]));
  const categoryLabel = categoryLabels.get(thread.category_id) ?? thread.category_id;
  const stamp = statusStamp(thread);
  const canClose = !["responded", "closed", "skipped"].includes(thread.status);
  const banner = error
    ? `<div class="banner banner-error">L'action a échoué — l'erreur a été journalisée, voir la page <a href="/journal">Journal</a>.</div>`
    : saved
      ? `<div class="banner banner-ok">Modifications enregistrées — aucun redéploiement nécessaire.</div>`
      : "";

  const isPostReply = thread.status === "awaiting_client_reply";
  const phase: RelancePhase = isPostReply ? "post_reply" : "pre_reply";
  const { steps, isCustom } = getEffectiveRelanceSteps(thread.thread_id, thread.category_id, phase);
  const draftCount = listDraftsForThread(thread.thread_id).length;
  const nextStep = steps[isPostReply ? thread.post_reply_relance_count : thread.relance_count];
  const anchorAt = isPostReply ? thread.human_replied_at : thread.due_at;
  const canTriggerNow =
    anchorAt !== null &&
    ["ack_sent", "drafts_ready", "relance_sent", "awaiting_client_reply"].includes(thread.status) &&
    Boolean(nextStep);
  // L'echeance (due_at) est l'ancrage fixe du cycle pre_reply (reception +
  // SLA de la categorie) — elle ne bouge pas apres une relance, par design.
  // Une fois passe en attente du client, l'ancrage devient human_replied_at
  // (date de notre reponse de fond). Dans les deux cas, ce qui bouge
  // reellement c'est la prochaine action prevue (ancrage + delai de l'etape
  // a venir), affichee separement pour eviter la confusion
  // "l'echeance est passee mais rien ne s'est passe".
  const nextActionAt =
    anchorAt && nextStep ? new Date(new Date(anchorAt).getTime() + nextStep.delayMinutes * 60_000) : null;
  const triggerLabel = nextStep?.channel === "external" ? "Relancer le client maintenant" : "Notifier l'équipe maintenant";

  const header = `
    <div class="detail-header">
      <div class="subject-static">${escapeHtml(thread.subject)}</div>
      <div class="ledger-meta">${escapeHtml(thread.sender_name ? `${thread.sender_name} — ` : "")}${escapeHtml(thread.sender_email)}</div>
      <div class="detail-facts">
        <div class="ledger-fact"><span class="fact-label">Catégorie</span><span class="fact-value">${escapeHtml(categoryLabel)}</span></div>
        <div class="ledger-fact"><span class="fact-label">Statut</span><span class="stamp ${stamp.stampClass}">${escapeHtml(stamp.label)}</span></div>
        <div class="ledger-fact"><span class="fact-label">Urgence</span><span class="stamp ${urgencyStamp(thread.urgency).stampClass}" title="${escapeHtml(urgencyStamp(thread.urgency).hint)}">${escapeHtml(urgencyStamp(thread.urgency).label)}</span></div>
        <div class="ledger-fact"><span class="fact-label">Reçu le</span><span class="fact-value">${escapeHtml(formatDateTime(thread.received_at))}</span></div>
        <div class="ledger-fact"><span class="fact-label">Accusé le</span><span class="fact-value">${thread.ack_sent_at ? escapeHtml(formatDateTime(thread.ack_sent_at)) : "—"}</span></div>
        <div class="ledger-fact"><span class="fact-label">Échéance (SLA initial)</span><span class="fact-value">${thread.due_at ? escapeHtml(formatDateTime(thread.due_at)) : "—"}</span></div>
        <div class="ledger-fact"><span class="fact-label">Répondu par nous le</span><span class="fact-value">${thread.human_replied_at ? escapeHtml(formatDateTime(thread.human_replied_at)) : "—"}</span></div>
        <div class="ledger-fact"><span class="fact-label">Prochaine action prévue</span><span class="fact-value">${
          nextActionAt
            ? `${escapeHtml(formatDateTime(nextActionAt))} — ${escapeHtml(channelLabel(nextStep!.channel))}`
            : "—"
        }</span></div>
        <div class="ledger-fact"><span class="fact-label">Relances (avant réponse)</span><span class="fact-value">${thread.relance_count}</span></div>
        ${
          thread.human_replied_at
            ? `<div class="ledger-fact"><span class="fact-label">Relances (après réponse)</span><span class="fact-value">${thread.post_reply_relance_count}</span></div>`
            : ""
        }
        <div class="ledger-fact"><span class="fact-label">Brouillons déposés</span><span class="fact-value">${draftCount}</span></div>
      </div>
      <div class="detail-actions">
        ${
          canTriggerNow
            ? `<form method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/relancer-maintenant"
                     onsubmit="return confirm('Declencher l\\'etape ${nextStep!.order} (${escapeHtml(channelLabel(nextStep!.channel))}) maintenant, sans attendre l\\'echeance ?');">
                 ${csrfField(csrfToken)}
                 <button class="btn btn-primary btn-sm" type="submit">${escapeHtml(triggerLabel)}</button>
               </form>`
            : ""
        }
        ${
          canClose
            ? `<form method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/cloturer">
                 <input type="hidden" name="_redirect" value="detail" />
                 ${csrfField(csrfToken)}
                 <button class="btn btn-secondary btn-sm" type="submit">Marquer répondu</button>
               </form>`
            : ""
        }
        ${
          draftCount > 0
            ? `<form method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/nettoyer-brouillons"
                     onsubmit="return confirm('Supprimer les ${draftCount} brouillon(s) restants de la messagerie ?');">
                 ${csrfField(csrfToken)}
                 <button class="btn btn-secondary btn-sm" type="submit">Nettoyer les brouillons</button>
               </form>`
            : ""
        }
        <form method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/supprimer"
              onsubmit="return confirm('Supprimer definitivement les donnees de ce dossier ?');">
          ${csrfField(csrfToken)}
          <button class="btn btn-ghost btn-sm" type="submit">Supprimer les données</button>
        </form>
      </div>
    </div>`;

  const overrideBanner = isCustom
    ? `<div class="override-banner is-custom">
        <span>Ce dossier utilise une séquence de relance personnalisée, distincte de la catégorie "${escapeHtml(categoryLabel)}".</span>
        <form method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/relance-steps/reset">
          ${csrfField(csrfToken)}
          ${phaseField(phase)}
          <button class="btn btn-secondary btn-sm" type="submit">Revenir à la règle de la catégorie</button>
        </form>
      </div>`
    : `<div class="override-banner is-default">
        <span>Ce dossier suit la séquence de relance par défaut de la catégorie "${escapeHtml(categoryLabel)}".</span>
        <form method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/relance-steps/personnaliser">
          ${csrfField(csrfToken)}
          ${phaseField(phase)}
          <button class="btn btn-secondary btn-sm" type="submit">Personnaliser pour ce dossier</button>
        </form>
      </div>`;

  const stepsList = renderStepList({
    steps,
    editable: isCustom,
    deleteAction: (order) => `/dossiers/${encodeURIComponent(thread.thread_id)}/relance-steps/${order}/delete`,
    csrfToken,
    executedCount: isPostReply ? thread.post_reply_relance_count : thread.relance_count,
    phase,
    anchorAt,
  });

  const addForm = isCustom
    ? `<form class="step-add-form" method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/relance-steps">
        ${csrfField(csrfToken)}
        ${phaseField(phase)}
        ${stepTypeSelect()}
        <input type="number" name="delayMinutes" min="0" step="1" value="60" placeholder="Délai (min)" required />
        <button class="btn btn-secondary btn-sm" type="submit">Ajouter une étape</button>
      </form>`
    : "";

  const stepsSection = `
    <div class="settings-section">
      <h2>${isPostReply ? "Séquence de relance (après notre réponse)" : "Séquence de relance (avant notre réponse)"}</h2>
      <p class="section-hint">${
        isPostReply
          ? "Un humain a envoyé une réponse de fond (ex: le devis) — ces étapes relancent le CLIENT s'il reste silencieux, à partir de la date de cette réponse."
          : "Personne n'a encore répondu de fond au client — ces étapes nudgent notre équipe, à partir de l'échéance SLA. Elles s'arrêtent dès qu'un humain répond."
      }</p>
      ${overrideBanner}
      ${stepsList}
      ${addForm}
    </div>`;

  const misclassifiedSection =
    thread.status === "skipped"
      ? `<div class="settings-section">
          <div class="banner banner-error" style="margin-bottom: 14px;">
            Classé « sans suite requise » — aucun accusé n'a été envoyé. Si c'est une erreur
            (un vrai message classé par erreur en newsletter/spam/interne), choisissez la bonne
            catégorie ci-dessous pour envoyer l'accusé et générer les 3 brouillons maintenant.
          </div>
          <form class="step-add-form" method="POST" action="/dossiers/${encodeURIComponent(thread.thread_id)}/traiter">
            ${csrfField(csrfToken)}
            <select name="categoryId">
              ${listCategories()
                .map(
                  (c) =>
                    `<option value="${escapeHtml(c.id)}" ${c.id === thread.category_id ? "selected" : ""}>${escapeHtml(c.label)}</option>`
                )
                .join("")}
            </select>
            <button class="btn btn-primary btn-sm" type="submit">Traiter ce dossier</button>
          </form>
        </div>`
      : "";

  return pageShell(
    "dossiers",
    "Dossier",
    "Détail du dossier, statut de traitement, et séquence de relance appliquée.",
    banner + header + misclassifiedSection + stepsSection,
    "/dossiers"
  );
}

function stepTypeSelect(): string {
  return `<select name="channel">
    <option value="internal">Notifier l'équipe</option>
    <option value="external">Relancer le client</option>
  </select>`;
}

function renderStepList(opts: {
  steps: RelanceStep[];
  editable: boolean;
  deleteAction: (order: number) => string;
  csrfToken: string | undefined;
  executedCount: number;
  phase: RelancePhase;
  /**
   * Date de depart reelle du decompte (echeance SLA pour pre_reply, date de
   * notre reponse pour post_reply). Fournie uniquement depuis la page d'un
   * dossier precis (une categorie n'a pas d'ancrage concret). Sans cette
   * date affichee en clair, "+2min" se lit comme "dans 2 minutes" alors que
   * c'est en realite 2 minutes apres l'echeance — qui peut elle-meme etre a
   * 24h. Affichee ici pour qu'aucune etape ne semble "ne jamais se
   * declencher" sans explication.
   */
  anchorAt?: string | null;
}): string {
  if (opts.steps.length === 0) {
    return `<div class="step-empty">Aucune étape configurée — ce dossier ne sera jamais relancé automatiquement.</div>`;
  }
  const items = opts.steps
    .map((step) => {
      const done = step.order <= opts.executedCount;
      const stampClass = step.channel === "external" ? "stamp-external" : "stamp-internal";
      const absoluteAt = opts.anchorAt
        ? formatDateTime(new Date(new Date(opts.anchorAt).getTime() + step.delayMinutes * 60_000))
        : null;
      const deleteForm = opts.editable
        ? `<form method="POST" action="${opts.deleteAction(step.order)}" onsubmit="return confirm('Supprimer cette étape ?');">
            ${csrfField(opts.csrfToken)}
            ${phaseField(opts.phase)}
            <button class="btn btn-ghost btn-sm" type="submit">Supprimer</button>
          </form>`
        : "";
      return `<div class="step-item">
        <span class="step-order">${step.order}.</span>
        <span class="step-delay">${escapeHtml(formatDelay(step.delayMinutes))}</span>
        <span class="step-raw">(${step.delayMinutes} min)</span>
        ${absoluteAt ? `<span class="step-absolute">→ ${escapeHtml(absoluteAt)}</span>` : ""}
        <span class="stamp ${stampClass}">${escapeHtml(channelLabel(step.channel))}</span>
        ${done ? `<span class="stamp stamp-done">Effectuée</span>` : ""}
        ${deleteForm}
      </div>`;
    })
    .join("");
  return `<div class="step-list">${items}</div>`;
}

function renderCategoryStepsPanel(
  categoryId: string,
  phase: RelancePhase,
  title: string,
  csrfToken: string | undefined
): string {
  const steps = getCategoryRelanceSteps(categoryId, phase);
  const stepsList = renderStepList({
    steps,
    editable: true,
    deleteAction: (order) =>
      `/reglages/categories/${encodeURIComponent(categoryId)}/relance-steps/${order}/delete`,
    csrfToken,
    executedCount: -1,
    phase,
  });
  return `<div class="steps-panel">
    <div class="steps-title">${escapeHtml(title)}</div>
    ${stepsList}
    <form class="step-add-form" method="POST" action="/reglages/categories/${encodeURIComponent(categoryId)}/relance-steps">
      ${csrfField(csrfToken)}
      ${phaseField(phase)}
      ${stepTypeSelect()}
      <input type="number" name="delayMinutes" min="0" step="1" placeholder="Délai (min)" required />
      <button class="btn btn-secondary btn-sm" type="submit">Ajouter une étape</button>
    </form>
  </div>`;
}

// ---------- Reglages ----------

function renderReglagesPage(
  categories: CategoryConfig[],
  csrfToken: string | undefined,
  saved: string | undefined,
  error: string | undefined
): string {
  const banner = error
    ? `<div class="banner banner-error">L'action a échoué — l'erreur a été journalisée, voir la page <a href="/journal">Journal</a>.</div>`
    : saved
      ? `<div class="banner banner-ok">Modifications enregistrées — aucun redéploiement nécessaire.</div>`
      : "";

  const alertModeLabels: Record<keyof typeof ALERT_MODES, string> = {
    never: "Jamais",
    high: "Urgence haute uniquement",
    normal: "Urgence normale et plus",
    always: "Toujours",
  };

  const categoryBlocks = categories
    .map((cat) => {
      const currentMode = alertModeOf(cat);
      return `<div class="category-block">
        <form class="category-head-form" method="POST" action="/reglages/categories/${encodeURIComponent(cat.id)}">
          ${csrfField(csrfToken)}
          <div>
            <span class="field-label">Catégorie</span>
            <input type="text" name="label" value="${escapeHtml(cat.label)}" />
            <span class="cat-id">${escapeHtml(cat.id)}</span>
          </div>
          <div>
            <span class="field-label">SLA (min)</span>
            <input type="number" name="slaMinutes" value="${cat.slaMinutes}" min="0" step="1" title="Délai que l'accusé de réception promet au client, en minutes (ex: 1440 = « réponse sous 24h »). C'est aussi le point de départ des rappels et relances automatiques ci-dessous." />
            <span class="field-hint">${escapeHtml(formatDelay(cat.slaMinutes))}</span>
          </div>
          <div class="checkbox-cell">
            <input type="checkbox" id="ack-${escapeHtml(cat.id)}" name="acknowledgeAutomatically" ${cat.acknowledgeAutomatically ? "checked" : ""} />
            <label for="ack-${escapeHtml(cat.id)}">Accusé auto.</label>
          </div>
          <div>
            <span class="field-label">Alerter l'équipe si sans réponse</span>
            <select name="alertMode">
              ${(Object.keys(alertModeLabels) as Array<keyof typeof ALERT_MODES>)
                .map(
                  (mode) =>
                    `<option value="${mode}" ${mode === currentMode ? "selected" : ""}>${escapeHtml(alertModeLabels[mode])}</option>`
                )
                .join("")}
            </select>
          </div>
          <div><button class="btn btn-primary btn-sm" type="submit">Enregistrer</button></div>
        </form>
        <details class="advanced-steps">
          <summary>Réglages avancés de la séquence de relance (délais précis, étapes multiples)</summary>
          ${renderCategoryStepsPanel(cat.id, "pre_reply", "Avant notre réponse (nudge équipe)", csrfToken)}
          ${renderCategoryStepsPanel(cat.id, "post_reply", "Après notre réponse (relance client)", csrfToken)}
        </details>
      </div>`;
    })
    .join("");

  const body = `
    ${banner}
    <div class="settings-section">
      <h2>Catégories &amp; séquences de relance</h2>
      <p class="section-hint">Libellé, SLA et accusé automatique par catégorie. "Alerter l'équipe si sans réponse" filtre les rappels internes: réglez sur "Jamais" ou "Urgence haute uniquement" pour les catégories à faible enjeu, afin de ne pas noyer la boîte de l'équipe pour des demandes banales. Les délais précis restent réglables dans "Réglages avancés" ci-dessous, par catégorie ou pour un dossier précis depuis sa page de détail.</p>
      ${categoryBlocks}
      <form class="new-category-form" method="POST" action="/reglages/categories">
        ${csrfField(csrfToken)}
        <input type="text" name="label" placeholder="Nom de la nouvelle catégorie" required />
        <input type="number" name="slaMinutes" value="1440" min="0" step="1" title="Délai promis au client dans l'accusé de réception, en minutes (1440 = 24h)" />
        <label class="checkbox-cell"><input type="checkbox" name="acknowledgeAutomatically" checked /> Accusé auto.</label>
        <button class="btn btn-secondary btn-sm" type="submit">+ Nouvelle catégorie</button>
      </form>
    </div>`;

  return pageShell(
    "reglages",
    "Réglages",
    "SLA par catégorie, accusé automatique, et séquences de relance — modifiables ici, sans redéploiement.",
    body
  );
}

// ---------- Journal (audit) ----------

function renderJournalPage(reminders: ReminderRow[], errors: PipelineErrorRow[]): string {
  const rows = reminders.map(renderReminderRow).join("");
  const list = reminders.length
    ? `<div class="ledger">
        <div class="ledger-head"><span>Entrée</span></div>
        ${rows}
      </div>`
    : `<div class="ledger"><div class="empty">Aucune entrée pour le moment — les rappels internes et relances externes apparaissent ici.</div></div>`;

  const errorRows = errors.map(renderErrorRow).join("");
  const errorList = errors.length
    ? `<div class="ledger">
        <div class="ledger-head"><span>Erreur</span></div>
        ${errorRows}
      </div>`
    : `<div class="ledger"><div class="empty">Aucune erreur — le pipeline tourne sans incident depuis le dernier vidage de ce journal.</div></div>`;

  const liveToggle = `<div class="live-toggle">
    <label><input type="checkbox" id="live-refresh-toggle" /> Actualisation automatique (15s)</label>
    <span id="live-refresh-dot" class="live-dot"></span>
  </div>
  <script>
    (function () {
      var cb = document.getElementById("live-refresh-toggle");
      var dot = document.getElementById("live-refresh-dot");
      var on = localStorage.getItem("journalLiveRefresh") === "1";
      cb.checked = on;
      dot.classList.toggle("live-dot-on", on);
      var timer = null;
      function start() {
        dot.classList.add("live-dot-on");
        timer = setInterval(function () { location.reload(); }, 15000);
      }
      function stop() {
        dot.classList.remove("live-dot-on");
        if (timer) clearInterval(timer);
      }
      if (on) start();
      cb.addEventListener("change", function () {
        localStorage.setItem("journalLiveRefresh", cb.checked ? "1" : "0");
        if (cb.checked) start(); else stop();
      });
    })();
  </script>`;

  const body = `
    ${liveToggle}
    <div class="settings-section">
      <h2>Relances &amp; rappels</h2>
      <p class="section-hint">Trace de chaque notification équipe et de chaque relance client envoyée automatiquement par le pipeline.</p>
      ${list}
    </div>
    <div class="settings-section">
      <h2>Erreurs du pipeline</h2>
      <p class="section-hint">Echecs de traitement (email, generation IA, envoi, nettoyage de brouillons) — un dossier concerne par une erreur n'est pas bloqué pour les suivants, mais reste à traiter manuellement si l'erreur persiste.</p>
      ${errorList}
    </div>`;

  return pageShell(
    "journal",
    "Journal",
    "Ce qui a été fait automatiquement par le pipeline, et ce qui a échoué — pour intervenir sans avoir à rouvrir la boîte mail ou les logs du serveur.",
    body
  );
}

// ---------- Consommation IA ----------

const AI_CALL_TYPE_LABELS: Record<string, string> = {
  classification: "Classification de l'email",
  accuse_reception: "Rédaction de l'accusé de réception",
  brouillons_reponse: "Rédaction des 3 brouillons de réponse",
  relance_pre_reponse: "Rédaction d'une relance (avant notre réponse)",
  relance_post_reponse: "Rédaction d'une relance (après notre réponse)",
};

function aiCallTypeLabel(callType: string): string {
  return AI_CALL_TYPE_LABELS[callType] ?? callType;
}

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * config.pricing.inputPerMillionTokensUsd +
    (outputTokens / 1_000_000) * config.pricing.outputPerMillionTokensUsd
  );
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: amount < 1 ? 4 : 2 })}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("fr-FR");
}

function renderConsommationPage(summary: AiUsageSummary, recent: AiUsageEventRow[]): string {
  const totalTokens = summary.total.inputTokens + summary.total.outputTokens;
  const totalCost = estimateCostUsd(summary.total.inputTokens, summary.total.outputTokens);

  const metrics = `<div class="metric-grid">
    <div class="metric">
      <div class="metric-label">Appels IA ce mois-ci</div>
      <div class="metric-value">${summary.total.calls}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Tokens consommés</div>
      <div class="metric-value">${formatTokens(totalTokens)}</div>
      <div class="metric-sub">${formatTokens(summary.total.inputTokens)} entrée · ${formatTokens(summary.total.outputTokens)} sortie</div>
    </div>
    <div class="metric metric-warn">
      <div class="metric-label">Coût estimé ce mois-ci</div>
      <div class="metric-value">${formatUsd(totalCost)}</div>
      <div class="metric-sub">Estimation — voir tarifs ci-dessous</div>
    </div>
  </div>`;

  const breakdownRows = summary.byCallType
    .map((row) => {
      const cost = estimateCostUsd(row.inputTokens, row.outputTokens);
      return `<div class="ledger-row">
        <div class="ledger-main"><span class="subject-static">${escapeHtml(aiCallTypeLabel(row.callType))}</span></div>
        <div class="ledger-facts">
          <div class="ledger-fact"><span class="fact-label">Appels</span><span class="fact-value">${row.calls}</span></div>
          <div class="ledger-fact"><span class="fact-label">Tokens entrée</span><span class="fact-value">${formatTokens(row.inputTokens)}</span></div>
          <div class="ledger-fact"><span class="fact-label">Tokens sortie</span><span class="fact-value">${formatTokens(row.outputTokens)}</span></div>
          <div class="ledger-fact"><span class="fact-label">Coût estimé</span><span class="fact-value">${formatUsd(cost)}</span></div>
        </div>
      </div>`;
    })
    .join("");
  const breakdown = summary.byCallType.length
    ? `<div class="ledger"><div class="ledger-head"><span>Type d'appel</span></div>${breakdownRows}</div>`
    : `<div class="ledger"><div class="empty">Aucun appel IA enregistré ce mois-ci.</div></div>`;

  const recentRows = recent
    .map((ev) => {
      const cost = estimateCostUsd(ev.input_tokens, ev.output_tokens);
      return `<div class="ledger-row">
        <div class="ledger-main">
          <span class="subject-static">${escapeHtml(aiCallTypeLabel(ev.call_type))}</span>
          <div class="ledger-meta">${ev.thread_id ? `<a class="subject-link" href="/dossiers/${encodeURIComponent(ev.thread_id)}">Voir le dossier</a>` : "(sans dossier)"} — ${escapeHtml(formatDateTime(ev.created_at))}</div>
        </div>
        <div class="ledger-facts">
          <div class="ledger-fact"><span class="fact-label">Entrée</span><span class="fact-value">${formatTokens(ev.input_tokens)}</span></div>
          <div class="ledger-fact"><span class="fact-label">Sortie</span><span class="fact-value">${formatTokens(ev.output_tokens)}</span></div>
          <div class="ledger-fact"><span class="fact-label">Coût</span><span class="fact-value">${formatUsd(cost)}</span></div>
        </div>
      </div>`;
    })
    .join("");
  const recentList = recent.length
    ? `<div class="ledger"><div class="ledger-head"><span>Appel</span></div>${recentRows}</div>`
    : `<div class="ledger"><div class="empty">Aucun appel IA pour le moment.</div></div>`;

  const body = `
    ${metrics}
    <div class="settings-section">
      <h2>Répartition par type d'appel (ce mois-ci)</h2>
      <p class="section-hint">Chaque email traité déclenche plusieurs appels Claude distincts (classification, accusé, 3 brouillons, puis une relance si nécessaire) — cette répartition montre lesquels pèsent le plus.</p>
      ${breakdown}
    </div>
    <div class="settings-section">
      <h2>Derniers appels</h2>
      <p class="section-hint">Les 50 appels IA les plus récents, avec leur coût estimé individuel.</p>
      ${recentList}
    </div>
    <div class="banner banner-info">
      Estimation basée sur ${formatUsd(config.pricing.inputPerMillionTokensUsd)}/M tokens en entrée et
      ${formatUsd(config.pricing.outputPerMillionTokensUsd)}/M tokens en sortie (réglables via les variables
      d'environnement CLAUDE_INPUT_PRICE_PER_MTOK / CLAUDE_OUTPUT_PRICE_PER_MTOK) — à vérifier contre la
      tarification Anthropic en vigueur pour le modèle utilisé, le montant réel facturé peut différer.
      Le mois court en UTC (minuit UTC au 1ᵉʳ du mois), pas dans le fuseau du serveur.
    </div>`;

  return pageShell(
    "consommation",
    "Consommation IA",
    "Tokens consommés et coût estimé des appels Claude — mis à jour en temps réel, sans redéploiement.",
    body
  );
}

const PIPELINE_ERROR_CONTEXT_LABELS: Record<string, string> = {
  process_incoming: "Traitement d'un email entrant",
  relance_check: "Vérification des relances",
  draft_cleanup: "Nettoyage des brouillons",
  manual_override: "Traitement manuel d'un dossier",
  discover_outbound: "Détection d'un envoi sans dossier",
  web_request: "Action dans l'application",
  category_update: "Modification d'une catégorie",
  category_relance_step_add: "Ajout d'une étape de relance (catégorie)",
  category_relance_step_delete: "Suppression d'une étape de relance (catégorie)",
  relance_step_add: "Ajout d'une étape de relance (dossier)",
  relance_step_personnaliser: "Personnalisation de la séquence (dossier)",
  relance_step_reset: "Réinitialisation de la séquence (dossier)",
  relance_step_delete: "Suppression d'une étape de relance (dossier)",
};

/** Extrait le prefixe "[Source]" pose par tagSource()/withRetry() (ex: "[Claude — accusé]", "[Messagerie — envoi]") pour l'afficher comme un tampon distinct, au lieu de le laisser noye dans le texte du message. */
function extractSourceStamp(message: string): { source: string | null; rest: string } {
  const match = message.match(/^\[([^\]]+)\]\s*(.*)$/s);
  if (!match) return { source: null, rest: message };
  return { source: match[1], rest: match[2] };
}

function renderErrorRow(row: PipelineErrorRow): string {
  const contextLabel = PIPELINE_ERROR_CONTEXT_LABELS[row.context] ?? row.context;
  const { source, rest } = extractSourceStamp(row.message);
  return `<div class="ledger-row">
    <div class="ledger-main">
      ${
        row.thread_id
          ? `<a class="subject-link" href="/dossiers/${encodeURIComponent(row.thread_id)}">${escapeHtml(contextLabel)}</a>`
          : `<span class="subject-static">${escapeHtml(contextLabel)}</span>`
      }
      <div class="ledger-meta">${escapeHtml(rest)}</div>
    </div>
    <div class="ledger-facts">
      ${
        source
          ? `<div class="ledger-fact"><span class="fact-label">Source</span><span class="stamp stamp-internal">${escapeHtml(source)}</span></div>`
          : ""
      }
      <div class="ledger-fact"><span class="fact-label">Date</span><span class="fact-value">${escapeHtml(formatDateTime(row.created_at))}</span></div>
    </div>
  </div>`;
}

function renderReminderRow(row: ReminderRow): string {
  const kindLabel = channelLabel(row.kind);
  const stampClass = row.kind === "external" ? "stamp-external" : "stamp-internal";
  return `<div class="ledger-row">
    <div class="ledger-main">
      <a class="subject-link" href="/dossiers/${encodeURIComponent(row.thread_id)}">${escapeHtml(row.subject)}</a>
      <div class="ledger-meta">${escapeHtml(row.sender_email)}</div>
    </div>
    <div class="ledger-facts">
      <div class="ledger-fact"><span class="fact-label">Type</span><span class="stamp ${stampClass}">${escapeHtml(kindLabel)}</span></div>
      <div class="ledger-fact"><span class="fact-label">Note</span><span class="fact-value">${escapeHtml(row.note ?? "—")}</span></div>
      <div class="ledger-fact"><span class="fact-label">Date</span><span class="fact-value">${escapeHtml(formatDateTime(row.created_at))}</span></div>
    </div>
  </div>`;
}

// ---------- Envois sans dossier (suivi manuel) ----------

function renderNewSentPage(
  messages: EmailMessage[],
  csrfToken: string | undefined,
  saved: string | undefined,
  loadError: string | undefined
): string {
  const banner = loadError
    ? `<div class="banner banner-error">${escapeHtml(loadError)}</div>`
    : saved
      ? `<div class="banner banner-ok">Suivi démarré pour ce dossier.</div>`
      : "";

  const list = messages.length
    ? `<div class="ledger">
        <div class="ledger-head"><span>Envoi</span></div>
        ${messages.map((m) => renderNewSentRow(m, csrfToken)).join("")}
      </div>`
    : `<div class="ledger"><div class="empty">Aucun envoi récent sans dossier — tout ce que vous avez envoyé récemment est déjà suivi.</div></div>`;

  return pageShell(
    "envois",
    "Envois sans dossier",
    "Emails envoyés depuis votre messagerie qui ne font pas encore partie d'un dossier suivi (devis envoyé à froid, démarchage) — le suivi automatique s'en charge en général, mais un envoi très récent peut ne pas encore y figurer. Choisissez une catégorie et cliquez sur \"Suivre\" pour démarrer la relance immédiatement.",
    banner + list
  );
}

function renderNewSentRow(message: EmailMessage, csrfToken: string | undefined): string {
  const recipient = message.to[0];
  const recipientLabel = recipient
    ? `${recipient.name ? `${recipient.name} — ` : ""}${recipient.email}`
    : "(destinataire inconnu)";
  return `<div class="ledger-row">
    <div class="ledger-main">
      <span class="subject-static">${escapeHtml(message.subject)}</span>
      <div class="ledger-meta">${escapeHtml(recipientLabel)} — envoyé le ${escapeHtml(formatDateTime(message.receivedAt))}</div>
    </div>
    <div class="ledger-actions">
      ${
        recipient?.email
          ? `<form class="step-add-form" method="POST" action="/envois/suivre">
              ${csrfField(csrfToken)}
              <input type="hidden" name="threadId" value="${escapeHtml(message.threadId)}" />
              <input type="hidden" name="messageId" value="${escapeHtml(message.id)}" />
              <input type="hidden" name="subject" value="${escapeHtml(message.subject)}" />
              <input type="hidden" name="recipientEmail" value="${escapeHtml(recipient.email)}" />
              <input type="hidden" name="recipientName" value="${escapeHtml(recipient.name ?? "")}" />
              <input type="hidden" name="sentAt" value="${escapeHtml(message.receivedAt.toISOString())}" />
              <input type="hidden" name="hasAttachments" value="${message.hasAttachments ? "1" : "0"}" />
              <select name="categoryId">
                ${listCategories()
                  .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === "autre" ? "selected" : ""}>${escapeHtml(c.label)}</option>`)
                  .join("")}
              </select>
              <button class="btn btn-primary btn-sm" type="submit">Suivre</button>
            </form>`
          : `<span class="stamp stamp-skip">Destinataire inconnu</span>`
      }
    </div>
  </div>`;
}

// ---------- Ton de marque ----------

function renderBrandVoicePage(
  content: string,
  csrfToken: string | undefined,
  saved: string | undefined,
  error: string | undefined
): string {
  const banner = error
    ? `<div class="banner banner-error">Échec de l'enregistrement — voir le <a href="/journal">Journal</a>.</div>`
    : saved
      ? `<div class="banner banner-ok">Ton de marque enregistré — pris en compte dès le prochain email généré, sans redéploiement.</div>`
      : "";

  const body = `
    ${banner}
    <div class="settings-section">
      <h2>Ce que l'IA lit avant chaque rédaction</h2>
      <p class="section-hint">Ce texte est envoyé à Claude avant chaque accusé de réception, brouillon de réponse ou relance — c'est ici que vous réglez le tutoiement/vouvoiement, la signature, les formules à éviter, et 2-3 exemples réels du style de l'entreprise. Modifiable à tout moment, sans redéploiement.</p>
      <form method="POST" action="/ton-de-marque">
        ${csrfField(csrfToken)}
        <textarea name="content" rows="24" class="brand-voice-editor">${escapeHtml(content)}</textarea>
        <div style="margin-top: 12px;">
          <button class="btn btn-primary btn-sm" type="submit">Enregistrer</button>
        </div>
      </form>
    </div>`;

  return pageShell(
    "ton-de-marque",
    "Ton de marque",
    "Le gabarit de style que l'IA suit pour rédiger accusés, brouillons et relances.",
    body
  );
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
        sa page de détail (bouton "Supprimer les données"). Il n'y a pas de purge automatique à ce jour.</p>
      </div>
      <div class="card" style="flex-direction:column; align-items:flex-start; gap:8px;">
        <h2>Demande de suppression</h2>
        <p>Pour supprimer les données d'un dossier précis, ouvrez-le depuis <a href="/dossiers">Registre des dossiers</a>
        et utilisez le bouton "Supprimer les données". Cette action supprime le dossier, ses brouillons associés,
        son historique de relances, et toute séquence de relance personnalisée.</p>
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

/**
 * Filet de securite final: sans ce middleware, une erreur non rattrapee dans
 * une route (surtout les routes synchrones — Express 4 les intercepte
 * automatiquement mais n'avait nulle part ou les envoyer) finissait en page
 * 500 generique d'Express, invisible cote admin. Desormais journalisee dans
 * pipeline_errors (visible sur /journal) avec le chemin et le message exacts.
 */
function renderErrorPage(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Erreur</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F6F1E7; color: #211D17;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
  .box { max-width: 420px; text-align: center; }
  h1 { font-size: 19px; }
  p { color: #6E6455; line-height: 1.5; }
  a { color: #16202A; }
</style>
</head>
<body>
  <div class="box">
    <h1>Une erreur est survenue</h1>
    <p>L'action n'a pas pu aboutir. Elle a été journalisée — consultez la page <a href="/journal">Journal</a> pour le détail.</p>
    <p><a href="/dossiers">Retour au registre des dossiers</a></p>
  </div>
</body>
</html>`;
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[erreur non geree] ${req.method} ${req.path}:`, err);
  try {
    recordPipelineError("web_request", null, `${req.method} ${req.path}: ${message}`);
  } catch {
    // Si meme la journalisation echoue, ne pas empecher la reponse d'erreur de partir.
  }
  res.status(500);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderErrorPage());
});

app.listen(config.webPort, () => {
  console.log(`Page de connexion disponible sur http://localhost:${config.webPort}`);
});
