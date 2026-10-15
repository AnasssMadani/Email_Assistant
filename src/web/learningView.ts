import type { CorpusCategoryStats, CorpusExample } from "../db.js";
import { LEARNING_READY_EXAMPLES, learningStatus, type LearningLevel } from "../pipeline/learning.js";
import { csrfField, escapeHtml, formatDateTime } from "./shared.js";

export interface LearningCategoryView {
  id: string;
  label: string;
  /** Cette catégorie envoie-t-elle des accusés automatiques (donc concernée par l'apprentissage)? */
  concerned: boolean;
  stats: CorpusCategoryStats | undefined;
  playbook: string;
  playbookDate: string | undefined;
}

export interface LearningPageData {
  categories: LearningCategoryView[];
  recent: CorpusExample[];
  ackReview: { drafted: number; reviewedOk: number };
  importResult?: { learned: number; seen: number; duplicates: number; batchId: string | undefined };
}

const LEVEL_STAMP: Record<LearningLevel, string> = {
  vide: "stamp-wait",
  debut: "stamp-wait",
  en_cours: "stamp-internal",
  pret: "stamp-done",
};

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

function renderTiles(data: LearningPageData): string {
  const total = data.categories.reduce((n, c) => n + (c.stats?.total ?? 0), 0);
  const manual = data.categories.reduce((n, c) => n + (c.stats?.manual ?? 0), 0);
  const concerned = data.categories.filter((c) => c.concerned);
  const ready = concerned.filter((c) => learningStatus(c.stats?.total ?? 0, c.playbook !== "").level === "pret").length;
  const lastAnalysis = data.categories
    .map((c) => c.playbookDate)
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  const { drafted, reviewedOk } = data.ackReview;
  const asIsRate = drafted > 0 ? `${Math.round((reviewedOk / drafted) * 100)} %` : "—";

  const tile = (value: string, label: string, sub: string) =>
    `<div class="learn-tile"><div class="learn-tile-value">${escapeHtml(value)}</div><div class="learn-tile-label">${escapeHtml(label)}</div><div class="learn-tile-sub">${escapeHtml(sub)}</div></div>`;

  return `<div class="learn-tiles">
    ${tile(String(total), "Réponses apprises", manual > 0 ? `dont ${manual} collée(s) à la main` : "captées dans la boîte")}
    ${tile(`${ready} / ${concerned.length}`, "Catégories prêtes", `≥ ${LEARNING_READY_EXAMPLES} exemples et note de style`)}
    ${tile(asIsRate, "Accusés « tels quels »", drafted > 0 ? `${reviewedOk} sur ${drafted} relus validés` : "aucun relu pour l'instant")}
    ${tile(lastAnalysis ? formatDateTime(lastAnalysis) : "—", "Dernière analyse", "mise à jour de la note de style")}
  </div>`;
}

function renderCategoryRow(c: LearningCategoryView): string {
  const examples = c.stats?.total ?? 0;
  const status = learningStatus(examples, c.playbook !== "");
  const note = c.playbook
    ? `<details class="learn-note"><summary>Voir ce que l'IA a retenu</summary><pre>${escapeHtml(c.playbook)}</pre></details>`
    : "";
  return `<div class="learn-row">
    <div class="learn-row-main">
      <strong>${escapeHtml(c.label)}</strong>
      <span class="stamp ${LEVEL_STAMP[status.level]}">${escapeHtml(status.label)}</span>
    </div>
    <div class="learn-bar" title="${examples} exemple(s) sur ${LEARNING_READY_EXAMPLES} pour être fiable"><span style="width:${status.progressPct}%"></span></div>
    <div class="learn-count">${examples} / ${LEARNING_READY_EXAMPLES}</div>
    <div class="learn-hint">${escapeHtml(status.hint)}${
      c.stats && c.stats.manual > 0 ? ` <span class="ledger-meta">(${c.stats.manual} collé(s))</span>` : ""
    }</div>
    ${note}
  </div>`;
}

function renderImportForm(csrfToken: string | undefined): string {
  return `<div class="settings-section">
    <h2>Apprendre de nouveaux fils</h2>
    <p class="section-hint">Collez un ou plusieurs fils d'emails complets (la demande du client et les réponses de votre équipe). Séparez les fils par une ligne <code>---</code>. L'IA repère ce que votre équipe a écrit, le range par catégorie et met à jour sa note de style tout de suite. Vous pouvez annuler un import juste après.</p>
    <form method="POST" action="/apprentissage/importer" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Analyse en cours… (jusqu\\u2019à une minute)';">
      ${csrfField(csrfToken)}
      <textarea name="text" rows="12" class="brand-voice-editor" placeholder="Collez ici les fils d'emails…" required></textarea>
      <div style="margin:10px 0;">
        <label for="teamHint" class="ledger-meta">Qui est l'équipe ? (facultatif — noms ou adresses, si ce n'est pas évident)</label>
        <input id="teamHint" name="teamHint" type="text" maxlength="300" style="width:100%;" placeholder="ex : Khalid, Younes, Chaimaa (@oceanlink-global.com)" />
      </div>
      <button class="btn btn-primary" type="submit">Analyser et apprendre</button>
    </form>
  </div>`;
}

function renderRecent(data: LearningPageData, csrfToken: string | undefined): string {
  if (data.recent.length === 0) {
    return `<div class="settings-section"><h2>Derniers exemples appris</h2><p class="section-hint">Rien pour l'instant. Collez des fils ci-dessus, ou attendez les premières réponses de l'équipe captées dans la boîte.</p></div>`;
  }
  const labels = new Map(data.categories.map((c) => [c.id, c.label]));
  const rows = data.recent
    .map(
      (e) => `<div class="learn-example">
      <div class="ledger-meta">
        <span class="stamp ${e.source === "manuel" ? "stamp-internal" : "stamp-done"}">${e.source === "manuel" ? "Collé" : "Capté"}</span>
        ${escapeHtml(labels.get(e.categoryId) ?? e.categoryId)} — ${escapeHtml(formatDateTime(e.createdAt))}
      </div>
      ${e.clientAsk ? `<div class="ledger-meta">Demande : ${escapeHtml(e.clientAsk)}</div>` : ""}
      <div>${escapeHtml(excerpt(e.replyBody, 260))}</div>
      <form method="POST" action="/apprentissage/exemple/${e.id}/supprimer" style="margin-top:6px;">
        ${csrfField(csrfToken)}
        <button class="btn btn-sm" type="submit">Retirer cet exemple</button>
      </form>
    </div>`
    )
    .join("");
  return `<div class="settings-section"><h2>Derniers exemples appris</h2>
    <p class="section-hint">Ce qui vient d'entrer dans la mémoire de style. Retirez un exemple qui ne représente pas vraiment votre façon de répondre.</p>
    ${rows}</div>`;
}

export function renderLearningBody(data: LearningPageData, csrfToken: string | undefined): string {
  const relevant = data.categories
    .filter((c) => c.concerned || (c.stats?.total ?? 0) > 0)
    .sort((a, b) => (b.stats?.total ?? 0) - (a.stats?.total ?? 0) || a.label.localeCompare(b.label));

  const result = data.importResult;
  const banner = result
    ? result.learned > 0
      ? `<div class="banner banner-ok">${result.learned} réponse(s) de l'équipe apprise(s) à partir de ${result.seen} fil(s)${
          result.duplicates ? ` (${result.duplicates} déjà connue(s) ignorée(s))` : ""
        }.${
          result.batchId
            ? ` <form method="POST" action="/apprentissage/annuler/${escapeHtml(result.batchId)}" style="display:inline;">${csrfField(csrfToken)}<button class="btn btn-sm" type="submit">Annuler cet import</button></form>`
            : ""
        }</div>`
      : `<div class="banner banner-error">Aucune réponse de l'équipe trouvée dans ce texte (${result.seen} fil(s) lu(s)). Indiquez qui est l'équipe dans le champ prévu, ou collez des fils où elle répond.</div>`
    : "";

  return `${banner}
    ${renderTiles(data)}
    <div class="settings-section">
      <h2>Maturité par catégorie</h2>
      <p class="section-hint">L'IA ne se réentraîne pas : elle relit une note de style tirée de vos vraies réponses avant chaque accusé. Plus une catégorie a d'exemples, plus cette note est fiable.</p>
      <div class="learn-list">${relevant.map(renderCategoryRow).join("") || '<div class="empty">Aucune catégorie.</div>'}</div>
      <form method="POST" action="/apprentissage/analyser" style="margin-top:12px;">
        ${csrfField(csrfToken)}
        <button class="btn btn-sm" type="submit">Régénérer toutes les notes de style</button>
      </form>
    </div>
    ${renderImportForm(csrfToken)}
    ${renderRecent(data, csrfToken)}`;
}
