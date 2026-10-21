import type { ReplyDraftComparison, ReplyDraftVerdict } from "../db.js";
import { csrfField, escapeHtml, formatDateTime } from "./shared.js";

const VERDICT_LABELS: Record<ReplyDraftVerdict, string> = {
  bon: "Bon tel quel",
  retouche: "À retoucher",
  inutilisable: "Inutilisable",
};

const CONFIDENCE_LABELS = { high: "confiance haute", medium: "confiance moyenne", low: "confiance basse" } as const;

function highlight(text: string): string {
  return escapeHtml(text).replace(/\[\[([^\]]+)\]\]/g, "<mark>[[$1]]</mark>");
}

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)} %` : "—";
}

function tile(value: string, label: string, sub: string): string {
  return `<div class="learn-tile"><div class="learn-tile-value">${escapeHtml(value)}</div><div class="learn-tile-label">${escapeHtml(label)}</div><div class="learn-tile-sub">${escapeHtml(sub)}</div></div>`;
}

function renderRow(c: ReplyDraftComparison, csrfToken: string | undefined, days: number): string {
  const d = c.draft;
  const sender = c.senderName ? `${c.senderName} <${c.senderEmail}>` : c.senderEmail;
  const draftBlock = d.shouldReply
    ? `${d.subject ? `<p><strong>Objet :</strong> ${escapeHtml(d.subject)}</p>` : ""}<pre class="draft-pre">${highlight(d.body)}</pre>${
        d.missing.length ? `<p class="ledger-meta">À compléter : ${d.missing.map(escapeHtml).join(" · ")}</p>` : ""
      }`
    : `<p><strong>L'IA juge qu'aucune réponse n'est nécessaire.</strong> ${escapeHtml(d.reason)}</p>`;
  const teamBlock = c.teamReply
    ? `<pre class="draft-pre draft-team">${escapeHtml(c.teamReply)}</pre><p class="ledger-meta">Envoyée le ${escapeHtml(formatDateTime(c.teamReplyAt ?? ""))}</p>`
    : `<p class="ledger-meta">L'équipe n'a pas (encore) répondu dans la boîte.</p>`;
  const verdictForm = `<form method="POST" action="/brouillons/${d.id}/avis" class="draft-verdict">
      ${csrfField(csrfToken)}<input type="hidden" name="days" value="${days}" />
      ${(Object.keys(VERDICT_LABELS) as ReplyDraftVerdict[])
        .map(
          (v) =>
            `<button class="btn btn-sm${d.verdict === v ? " btn-primary" : ""}" type="submit" name="verdict" value="${v}">${VERDICT_LABELS[v]}</button>`
        )
        .join(" ")}
      ${d.verdict ? `<button class="btn btn-sm" type="submit" name="verdict" value="">Effacer</button>` : ""}
    </form>`;
  return `<div class="draft-card">
    <div class="draft-head">
      <a href="/dossiers/${encodeURIComponent(d.threadId)}"><strong>${escapeHtml(c.subject)}</strong></a>
      <span class="ledger-meta">${escapeHtml(sender)} · ${escapeHtml(formatDateTime(d.createdAt))} · ${escapeHtml(d.categoryId)}${
        d.shouldReply ? ` · ${escapeHtml(CONFIDENCE_LABELS[d.confidence])}` : ""
      }</span>
    </div>
    <div class="draft-cols">
      <div><h3>Brouillon de l'IA</h3>${draftBlock}</div>
      <div><h3>Réponse réelle de l'équipe</h3>${teamBlock}</div>
    </div>
    ${verdictForm}
  </div>`;
}

export function renderDraftsBody(rows: ReplyDraftComparison[], days: number, csrfToken: string | undefined): string {
  const withReply = rows.filter((r) => r.draft.shouldReply);
  const reviewed = rows.filter((r) => r.draft.verdict);
  const count = (v: ReplyDraftVerdict) => reviewed.filter((r) => r.draft.verdict === v).length;
  const withTeam = withReply.filter((r) => r.teamReply).length;

  const tiles = `<div class="learn-tiles">
    ${tile(String(rows.length), "Brouillons", `sur ${days} jour(s), ${withReply.length} avec une réponse proposée`)}
    ${tile(String(withTeam), "Avec la vraie réponse", "de l'équipe, pour comparer")}
    ${tile(pct(count("bon"), reviewed.length), "Bons tels quels", `${count("bon")} sur ${reviewed.length} relus`)}
    ${tile(pct(count("bon") + count("retouche"), reviewed.length), "Utilisables", `${count("retouche")} à retoucher, ${count("inutilisable")} inutilisables`)}
  </div>`;

  const windows = [1, 3, 7, 30]
    .map((n) => (n === days ? `<strong>${n} j</strong>` : `<a href="/brouillons?jours=${n}">${n} j</a>`))
    .join(" · ");

  return `<style>
    .draft-card { border: 1px solid var(--rule); padding: 14px 16px; margin-bottom: 14px; }
    .draft-head { display: grid; gap: 2px; margin-bottom: 8px; }
    .draft-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .draft-cols h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-soft, #55646f); }
    .draft-pre { white-space: pre-wrap; font: inherit; background: rgba(127,127,127,.1); padding: 10px 12px; border-radius: 6px; margin: 6px 0; }
    .draft-team { border-left: 3px solid var(--stamp-done); }
    .draft-verdict { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  </style>
  <p class="section-hint">Chaque brouillon est rédigé par l'IA et reste ici : il n'est ni envoyé ni déposé dans la boîte mail. Comparez-le à ce que l'équipe a réellement répondu, puis donnez votre avis. Période : ${windows}</p>
  ${tiles}
  ${rows.length ? rows.map((r) => renderRow(r, csrfToken, days)).join("") : `<p class="section-hint">Aucun brouillon sur cette période. Ils apparaissent ici dès que ENABLE_DRAFT_REPLIES est activé et qu'un email attend une réponse.</p>`}`;
}
