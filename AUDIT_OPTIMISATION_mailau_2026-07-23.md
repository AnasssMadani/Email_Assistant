# AUDIT D'OPTIMISATION — mailau (Global Link · Accusé & Relance)

**Date :** 2026-07-23
**Périmètre :** dépôt complet (`src/`, pipeline, connecteurs, web, DB)
**Contexte :** production, onboarding client. Transitaires, 1–2 boîtes email. Données : factures, devis, réclamations.
**Auteur :** revue Principal Engineer — recommandations uniquement, **aucun fichier modifié**.

> **Cadre méthodologique.** Ce rapport ne recommande rien « par principe ». Chaque
> proposition part d'un coût actuel démontré ou mesurable, marqué **MESURÉ** /
> **ESTIMÉ** / **SUPPOSÉ**. Là où je ne peux pas mesurer sans accès au runtime,
> je fournis la commande exacte à exécuter (section 8). Plusieurs « bonnes
> pratiques » classiques sont **explicitement écartées** (section 7) parce qu'à
> l'échelle réelle de ce produit — 1 à 2 boîtes, quelques dizaines d'emails/jour —
> elles n'apportent aucun gain mesurable et ajoutent de la complexité. Un audit qui
> mettrait tout en « impact élevé » ne servirait à rien.

---

## 1. SYNTHÈSE EXÉCUTIVE

### État actuel en une phrase honnête

**Le produit fonctionne et est correctement pensé pour son échelle ; ses vrais
problèmes ne sont pas la performance brute mais (a) un gaspillage d'appels Gmail
massif et facilement supprimable, (b) une machine à états à deux boucles devenue
difficile à raisonner — exactement la « logique un peu messy » ressentie — qui
bloque le changement métier demandé (« notifier l'équipe en premier »), et (c) une
promesse du dashboard (« savoir quel employé est le moins performant ») que le
modèle de données actuel est structurellement incapable de tenir.**

### Scorecard par axe (/10)

| Axe | Note | Justification en une ligne |
|-----|------|----------------------------|
| 1. Performance backend & données | **6/10** | SQLite in-process = requêtes triviales à cette échelle ; mais N+1 Gmail réel et coûteux à chaque cycle. |
| 2. Performance frontend | **8/10** | HTML rendu serveur, zéro bundle JS, zéro dépendance front. Rien à optimiser ici — et c'est un bon choix. |
| 3. Coût d'infrastructure | **7/10** | Render Starter 7 $/mois fixe + tokens Claude non caché (poste variable n°1). Modeste mais réductible. |
| 4. Architecture & modularité | **5/10** | Deux boucles de relance + comptage + snapshots + statut partagé : correct mais dur à faire évoluer. `server.ts` = 2304 lignes. |
| 5. Qualité & maintenabilité | **7/10** | Typage strict, commentaires « pourquoi » excellents, tests réels. Alourdi par la dette de la double-écriture `sla_hours`/`sla_minutes` et 9 migrations additives. |
| 6. Scalabilité | **6/10** | Parfait à 1–2 boîtes. Casse proprement à 10× (N+1 séquentiel, table `reminders` non indexée qui grossit sans borne). |
| 7. Résilience & exploitation | **5/10** | Isolation par message OK. Mais aucun retry/backoff sur Gmail/Graph (seul Claude retente), observabilité = `console.log` + table d'erreurs. |
| 8. Expérience utilisateur | **7/10** | Dashboard clair, checklist lisible. Pas de temps réel, quelques latences perçues côté admin. |
| 9. Automatisation & IA | **6/10** | IA bien placée (classer/rédiger). Mais pas de prompt caching, et la vraie valeur métier (perf par employé) n'est pas automatisée du tout. |

### Potentiel total (chiffré, honnête)

- **Latence du cycle de scrutation : −70 à −85 %** en régime permanent (de ~26 appels Gmail séquentiels/cycle à 1–2). **MESURABLE** (section 8).
- **Coût Claude : −25 à −40 % sur les tokens d'entrée** via prompt caching, soit **~10–20 $/mois économisés** à volume pilote. **ESTIMÉ** — à confirmer sur `/consommation`.
- **Heures de dev récupérées : ~2–4 j de friction évités par trimestre** en dé-couplant la machine à états (chaque futur changement de séquence devient une donnée, pas du code réparti sur 3 fichiers).
- **Débloque le livrable métier** « quel employé est le moins performant » — aujourd'hui **impossible** sans changement de modèle (section OPT-005).

### Les 5 actions qui capturent 80 % du gain

1. **OPT-001** — Dédupliquer AVANT de télécharger dans le connecteur Gmail (supprime le N+1 en régime permanent). *Quick win, S.*
2. **OPT-004** — Remplacer la double-boucle de comptage par une **timeline d'actions dues** explicite → débloque « notifier l'équipe en premier » comme simple configuration. *Chantier, L.*
3. **OPT-003** — Prompt caching sur les blocs système accusé/relance (ton de marque + playbook stables). *Quick win, S.*
4. **OPT-008** — Wrapper retry/backoff sur les appels connecteur (Gmail/Graph 429/5xx). *Quick win, S/M.*
5. **OPT-005** — Attribution par agent (préparer le dashboard de performance réellement demandé). *Chantier, M/L.*

---

## 2. CARTE DU SYSTÈME ET CHEMINS CHAUDS (Phase 0)

### Architecture réelle (pas celle du README)

```
                 node-cron (2 deployables : index.ts scheduler | main.ts scheduler+web)
                            │
   ┌────────────────────────┼─────────────────────────┬───────────────────────┐
   │ pollInbox  (*/2 min)   │ discoverOutbound (*/2)   │ checkRelances (*/2)   │ corpusAnalysis (3h)
   ▼                        ▼                          ▼                       ▼
listRecentInbox(25)   listRecentSent(25)        listThreadsAwaitingReply()   analyse corpus
   │ 1 list + 25 GET       │ 1 list + 25 GET          + AwaitingClientReply()   (1 appel Claude/cat)
   ▼ (N+1 Gmail)           ▼ (N+1 Gmail)             ▼ getThread() par dossier
processIncoming          registerIfNewThread        checkPre/PostReplyThread
   │ getThread() (encore) │ getThread()+classify      │ getThread() + draftRelance
   ▼ classify + accusé     ▼ upsert post_reply         ▼ notif interne | relance externe
   ▼ draftAck (Claude)                                 ▼ recordReminder(step_type)
   DB (node:sqlite, fichier /var/data/app.db)
```

**Deux points structurants confirmés dans le code :**

1. **Le connecteur Graph (cible production Outlook/M365) est efficace** : `listByFolder`
   fait **un seul** appel `$top=25&$select=...` (pas de N+1). **Le connecteur Gmail
   (pilote actuel) fait du N+1** : `messages.list` puis un `messages.get(format:full)`
   par id, **inconditionnellement**, avant toute déduplication
   (`src/connectors/gmailConnector.ts:68-85`). C'est l'asymétrie centrale de cet audit.

2. **La machine à états relance est à deux boucles indépendantes** ancrées sur deux
   colonnes (`due_at` pour pre_reply, `human_replied_at` pour post_reply), avec
   détection de réponse humaine **par comptage** (`automated_outbound_count` vs nombre
   de messages `isFromUs`) et **gel de séquence par snapshot JSON**. C'est robuste mais
   c'est la source de la « logique messy » ressentie.

### Volume de données et trajectoire

- **Utilisateurs :** 1–2 boîtes. **SUPPOSÉ** : 20–60 emails entrants/jour/boîte.
- `threads` : ~1 ligne/dossier → **centaines à quelques milliers de lignes/an**.
- `processed_messages` : 1 ligne/message vu → **dizaines de milliers/an** (PK indexée, OK).
- `reminders` : 1 ligne par étape franchie → **grossit sans borne, non indexée** (voir OPT-006).
- `ai_usage_events` : 1 ligne/appel Claude → source de vérité du coût (section 8).

### Où va l'argent (facturé à l'usage)

| Poste | Nature | Estimation mensuelle |
|-------|--------|----------------------|
| **Tokens Claude** (`claude-sonnet-5`, 3 $/15 $ par MTok) | Variable, ~2 appels/email accusé + 1/relance | **~20–50 $/mois** (ESTIMÉ, volume pilote — mesurer via `/consommation`). **Poste variable n°1.** |
| **Render Starter** | Fixe (1 instance always-on + disque 1 Go) | **7 $/mois** (fixe, incompressible sans downgrade risqué). |
| **Gmail / Graph API** | Gratuit (quota), mais **latence** et compute gaspillé | 0 $ direct — mais ~37 000 appels Gmail/jour dont >95 % redondants (OPT-001). |

**Conclusion Phase 0 :** le seul poste *facturé* réductible est Claude (caching, OPT-003).
Le gaspillage Gmail ne coûte pas de dirhams mais de la **latence** et de la **fragilité**
(plus d'appels = plus de surface de panne / rate-limit). Le vrai ROI est ailleurs :
**débloquer les évolutions métier** (OPT-004, OPT-005).

---

## 3. RECOMMANDATIONS DÉTAILLÉES

### AXE 1 — PERFORMANCE BACKEND & DONNÉES

---

**[OPT-001] Déduplication avant téléchargement dans le connecteur Gmail**
**Axe :** Performance données | **Priorité : QUICK WIN**
**Localisation :** `src/connectors/gmailConnector.ts:68-93`

**Situation actuelle :**
```ts
private async listByLabel(label, maxResults): Promise<EmailMessage[]> {
  const list = await gmail.users.messages.list({ userId: "me", labelIds: [label], maxResults });
  const ids = list.data.messages ?? [];
  const messages: EmailMessage[] = [];
  for (const { id } of ids) {
    if (!id) continue;
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" }); // ← 25 GET, séquentiels, à CHAQUE cycle
    messages.push(this.toEmailMessage(full.data, ownEmail));
  }
  return messages.sort(...);
}
```
Chaque cycle (`pollInbox` **et** `discoverOutbound`, tous les deux toutes les 2 min)
re-télécharge le corps **complet** des 25 messages les plus récents, **même déjà
traités**. La déduplication (`isMessageProcessed`) n'intervient qu'ensuite, dans
`processIncoming.ts:27` — trop tard, le corps est déjà chargé.

**Coût actuel :** **MESURÉ par lecture de code** — 1 `list` + 25 `get` = 26 appels/cycle,
× 2 boucles × 30 cycles/h × 24 h ≈ **~37 000 appels Gmail/jour**, dont **>95 % re-fetchent
des messages déjà traités**. Chaque `get(full)` = ~5 unités de quota + un aller-retour
réseau séquentiel (~100–300 ms). Un cycle prend donc **~3 à 8 s de round-trips séquentiels**
pour, la plupart du temps, ne rien découvrir de neuf. **ESTIMÉ** (latence) — à confirmer §8.

**Problème :** on paie 25 téléchargements pour, en régime permanent, 0 à 1 message
nouveau. C'est du gaspillage pur, et ça élargit inutilement la surface de rate-limit /
panne transitoire (OPT-008).

**Solution :** filtrer les ids par `isMessageProcessed` **avant** le `get`, et paralléliser
le reliquat.
```ts
import { isMessageProcessed } from "../db.js";

private async listByLabel(label, maxResults): Promise<EmailMessage[]> {
  const gmail = await this.getGmail();
  const ownEmail = await this.getOwnEmailAddress();
  const list = await gmail.users.messages.list({ userId: "me", labelIds: [label], maxResults });
  const ids = (list.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => !!id && !isMessageProcessed(id)); // ← dédup AVANT le get

  const fulls = await Promise.all(               // ← parallélisé (OPT-009 inclus)
    ids.map((id) => gmail.users.messages.get({ userId: "me", id, format: "full" }))
  );
  return fulls
    .map((full) => this.toEmailMessage(full.data, ownEmail))
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}
```
> **Nuance importante (anti-cargo-cult) :** `discoverOutbound` marque le message traité
> *lui-même* (`markMessageProcessed` en tête de `registerIfNewThread`), donc filtrer sur
> `isMessageProcessed` y est correct. Pour `pollInbox`, le message est marqué en fin de
> `processIncoming` — donc un message vu mais dont le traitement a échoué reste
> `!isMessageProcessed` et sera re-téléchargé au cycle suivant : **c'est le comportement
> voulu** (retry). Aucune régression sur la sémantique de retry.

**Gain attendu :** en régime permanent, **26 → 1–2 appels Gmail/cycle** (le `list`, plus
0–1 `get`). **−95 % d'appels Gmail**, cycle de scrutation ramené de plusieurs secondes à
< 500 ms. **Méthode :** compter les appels avant/après (§8).

**Effort :** **S** (< 2 h, une fonction, symétrique inbox/sent).
**Risque :** **faible** — la dédup existe déjà en aval ; on la remonte. À valider : que
`processIncoming` reste idempotent (il l'est : `isMessageProcessed` en tête).
**Vérification :** instrumenter un compteur d'appels (§8, protocole A) ; le nombre de
`get` par cycle doit chuter à ~0 dès le 2ᵉ cycle.

---

**[OPT-002] Restreindre la fenêtre de scrutation Gmail via `q` (`is:unread`/`newer_than`)**
**Axe :** Performance données | **Priorité : QUICK WIN**
**Localisation :** `src/connectors/gmailConnector.ts:71-75`, `src/pipeline/discoverOutbound.ts:19,36`

**Situation actuelle :** `messages.list` ramène systématiquement les 25 plus récents,
sans filtre serveur. `discoverOutbound` compense côté client avec `OBSERVED_SINCE`
(`receivedAt < OBSERVED_SINCE` ignoré), mais **le téléchargement a déjà eu lieu**.

**Coût actuel :** **MESURÉ (lecture code)** — même racine qu'OPT-001 ; ici le gaspillage
est *dans le `list`* : on demande 25 ids là où, en pratique, 0–2 sont nouveaux.

**Problème :** la fenêtre est fixée par un nombre (25) et non par le temps réel écoulé.
En cas de rafale (> 25 emails en 2 min), on **perd** des messages ; en régime calme, on
sur-liste.

**Solution :** utiliser le paramètre `q` de l'API Gmail, gratuit et évalué côté serveur.
```ts
// pollInbox : ne lister que le non-lu récent
const list = await gmail.users.messages.list({
  userId: "me", labelIds: ["INBOX"], q: "is:unread newer_than:1d", maxResults,
});
// discoverOutbound : ne lister que les envois postérieurs au démarrage
const list = await gmail.users.messages.list({
  userId: "me", labelIds: ["SENT"], q: `newer_than:1d`, maxResults,
});
```
> Le pipeline **re-marque déjà les messages non-lus** après accusé
> (`processIncoming.ts:159`, `markMessageUnread`), donc `is:unread` reste cohérent avec
> l'intention « l'équipe ne l'a pas encore vu ». À combiner avec OPT-001, pas à la place.

**Gain attendu :** liste bornée au flux réel, **suppression du risque de perte au-delà de
25 msg/cycle**, et moins d'ids à filtrer. **ESTIMÉ.**
**Effort :** **S** (< 2 h). **Risque :** **moyen** — `is:unread` change la sémantique de
sélection ; à tester sur une boîte où l'équipe lit les mails avant le cycle (sinon OK car
on re-marque non-lu). Garder `newer_than` seul si doute.
**Vérification :** vérifier qu'aucun dossier légitime n'est manqué sur 48 h de trafic réel.

---

**[OPT-006] Index sur `reminders(thread_id)` — la seule table non bornée réellement scannée**
**Axe :** Performance données | **Priorité : AJUSTEMENT**
**Localisation :** `src/db.ts:138-145` (schéma), `hasReminderStep` (dashboard client, appelé 3×/détail)

**Situation actuelle :** aucun index applicatif dans tout le schéma. `reminders` grossit
d'une ligne par étape franchie, et le dashboard client interroge
`SELECT 1 FROM reminders WHERE thread_id = ? AND step_type = ? LIMIT 1` (3 fois par vue
détail via `getClientThreadDetail`).

**Coût actuel :** **ESTIMÉ** — à quelques milliers de lignes, un full-scan SQLite in-process
reste < 1 ms : **le coût aujourd'hui est ~0**. C'est la **trajectoire** qui justifie l'action :
sur 1–2 ans, `reminders` atteint 10 000–50 000 lignes, et chaque ouverture de détail
client déclenche 3 scans linéaires.

**Problème :** dette silencieuse — invisible au pilote, coûteuse quand le client consulte
souvent son dashboard sur un historique d'un an.

**Solution :**
```sql
CREATE INDEX IF NOT EXISTS idx_reminders_thread ON reminders(thread_id, step_type);
```
(à ajouter dans le bloc `db.exec` de `src/db.ts`, à côté des `CREATE TABLE`).

**Gain attendu :** scan → lookup O(log n) sur la seule table non bornée réellement filtrée.
Gain nul aujourd'hui, **significatif à 12+ mois**. **ESTIMÉ.**
**Effort :** **S** (< 30 min). **Risque :** **faible** (index additif, aucune donnée touchée).
**Vérification :** `EXPLAIN QUERY PLAN SELECT 1 FROM reminders WHERE thread_id=? AND step_type=?`
doit passer de `SCAN reminders` à `SEARCH reminders USING INDEX`.

---

**[OPT-007] Activer WAL + statements préparés au niveau module**
**Axe :** Performance données | **Priorité : AJUSTEMENT**
**Localisation :** `src/db.ts:9` (init), toutes les fonctions appelant `db.prepare(...)` inline

**Situation actuelle :** `new DatabaseSync(...)` sans PRAGMA (journal `DELETE` par défaut),
et chaque fonction re-`prepare()` son SQL à chaque appel (ex. `isMessageProcessed`,
`markMessageProcessed` appelés ~25×/cycle).

**Coût actuel :** **ESTIMÉ / SUPPOSÉ** — à cette échelle, négligeable. Le scheduler et le
serveur web partagent le **même fichier DB** ; sans WAL, une écriture longue peut brièvement
bloquer une lecture web. Le re-`prepare` re-parse le SQL mais reste sous la milliseconde.

**Problème :** deux micro-inefficacités réelles mais à impact quasi nul aujourd'hui — je les
documente honnêtement comme **ajustements à grouper**, pas comme priorités.

**Solution :**
```ts
const db = new DatabaseSync(path.resolve(config.dbPath));
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
```
(Les statements préparés au niveau module ne valent que si un profilage le justifie — voir
§7, je ne le recommande **pas** en l'état.)

**Gain attendu :** meilleure concurrence lecture web / écriture scheduler ; robustesse
« database is locked ». **ESTIMÉ**, faible à ce volume.
**Effort :** **S** (WAL : 3 lignes). **Risque :** **faible** (WAL crée `-wal`/`-shm` sur le
disque persistant `/var/data` — vérifier l'espace, 1 Go suffit largement).
**Vérification :** `PRAGMA journal_mode;` renvoie `wal`.

---

### AXE 2 — PERFORMANCE FRONTEND

**Déjà quasi optimal — voici pourquoi.** Le front est du HTML rendu côté serveur
(`server.ts`, `clientServer.ts`, `shared.ts`), **sans bundle JS, sans framework, sans
dépendance client, sans image lourde**. Pour un dashboard consulté par 1–2 utilisateurs
internes et un client, c'est le bon choix : LCP piloté par le TTFB serveur (SQLite local,
< 50 ms), INP/CLS non pertinents (pas d'hydratation, pas de layout shift). **Aucune
recommandation front n'aurait de gain mesurable** — l'axe est vert. Toute réécriture en
SPA/Next.js serait une **régression** de complexité (voir §7). *(Note UX distincte : OPT-010
ci-dessous, qui relève de l'axe 8, pas de la perf.)*

---

### AXE 3 — COÛT D'INFRASTRUCTURE

**[OPT-003] Prompt caching Anthropic sur les blocs système accusé & relance**
**Axe :** Coût infra / IA | **Priorité : QUICK WIN**
**Localisation :** `src/ai/draftAcknowledgement.ts`, `src/ai/draftRelance.ts:63-155`, `src/ai/classify.ts:52-67`

**Situation actuelle :** chaque appel Claude renvoie intégralement un bloc système
volumineux et **stable** (ton de marque `loadBrandVoice()`, note de style playbook,
règles de rédaction, liste des catégories pour classify) — sans `cache_control`. Aucun
caching n'est utilisé.

**Coût actuel :** **MESURABLE** — chiffres réels dans `ai_usage_events` (page `/consommation`).
**ESTIMÉ** : le bloc système stable représente ~40–60 % des tokens **d'entrée** de chaque
appel accusé/relance. À volume pilote (~20–50 $/mois de Claude, majoritairement en entrée),
c'est **~10–20 $/mois** payés à re-transmettre le même contexte.

**Problème :** on paie plein tarif d'entrée pour un préfixe identique d'un appel à l'autre.

**Solution :** marquer le préfixe système stable avec `cache_control` (TTL 5 min, largement
couvert par la cadence 2 min du scheduler → forte probabilité de hit en rafale).
```ts
const response = await client.messages.create({
  model: CLAUDE_MODEL,
  max_tokens: 700,
  system: [
    { type: "text", text: STABLE_PREFIX, cache_control: { type: "ephemeral" } }, // ton de marque + règles + playbook
    { type: "text", text: perDossierSuffix },                                     // partie variable (catégorie, continuité)
  ],
  tools: [tool],
  ...
});
```
> **Anti-cargo-cult :** l'input caching ne rapporte que si le **même préfixe** est réémis
> dans la fenêtre de cache. Ici la cadence 2 min et le ton de marque partagé garantissent
> des hits en période active ; en trafic très épars (1 email/heure), le gain retombe.
> Bénéfice **réel mais modeste** — je le classe quick win pour l'effort, pas pour le montant.

**Gain attendu :** **−25 à −40 % de tokens d'entrée** sur accusé/relance → **~10–20 $/mois**
au volume actuel, proportionnellement plus si le trafic monte. **ESTIMÉ** — mesurer via
`ai_usage_events` avant/après (§8, protocole C).
**Effort :** **S** (< 2 h : restructurer `system` en blocs). **Risque :** **faible** (le SDK
`@anthropic-ai/sdk ^0.32` supporte `cache_control` ; sortie inchangée).
**Vérification :** comparer `SUM(input_tokens)` par `call_type` sur 48 h avant/après, à trafic
comparable ; les champs `cache_creation`/`cache_read` de l'usage confirment les hits.

---

**Le reste de l'axe 3 est incompressible sans risque.** Render Starter (7 $/mois) est le
plancher raisonnable pour un process `node-cron` always-on + disque persistant SQLite.
Passer en plan gratuit / serverless **casserait** le scheduling et le disque (le README le
documente déjà, §« À éviter : Vercel/Netlify »). **Écarté** (§7).

---

### AXE 4 — ARCHITECTURE & MODULARITÉ

**[OPT-004] Remplacer la double-boucle de comptage par une TIMELINE D'ACTIONS DUES explicite**
**Axe :** Architecture | **Priorité : CHANTIER** — *débloque directement le besoin métier « notifier l'équipe en premier »*
**Localisation :** `src/pipeline/relanceCheck.ts` (467 l.), `src/pipeline/processIncoming.ts`, colonnes `threads.*_count` / `*_snapshot` / `human_replied_at` / `due_at`

**Situation actuelle :** le cycle de vie d'un dossier est piloté par **deux boucles
indépendantes** (`listThreadsAwaitingReply` ancrée sur `due_at` ; `listThreadsAwaitingClientReply`
ancrée sur `human_replied_at`), un **statut unique partagé** entre les deux phases (dont le
CLAUDE.md rappelle qu'une collision a déjà causé un bug d'oscillation réel), une **détection
de réponse par comptage** (`automated_outbound_count` vs messages `isFromUs`), et un **gel de
séquence par snapshot JSON** figé au premier passage. La question « quelle action va partir,
et quand ? » n'a **aucune réponse lisible en un seul endroit** : elle est répartie entre
`processIncoming` (qui pose `due_at`), le cron, `getEffectiveRelanceSteps` (override → snapshot
→ live) et les deux `check*Thread`. **C'est exactement la « logique un peu messy » signalée
dans le brief.**

**Coût actuel :** **ESTIMÉ (maintenabilité)** — le changement métier demandé (« notifier
l'équipe *en premier*, puis l'accusé et la relance ») **ne peut pas** être exprimé
proprement aujourd'hui : l'accusé est envoyé en dur à l'intake (`processIncoming`), et la
notif interne n'existe que comme *étape de la boucle pre_reply*, déclenchée **après** que
`due_at` (posé par l'accusé) soit dépassé. Inverser l'ordre exige de toucher `processIncoming`,
le calcul de `due_at`, l'ordre des `relance_steps`, et de re-vérifier le comptage — un
changement à blast-radius large sur un pipeline dont le CLAUDE.md répète « ne jamais risquer
d'emails en double/excessifs ». **Estimation : 1,5–3 j de dev + test à haut risque, à chaque
fois qu'on veut réordonner une séquence.**

**Problème :** la séquence d'actions est *implicite* (dérivée de compteurs + ancrages +
cron) au lieu d'être *déclarative*. Toute évolution d'ordonnancement est du code, pas de la
donnée.

**Solution (cible incrémentale, sans réécriture totale) :** matérialiser, par dossier, une
table d'**actions planifiées** avec un `fire_at` absolu et un `type` explicite — l'ordre
métier devient une donnée triée par `fire_at`.
```sql
CREATE TABLE thread_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  action_type TEXT NOT NULL,     -- 'notify_team' | 'accuse' | 'relance_interne' | 'relance_externe' | ...
  fire_at TEXT NOT NULL,         -- timestamp absolu calculé à la création du dossier
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'cancelled'
  created_at TEXT NOT NULL
);
CREATE INDEX idx_thread_actions_due ON thread_actions(status, fire_at);
```
Le scheduler devient une **unique** boucle : `SELECT ... WHERE status='pending' AND fire_at <= now ORDER BY fire_at`.
« Notifier l'équipe en premier » = insérer, à l'intake, une action `notify_team` à `fire_at = T0`,
avant l'action `accuse` à `T0+δ`. La détection de réponse (annulation des actions `pending`)
reste gérée par le comptage existant, mais devient un simple `UPDATE thread_actions SET
status='cancelled'`. **Migration douce :** garder les deux boucles actuelles en place, écrire
en parallèle la nouvelle table, basculer boucle par boucle une fois la parité prouvée par les
tests existants (`relanceCheck.test.ts`, `relanceSteps.test.ts`, `relanceBudget.test.ts`).

**Gain attendu :** « ce qui va partir et quand » lisible en une requête ; réordonnancement =
donnée ; **le besoin métier devient une config, pas un chantier**. Réduction estimée de
**2–4 j de friction/trimestre** sur les évolutions de séquence. **ESTIMÉ.**
**Effort :** **L** (> 2 j : nouvelle table, double-écriture, bascule prudente, tests).
**Risque :** **moyen/élevé** — pipeline d'emails en production, priorité absolue « pas de
doublon ». À faire derrière la double-écriture + parité de tests, jamais en big-bang.
**Vérification :** rejouer `test/relance*.test.ts` sur l'ancienne et la nouvelle voie et
exiger des sorties identiques (mêmes `recordReminder`/`step_type`) avant de retirer l'ancienne.

---

**[OPT-011] Découper `server.ts` (2304 lignes) par domaine**
**Axe :** Architecture / Maintenabilité | **Priorité : AJUSTEMENT**
**Localisation :** `src/web/server.ts`

**Situation actuelle :** un seul fichier de 2304 lignes mêle routing admin, rendu HTML,
logique OAuth, pages de config, `/consommation`, `/carnet`, etc.

**Coût actuel :** **ESTIMÉ** — pas un coût runtime (le rendu est instantané), mais un coût
d'onboarding : un nouveau développeur doit charger 2304 lignes pour situer une route. Le
CLAUDE.md le qualifie déjà de « huge ».

**Problème :** obésité de fichier → navigation lente, risque de conflit de merge, tests plus
durs à cibler.

**Solution :** extraire par domaine (`routes/dossiers.ts`, `routes/reglages.ts`,
`routes/consommation.ts`, `routes/oauth.ts`) en réutilisant `shared.ts`. Aucune logique
changée, pur découpage.
**Gain attendu :** temps de localisation d'une route divisé ; **aucun gain runtime**.
**Effort :** **M** (0,5–2 j, mécanique mais large). **Risque :** **faible** (déplacement pur,
couvert par les tests d'intégration existants).
**Vérification :** `npm test` + boot-check inchangés.

---

### AXE 5 — QUALITÉ & MAINTENABILITÉ

**Globalement bon — dette localisée, pas systémique.** Points positifs réels : typage strict
(pas d'`any` sauvage, `zod` sur les sorties Claude), commentaires « pourquoi » d'excellente
qualité (les gotchas sont documentés *dans le code*), tests réels dont plusieurs en DB isolée.

**Dette identifiée, à impact mesuré :**
- **Double-écriture `sla_hours` (legacy) + `sla_minutes` (vérité)** sur `threads` **et**
  `categories`, + `delay_hours`/`delay_minutes` sur `relance_steps` : chaque insertion doit
  renseigner les deux, toute nouvelle requête doit savoir laquelle lire. **Coût ESTIMÉ :**
  source garantie d'incohérence future à chaque nouvelle écriture. **Non recommandé de purger
  maintenant** (SQLite ne retire pas une colonne NOT NULL sans recréer la table — risque > gain
  au pilote). À planifier lors d'une future migration de fond. Documenté ici comme dette connue.
- **9 fonctions `ensure*Column` de migration additive** exécutées à **chaque démarrage**
  (`db.ts:258-269`), chacune faisant un `PRAGMA table_info`. **Coût :** quelques ms au boot,
  négligeable — **écarté** comme optimisation (§7), mentionné pour la lisibilité.

*Aucune recommandation bloquante sur cet axe : la qualité est au rendez-vous.*

---

### AXE 6 — SCALABILITÉ

**Ce qui casse à 10× / 100× (honnêtement) :**

| Composant | À 10× (≈ 500 emails/j) | À 100× (≈ 5 000 emails/j) |
|-----------|------------------------|----------------------------|
| N+1 Gmail séquentiel (OPT-001) | Cycle > intervalle → `pollInProgress` saute des cycles, retard de traitement | Ingérable ; **OPT-001 est le prérequis de toute montée** |
| `reminders` non indexée (OPT-006) | Dashboard client ralentit | Scans multi-ms à chaque vue |
| `maxExternalRelancesPerCycle=5` | Rattrapage lent après incident | File d'attente de relances jamais purgée |
| SQLite mono-instance | OK (le README le note) | Nécessite Postgres + vraie file d'attente |
| `discoverOutbound` re-scanne 25 SENT | idem N+1 | idem |

**État en mémoire = risque serverless :** `OBSERVED_SINCE` (`discoverOutbound.ts:19`) et les
verrous `*InProgress` (`scheduler.ts`) sont **en mémoire de process**. C'est **correct sur
Render** (instance unique always-on) mais **interdit toute mise à l'échelle horizontale** sans
externaliser cet état. **Pas une action au pilote** — à documenter comme contrainte
architecturale (elle l'est partiellement dans les commentaires).

**Conclusion axe 6 :** parfaitement dimensionné pour 1–2 boîtes. OPT-001 + OPT-006 sont les
deux verrous à lever *avant* toute montée en charge. Le reste (Postgres, file d'attente) est
prématuré — **écarté** au pilote (§7).

---

### AXE 7 — RÉSILIENCE & EXPLOITATION

**[OPT-008] Wrapper retry + backoff sur les appels connecteur (Gmail/Graph)**
**Axe :** Résilience | **Priorité : QUICK WIN**
**Localisation :** `src/connectors/gmailConnector.ts`, `src/connectors/graphConnector.ts`, `src/pipeline/errorTag.ts`

**Situation actuelle :** seuls les appels **Claude** retentent (`withRetry`, `structured.ts`).
Les appels Gmail/Graph (`sendReply`, `getThread`, `messages.get`…) n'ont **aucun retry** :
un 429 (rate-limit) ou 503 transitoire fait échouer le message, capturé par l'isolation
per-message (`scheduler.ts:37-42`) et re-tenté seulement au **cycle suivant** (2 min plus tard).

**Coût actuel :** **ESTIMÉ** — pour un accusé, 2 min de retard sur un transitoire est
acceptable ; mais pour un `sendReply` d'accusé qui échoue à mi-parcours (accusé parti,
`setThreadAckSent` non atteint), on peut re-déclencher. Surtout, le volume d'appels actuel
(OPT-001 non fait) **maximise** la probabilité de toucher un rate-limit.

**Problème :** dépendance externe critique (messagerie) sans dégradation gracieuse au niveau
appel. Un pic de 429 dégrade tout le cycle.

**Solution :** un helper `withBackoff` (exponentiel + jitter, 3 tentatives, uniquement sur
429/500/502/503) réutilisable, appliqué dans `tagSource` ou directement dans les connecteurs.
```ts
async function withBackoff<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const status = (e as { status?: number }).status ?? (e as { code?: number }).code;
      if (i >= tries - 1 || ![429, 500, 502, 503].includes(Number(status))) throw e;
      await new Promise((r) => setTimeout(r, 2 ** i * 500 + Math.random() * 250));
    }
  }
}
```
**Gain attendu :** absorption des transitoires sans attendre le cycle suivant ; robustesse
face au rate-limit. **ESTIMÉ.**
**Effort :** **S/M** (< 0,5 j). **Risque :** **faible** — ne retenter QUE les codes idempotents-safe ;
**ne pas** retenter un `sendReply` sur timeout ambigu (risque de double envoi — cohérent avec
la contrainte « jamais de doublon »). Limiter le backoff aux lectures + aux 429 explicites.
**Vérification :** injecter un 503 simulé et vérifier le rétablissement sans perte.

---

**[OPT-012] Observabilité minimale : logs structurés + corrélation par `thread_id`**
**Axe :** Exploitation | **Priorité : AJUSTEMENT**
**Localisation :** partout (`console.log`/`console.error`), `pipeline_errors` (table)

**Situation actuelle :** diagnostic = `console.log` en clair + table `pipeline_errors`
(consultable dans l'admin). Pas d'identifiant de corrélation transverse, pas de niveau de log.

**Coût actuel :** **ESTIMÉ** — question directrice de l'axe : « diagnostiquer un incident
client en < 10 min ? ». Aujourd'hui : possible mais laborieux (grep de logs Render +
`pipeline_errors`), car un même dossier apparaît sous `thread_id` dans certains logs et sous
`subject` dans d'autres. À 1–2 boîtes c'est gérable — **d'où le classement AJUSTEMENT, pas
priorité.**

**Problème :** pas de vue bout-en-bout d'une transaction (intake → accusé → relance → réponse).

**Solution :** logger en JSON une ligne par étape avec `{ thread_id, step_type, cycle_id }` ;
la table `reminders(step_type)` fournit déjà la traçabilité métier — il manque juste la
corrélation technique. Un simple préfixe `[thread_id]` homogène sur tous les `console.*`
suffit au pilote.
**Gain attendu :** temps de diagnostic incident réduit. **ESTIMÉ.**
**Effort :** **S** (homogénéiser les préfixes). **Risque :** **faible**.
**Vérification :** grep `<thread_id>` doit reconstituer toute l'histoire d'un dossier.

---

### AXE 8 — EXPÉRIENCE UTILISATEUR

**[OPT-010] Rafraîchissement admin & états de chargement sur actions manuelles**
**Axe :** UX | **Priorité : AJUSTEMENT**
**Localisation :** `src/web/server.ts` (actions `/dossiers/:id/traiter`, relance immédiate)

**Situation actuelle :** les actions manuelles (traiter, relancer immédiatement)
déclenchent des appels Claude + messagerie **synchrones** dans la requête HTTP. Sans état de
chargement, l'admin peut percevoir un gel de plusieurs secondes.

**Coût actuel :** **SUPPOSÉ** (non mesuré côté navigateur) — un `draftAcknowledgement` +
`sendReply` peut prendre 2–5 s ; sans retour visuel, risque de double-clic → double action.

**Problème :** latence perçue + risque de double-soumission sur une action à effet email.

**Solution :** désactiver le bouton au submit + spinner (quelques lignes de JS inline, sans
framework), ou passer l'action en asynchrone (statut « en cours » puis rafraîchissement).
Au minimum, un garde anti-double-submit côté serveur (déjà partiellement couvert par
`isMessageProcessed`).
**Gain attendu :** pas de double action, latence perçue maîtrisée. **ESTIMÉ.**
**Effort :** **S**. **Risque :** **faible**.
**Vérification :** double-clic rapide ne produit qu'une seule action email.

---

### AXE 9 — LEVIERS D'AUTOMATISATION & D'IA

**[OPT-005] Attribution par agent — préparer le dashboard « performance par employé » réellement demandé**
**Axe :** Automatisation / Modèle de données | **Priorité : CHANTIER**
**Localisation :** modèle `threads` (pas de notion d'agent), détection réponse humaine `relanceCheck.ts:155-174`

**Situation actuelle :** le contexte métier demande explicitement un dashboard « pour savoir
quel employé est le moins performant via la façon dont les emails sont traités ». **Or le
système ne capture aucune notion d'agent.** La détection de réponse humaine se fait par
**comptage** (`automated_outbound_count` vs messages `isFromUs`) sur une **boîte partagée** :
on sait *qu'un* humain a répondu et *quand* (`human_replied_at`), donc on peut mesurer un
**délai de réponse global**, mais **jamais *qui*** a répondu.

**Coût actuel :** **MESURÉ (par absence)** — le livrable central du dashboard promis
(classement des employés) est **structurellement irréalisable** avec le modèle actuel. Ce
n'est pas une lenteur, c'est un **trou de capacité** : construire le dashboard tel que
décrit échouerait faute de donnée.

**Problème :** boîte partagée + détection par comptage = pas d'axe « agent ». `human_replied_at`
et le délai moyen (`getClientMonthlyStats`) existent déjà, mais anonymes.

**Solution (incrémentale) :** capturer l'expéditeur du message humain détecté et le rattacher
à un agent.
1. Dans `checkPreReplyThread`, quand `replyAfterAck` est détecté, `replyAfterAck.from.email`
   est **déjà disponible** — le persister (`threads.responder_email`, ou une table
   `thread_responses(thread_id, responder_email, replied_at, delay_minutes)`).
2. Table de correspondance `agents(email, display_name)` (config simple, réutilise
   `categories.json` comme modèle).
3. Le dashboard agrège alors **délai moyen de réponse par agent**, **nombre de dossiers
   traités**, **taux de relances internes déclenchées avant réponse** (déjà dans `reminders.step_type`
   = `relance_interne`, proxy direct de « a laissé traîner »).
> **Anti-gadget :** aucune IA nécessaire ici. C'est de la **donnée** (qui + quand), pas du LLM.
> Ajouter une couche IA pour « juger la performance » serait un cargo cult coûteux : les
> métriques objectives (délai, nb de relances internes subies) suffisent et sont défendables
> auprès des employés. **L'IA reste à sa juste place : classer et rédiger.**

**Gain attendu :** **débloque le livrable métier** annoncé au client. Valeur produit directe,
pas une micro-optimisation. **ESTIMÉ (valeur), MESURÉ (faisabilité : la donnée expéditeur est
déjà là).**
**Effort :** **M/L** (0,5–2 j pour la capture + table agents ; +1–2 j pour les vues dashboard).
**Risque :** **moyen** — sur boîte partagée, un même agent peut répondre depuis un alias ;
prévoir une correspondance email→agent tolérante. Attention RH/éthique : un classement
« moins performant » doit reposer sur des métriques défendables (délai, charge) et non sur
une note IA opaque.
**Vérification :** rejouer un fil réel où l'agent A répond → `thread_responses` capture
`A@…` + délai ; le dashboard le classe correctement.

---

**Bon usage actuel de l'IA (à conserver) :** classification et rédaction sont exactement là où
un LLM apporte de la valeur non triviale (langue variable, ton, continuité). Le pipeline évite
déjà le sur-coût en envoyant `formatSingleMessage` (un seul message) plutôt que tout le fil
pour classify/accusé/relance (`prompts.ts:43`), et en désactivant les 3 brouillons par défaut.
**Rien à sur-automatiser ici.**

---

## 4. MATRICE IMPACT × EFFORT

```
IMPACT
  ▲
É │  OPT-004 (timeline actions)          OPT-005 (attribution agent)
L │  ← débloque le métier                ← débloque le dashboard promis
E │
V │  OPT-001 (dédup Gmail N+1)  ·  OPT-003 (prompt caching)
É │  OPT-008 (retry/backoff)    ·  OPT-002 (fenêtre `q`)
  │
──┼───────────────────────────────────────────────────────────────►
  │  OPT-006 (index reminders)  OPT-010 (UX loading)    OPT-011 (découpe server.ts)
F │  OPT-007 (WAL)              OPT-012 (logs corrélés)
A │
I │        (aucune recommandation en piège — voir §7)
B │
L │
E │
    FAIBLE ───────────── EFFORT ───────────────── ÉLEVÉ
```

| ID | Titre | Axe | Impact | Effort | Risque | Priorité |
|----|-------|-----|--------|--------|--------|----------|
| OPT-001 | Dédup Gmail avant fetch (N+1) | Perf | Élevé | S | Faible | **QUICK WIN** |
| OPT-002 | Fenêtre `q` Gmail (`is:unread`) | Perf | Moyen | S | Moyen | **QUICK WIN** |
| OPT-003 | Prompt caching accusé/relance | Coût/IA | Moyen | S | Faible | **QUICK WIN** |
| OPT-008 | Retry+backoff connecteurs | Résilience | Moyen-Élevé | S/M | Faible | **QUICK WIN** |
| OPT-004 | Timeline d'actions dues | Archi | Élevé | L | Moyen/Élevé | **CHANTIER** |
| OPT-005 | Attribution par agent | IA/Data | Élevé | M/L | Moyen | **CHANTIER** |
| OPT-006 | Index `reminders(thread_id)` | Perf | Faible (→Élevé à terme) | S | Faible | **AJUSTEMENT** |
| OPT-007 | WAL + pragmas | Perf | Faible | S | Faible | **AJUSTEMENT** |
| OPT-009 | Paralléliser `getThread`/`get` | Perf | Faible-Moyen | S | Faible | **AJUSTEMENT** (inclus dans OPT-001) |
| OPT-010 | États de chargement UI | UX | Faible-Moyen | S | Faible | **AJUSTEMENT** |
| OPT-011 | Découper `server.ts` | Maint. | Faible | M | Faible | **AJUSTEMENT** |
| OPT-012 | Logs corrélés `thread_id` | Exploit. | Faible-Moyen | S | Faible | **AJUSTEMENT** |

---

## 5. FEUILLE DE ROUTE EN 3 VAGUES

### Vague 1 — cette semaine (QUICK WINS) · charge ≈ 1,5–2 j
- **OPT-001** dédup Gmail (S) · **OPT-002** fenêtre `q` (S) · **OPT-003** prompt caching (S) · **OPT-008** retry/backoff (S/M).
- **Gain cumulé :** cycle de scrutation **−70 à −85 % de latence** (régime permanent),
  **−95 % d'appels Gmail**, **~10–20 $/mois** de tokens Claude, robustesse rate-limit.
  Tout mesurable (§8).

### Vague 2 — ce mois (CHANTIERS structurants + ajustements groupés) · charge ≈ 4–7 j
- **OPT-004** timeline d'actions dues (L) — **débloque « notifier l'équipe en premier »**.
- **OPT-005** attribution par agent (M/L) — **débloque le dashboard de performance**.
- Grouper : **OPT-006** (index) + **OPT-007** (WAL) + **OPT-012** (logs) + **OPT-010** (UI loading) — ~1 j cumulé.
- **Gain cumulé :** les deux évolutions métier promises deviennent réalisables ; dette de
  scalabilité levée avant montée en charge.

### Vague 3 — ce trimestre (VISION CIBLE) · charge ≈ 3–5 j
- **OPT-011** découpe `server.ts` (M).
- Convergence vers la cible §6 : timeline unique adoptée comme source unique de vérité,
  retrait progressif de la double-écriture `sla_hours`/`delay_hours` lors d'une migration
  planifiée, préparation Postgres **uniquement si** un 2ᵉ client/instance se profile.
- **Gain cumulé :** base prête pour la version « interface » multi-clients sans réécriture.

---

## 6. VISION CIBLE ET CHEMIN DE MIGRATION (Phase 2)

### « Si je réécrivais ce système aujourd'hui »

**Je ne le réécrirais pas.** Le socle est sain pour le cas d'usage : Node/TS, SQLite
in-process, HTML serveur, connecteurs derrière une interface `EmailConnector`, IA cantonnée
au classer/rédiger. Une réécriture (Next.js, Postgres, microservices, file d'attente
managée) serait un **cargo cult** au regard de 1–2 boîtes. La cible n'est pas une nouvelle
stack, c'est **le même système avec un cœur d'ordonnancement explicite.**

**Les 3 déplacements structurants de la cible :**

1. **Une timeline d'actions par dossier (OPT-004) comme unique source de vérité
   d'ordonnancement.** Fini les deux boucles + compteurs + snapshots comme *mécanisme* : le
   comptage reste pour *détecter* la réponse humaine, mais « quoi envoyer, quand, dans quel
   ordre » vit dans `thread_actions(fire_at, action_type)`. « Notifier l'équipe en premier »,
   « accusé après X min », « relance après Y » deviennent des lignes de données. Un seul
   `SELECT ... WHERE fire_at <= now` pilote tout le scheduler.

2. **Une dimension « agent » de première classe (OPT-005).** `thread_responses(responder_email,
   replied_at, delay)` + table `agents`. Le dashboard de performance devient une agrégation
   SQL triviale, sans IA. C'est le livrable métier annoncé.

3. **Une couche connecteur uniformément résiliente (OPT-008) et non-N+1 (OPT-001).** Le
   Graph est déjà propre ; aligner Gmail dessus (batch/dédup + backoff) rend les deux
   connecteurs interchangeables *et* économes — prérequis de la cible production Outlook.

### Chemin incrémental (sans big-bang)

```
Existant ──①──► ②──► ③──► Cible
① Vague 1 : connecteurs propres (OPT-001/002/008) + caching (003)   [aucun changement de modèle]
② Vague 2 : double-écriture thread_actions en parallèle des 2 boucles, parité prouvée par tests,
            puis bascule boucle par boucle ; capture responder_email (OPT-005)
③ Vague 3 : thread_actions = source unique, retrait des 2 boucles ; migration douce de la
            double-écriture sla_hours/delay_hours ; Postgres seulement si multi-instances
```
Chaque étape est livrable seule, testable via la suite existante, et réversible. À aucun
moment le pipeline d'emails en production n'est arrêté ou réécrit en bloc — conforme à la
contrainte « jamais d'emails en double/excessifs ».

---

## 7. RECOMMANDATIONS ÉCARTÉES (preuve de rigueur)

| Écarté | Pourquoi (à CE contexte : 1–2 boîtes, SQLite, HTML serveur) |
|--------|--------------------------------------------------------------|
| **Index sur `threads(status)` / `threads(due_at)`** | À quelques centaines/milliers de lignes, un full-scan SQLite in-process est < 1 ms. **Gain démontré ≈ 0 aujourd'hui.** À reconsidérer à 100×, pas avant. Ajouter un index par principe = complexité sans gain. |
| **Migrer SQLite → Postgres/Supabase maintenant** | Mono-instance always-on : SQLite est *optimal* (0 latence réseau, 0 egress, 0 $). Le README le documente déjà. Postgres = latence + coût + egress pour zéro bénéfice au pilote. Uniquement si multi-instances. |
| **Réécrire le front en React/Next.js (SSR/RSC/streaming)** | Dashboard 1–2 utilisateurs, HTML serveur < 50 ms. Un bundle JS, de l'hydratation, du code-splitting = **régression** de complexité et de perf. L'axe 2 est déjà vert. |
| **Statements SQLite préparés au niveau module** | Re-`prepare()` coûte < 1 ms, appelé quelques dizaines de fois/cycle. Gain sous le bruit de mesure. Micro-optimisation classique **sans gain mesurable ici** — n'ajoute que du risque de statement partagé mal réinitialisé. |
| **Pipeline d'observabilité (OpenTelemetry, APM, tracing distribué)** | 1 process, 2 boîtes. `console` + `pipeline_errors` + corrélation `thread_id` (OPT-012, léger) couvrent le besoin. Un APM serait de l'outillage enterprise sur un mono-service. |
| **File d'attente managée (SQS/BullMQ) pour les envois** | Le cap `maxExternalRelancesPerCycle` + les verrous `*InProgress` suffisent au volume actuel. Une vraie file ne se justifie qu'à 10–100×. |
| **Purger la double-écriture `sla_hours`/`delay_hours` immédiatement** | SQLite ne supprime pas une colonne NOT NULL sans recréer la table → migration destructive risquée sur une base de production. Le **risque dépasse le gain** au pilote. À planifier, pas à précipiter (documenté en dette, axe 5). |
| **Batch Gmail via `messages.batchGet` / History API** | Séduisant, mais OPT-001 (dédup + `Promise.all`) capture déjà l'essentiel du gain pour un effort **S** et un risque **faible**. La History API ajoute de la complexité d'état (`historyId` à persister) pour un gain marginal **à ce volume**. À reconsidérer seulement si OPT-001 s'avère insuffisant à 10×. |

---

## 8. PROTOCOLE DE MESURE (ligne de base AVANT / vérification APRÈS)

> Sans ligne de base, aucun gain n'est prouvable. Exécuter ces commandes **avant** tout
> changement, conserver les valeurs, ré-exécuter **après**.

### Protocole A — Appels Gmail par cycle (valide OPT-001/002/009)
Instrumentation temporaire (compteur en mémoire) autour de `messages.get`/`messages.list`
dans `gmailConnector.ts`, puis lire les logs Render sur 10 cycles :
```bash
# Compter les GET Gmail émis sur une fenêtre de 20 min (10 cycles) dans les logs Render :
#   attendu AVANT : ~26/cycle (poll) + ~26/cycle (discover)
#   attendu APRÈS : ~1–2/cycle en régime permanent
# (à défaut d'instrumentation, activer le logging debug de googleapis :)
NODE_DEBUG=googleapis npm run dev:all 2>&1 | grep -c "messages/.*?format=full"
```

### Protocole B — Latence d'un cycle de scrutation (valide OPT-001)
```bash
# Ajouter temporairement en tête/fin de pollInbox : const t0 = Date.now(); ... console.log(`[poll] ${Date.now()-t0}ms`);
# Relever la médiane sur 10 cycles AVANT / APRÈS. Attendu : plusieurs secondes → < 500 ms.
```

### Protocole C — Coût & tokens Claude (valide OPT-003)
Requête directe sur la base (source de vérité `ai_usage_events`) :
```bash
sqlite3 /var/data/app.db "
  SELECT call_type,
         COUNT(*) AS appels,
         SUM(input_tokens)  AS in_tok,
         SUM(output_tokens) AS out_tok,
         ROUND(SUM(input_tokens)/1e6*3 + SUM(output_tokens)/1e6*15, 4) AS cout_usd
  FROM ai_usage_events
  WHERE created_at >= strftime('%Y-%m-01', 'now')
  GROUP BY call_type ORDER BY cout_usd DESC;"
# Relever in_tok par call_type AVANT / APRÈS activation du caching, à trafic comparable (48 h).
# Attendu : -25 à -40 % sur in_tok des call_type 'accuse_reception' et 'relance_*'.
```
(Équivalent sans shell : page **/consommation** de l'admin.)

### Protocole D — Plans de requête (valide OPT-006)
```bash
sqlite3 /var/data/app.db "EXPLAIN QUERY PLAN
  SELECT 1 FROM reminders WHERE thread_id='x' AND step_type='accuse' LIMIT 1;"
# AVANT : SCAN reminders   |   APRÈS (index créé) : SEARCH reminders USING INDEX idx_reminders_thread
```

### Protocole E — Non-régression fonctionnelle (obligatoire avant tout merge)
```bash
NODE_OPTIONS="--max-old-space-size=4096" node ./node_modules/typescript/bin/tsc --noEmit
npm test    # relance*.test.ts, processIncoming, discoverOutbound, shadowModeRelance = filet de sécurité pipeline
```

---

### Mot de la fin

Ce système n'a pas besoin d'être « rendu rapide » — à son échelle il l'est déjà. Il a besoin
de **deux choses honnêtes** : arrêter de gaspiller des appels Gmail (Vague 1, effort faible,
gain mesurable immédiat), et **rendre explicite son cœur d'ordonnancement** (Vague 2) pour que
les deux évolutions métier réellement demandées — *notifier l'équipe en premier* et *mesurer la
performance par employé* — cessent d'être des chantiers à haut risque pour devenir de simples
données. Tout le reste est soit déjà bon, soit du cargo cult explicitement écarté.
