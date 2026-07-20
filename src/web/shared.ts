import { config } from "../config.js";

/**
 * Helpers de rendu partages entre l'admin (server.ts) et le dashboard client
 * (clientServer.ts) — extraits ici pour que les deux puissent les utiliser
 * sans que l'un importe l'autre (server.ts monte clientServer.ts comme
 * sous-routeur, un import dans l'autre sens creerait un cycle).
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function csrfField(csrfToken: string | undefined): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken ?? "")}" />`;
}

/**
 * Toutes les dates affichees dans l'admin ou le dashboard client doivent
 * passer par ici. Sans le timeZone explicite, toLocaleString() rend dans le
 * fuseau du PROCESSUS serveur (souvent UTC sur un hebergement PaaS), pas
 * celui de l'equipe — decalage silencieux d'1h+ observe en production
 * (config.timezone, par defaut Africa/Casablanca).
 */
export function formatDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("fr-FR", { timeZone: config.timezone });
}

export function sharedStyles(primaryColor: string): string {
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
  .stamp-from-us { color: var(--stamp-internal); }
  .stamp-from-client { color: var(--brand-primary); }
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
  .checklist { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
  .checklist-item { display: flex; align-items: center; gap: 10px; font-size: 13.5px; padding: 4px 0; }
  .checklist-item .box {
    width: 18px; height: 18px; border-radius: 3px; border: 1.5px solid var(--rule-strong); flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
  }
  .checklist-item.done .box { background: var(--stamp-done); border-color: var(--stamp-done); color: #fff; }
  .checklist-item.done span.label { color: var(--ink); }
  .checklist-item:not(.done) span.label { color: var(--ink-faint); }
  .checklist-item .box-delay { font-size: 11.5px; color: var(--ink-soft); margin-left: auto; font-family: var(--font-mono); }
  @media (max-width: 640px) {
    .category-head-form { grid-template-columns: 1fr; }
    .ledger-actions { margin-left: 0; }
  }`;
}
