# AUDIT DE CORRECTNESS — mailau (Accusé & Relance)

**Date :** 2026-07-23
**Périmètre :** `src/` (pipeline, db, connecteurs, web), lecture seule — aucun fichier de code modifié.
**Auditeur :** Staff Engineer, spécialité correctness.
**Méthode :** reconstruction d'intention → chasse systématique (11 catégories) → simulation des chemins critiques. Chaque bug affirmé est accompagné d'une trace d'exécution ; ce qui ne se déroule pas jusqu'au bout est classé en *suspicion*.

---

## 1. SYNTHÈSE EXÉCUTIVE

**Verdict de fiabilité :** le cœur d'envoi (accusé / relance / anti-rafale / dédup) est solide et bien gardé ; **les bugs réels ne sont pas dans les emails envoyés mais dans les métriques temporelles** — précisément celles sur lesquelles le dashboard de performance équipe (l'objet même de la commande) va s'appuyer.

**Note de correctness : 78 / 100.**
Méthode : base 100, −8 par bug MAJEUR silencieux touchant un chemin critique (×2 = −16), −2 par MINEUR (×2 = −4), −0 pour LATENT rare documenté, −2 pour la dette « pas de garde `Math.max(0)` systématique sur les durées ». Le pipeline d'envoi ne perd aucun point : ses invariants anti-doublon tiennent.

### Tableau des bugs par classification

| Gravité   | Nombre | IDs |
|-----------|--------|-----|
| BLOQUANT  | 0      | —   |
| MAJEUR    | 2      | BUG-001, BUG-002 |
| MINEUR    | 2      | BUG-003, BUG-005 |
| LATENT    | 1      | BUG-004 |

*(Aucun bug bloquant : aucun chemin ne produit d'email dupliqué/excessif au client ni de perte de données de façon certaine. C'est la bonne nouvelle de cet audit.)*

### Les 3 bugs qui vont réellement faire mal

1. **BUG-001 — Le délai de réponse de l'équipe est mesuré à l'instant où le pipeline *détecte* la réponse, pas à l'instant où l'équipe a *réellement* répondu.** Le futur dashboard « quel employé est le moins performant » sera bâti sur une horloge qui compte le temps de latence du cron (et tout downtime du scheduler) comme du temps de traitement humain. Coût métier : on va sanctionner des employés sur du bruit d'infrastructure, et le chiffre « délai moyen » affiché au client est systématiquement surévalué.

2. **BUG-002 — La moyenne « délai de réponse » du dashboard client intègre des valeurs négatives** pour tout dossier créé par la découverte des envois sortants (`discoverOutbound`). Coût métier : le KPI le plus visible du client peut afficher une moyenne aberrante (tirée vers le bas, voire négative) sans qu'aucune erreur ne soit levée.

3. **BUG-004 — Course entre `discoverOutbound` et `pollInbox`** : si l'équipe répond à la main *avant* que la boîte n'ait été scrutée, le dossier peut naître en phase « post-réponse » puis être réécrit en « reçu », laissant un état incohérent (statut pré-réponse + `human_replied_at` déjà posé). Rare mais salissant pour les métriques du même dossier.

> **Remarque de cadrage (hors bug, mais central).** Le brief indique un changement récent : *« notifier l'équipe du retard d'abord, puis l'accusé et la relance »*. Le pipeline actuel fait l'inverse dans l'ordre : l'**accusé part immédiatement à l'intake** (`processIncoming`), et le **rappel interne ne se déclenche que plus tard** (à l'échéance SLA + délai d'étape). Ce n'est pas un défaut d'implémentation par rapport au code écrit — c'est un **écart entre l'intention métier exprimée et ce que le code fait**. Voir §5 (Spécifications manquantes), question SPEC-1 : c'est très probablement la « logique messy » que vous ressentez.

---

## 2. INTENTION RECONSTITUÉE

### Ce que le programme est censé faire
Automatiser le suivi d'emails d'un transitaire (1-2 boîtes) : accuser réception, relancer, notifier l'équipe des retards, et donner un dashboard de suivi. Deux phases par dossier :
- **pre_reply** : personne dans l'équipe n'a répondu au fond → on nudge l'équipe (interne) puis on rassure le client (externe).
- **post_reply** : un humain a répondu (ex. devis) → on attend le client, et on le relance s'il se tait.

### Invariants métier identifiés
- **INV-1** — Jamais d'email dupliqué / excessif / déroutant au client (contrainte permanente, répétée). *Tenu* : dédup par `processed_messages`, budget `maxExternalRelancesPerCycle`, mode carnet.
- **INV-2** — « Humain ou automate ? » se décide par **comptage** (`automated_outbound_count`), jamais par contenu/id. *Tenu* (avec filtre DRAFT dans les connecteurs).
- **INV-3** — Les statuts pre_reply et post_reply ne collisionnent jamais. *Tenu* : ensembles disjoints (`ack_sent/drafts_ready/relance_sent` vs `awaiting_client_reply/post_reply_relance_sent`).
- **INV-4** — Délais d'étapes strictement croissants dans une séquence. *Tenu* : `clampAfterLastStep`.
- **INV-5** — Le dashboard client n'expose jamais coût IA, ids techniques, config de relance, journal d'erreurs. *Tenu* : projections dédiées en bas de `db.ts`.
- **INV-6** — Une durée affichée à un humain est **≥ 0** et exprimée dans le bon fuseau. *Violé* dans un calcul (BUG-002) et fragile ailleurs (dette §6).
- **INV-7** — Un délai de traitement mesuré doit refléter le temps **réel** entre la demande et l'action humaine, pas la latence du pipeline. *Violé* (BUG-001).

### Chemins critiques
- **CC-1** : email entrant → classification → accusé → phase pre_reply.
- **CC-2** : boucle pre_reply → rappel interne → relance externe → détection réponse humaine → bascule post_reply.
- **CC-3** : boucle post_reply → relance client → détection réponse client → `responded`.
- **CC-4** : découverte d'un envoi à froid → dossier post_reply.
- **CC-5** : calcul des KPI du dashboard client (délai moyen, relances, en cours/résolus).
- **CC-6** : mode carnet (semaine pilote) — rien de réel au client, seul le rappel interne part.

---

## 3. BUGS DÉTAILLÉS

---

### [BUG-001] Le délai de réponse de l'équipe est ancré à l'instant de DÉTECTION, pas à l'instant réel de la réponse
**Gravité : MAJEUR | Probabilité : certaine | Détectabilité : silencieux (remontée d'un cran → traité comme MAJEUR)**
**Localisation :** `src/pipeline/relanceCheck.ts:161-177` (appel `setThreadHumanReplied` ligne 174).

**Code fautif :**
```ts
const replyAfterAck =
  row.ack_sent_at !== null && ourMessages.length > row.automated_outbound_count
    ? ourMessages[ourMessages.length - 1]
    : undefined;

if (replyAfterAck) {
  recordHumanReplyCorpus({ /* ... */ });
  // repliedAt = undefined  ->  setThreadHumanReplied pose human_replied_at = now()
  setThreadHumanReplied(row.thread_id, undefined, replyAfterAck.hasAttachments);
  await cleanupUnusedDrafts(connector, row.thread_id);
  return;
}
```
`setThreadHumanReplied` (`db.ts:742`) : `const humanRepliedAt = repliedAt ?? now;`. Comme `checkPreReplyThread` passe `undefined`, on écrit **l'heure de détection**. Or l'heure réelle est disponible dans `replyAfterAck.receivedAt` (le champ existe, cf. `EmailMessage.receivedAt`) et **n'est pas utilisée**.

**Trace d'exécution :**
1. `received_at` = 10:00. Accusé envoyé, `automated_outbound_count = 1`, `ack_sent_at` posé.
2. L'employé répond réellement à **10:20** (message `isFromUs=true` dans le fil).
3. Le scheduler tourne toutes les 2 min ; le cycle qui *voit* cette réponse s'exécute à **10:22** (ou plus tard si le process a redémarré / a pris du retard).
4. `ourMessages.length` (2 : accusé + réponse) `> automated_outbound_count` (1) → `replyAfterAck` = la réponse.
5. `setThreadHumanReplied(threadId, undefined, ...)` → `human_replied_at = 10:22`.
6. Dashboard : délai équipe = `human_replied_at − received_at` = **22 min** au lieu de **20 min**.

**Comportement attendu :** délai mesuré = `replyAfterAck.receivedAt − received_at` = 20 min.
**Comportement obtenu :** délai = `now − received_at`, gonflé de `[0 ; intervalle_cron + retard_scheduler]`. Après un downtime du planificateur (déploiement, veille du conteneur), l'inflation peut atteindre plusieurs heures.

**Reproduction :** boîte connectée, un email entrant accusé ; répondre à la main ; arrêter le process 30 min ; le relancer → `human_replied_at` = heure du redémarrage, pas heure de la réponse. Le `delayLabel` client et `delaiMoyenReponseMinutes` s'en trouvent faussés.

**Impact métier :** c'est **la** métrique du dashboard demandé (« quel employé traite le moins bien »). Elle compte la latence d'infrastructure comme du temps humain → classement des employés biaisé, et chiffre « délai moyen » surévalué montré au client.

**Correction proposée :**
```ts
if (replyAfterAck) {
  recordHumanReplyCorpus({ /* ... */ });
  setThreadHumanReplied(
    row.thread_id,
    replyAfterAck.receivedAt.toISOString(), // ancrage sur l'heure RÉELLE de la réponse
    replyAfterAck.hasAttachments
  );
  await cleanupUnusedDrafts(connector, row.thread_id);
  return;
}
```
`setThreadHumanReplied` accepte déjà un `repliedAt` optionnel (utilisé par `discoverOutbound`) — aucune signature à changer.

**Test de non-régression :**
```ts
test("human reply is anchored to the message's real receivedAt, not detection time", async () => {
  const replyTime = new Date(Date.now() - 20 * 60_000); // il y a 20 min
  const received = new Date(Date.now() - 40 * 60_000);
  // dossier accusé à 'received', automated_outbound_count = 1
  seedThread({ threadId: "t1", received_at: received.toISOString(), ack_sent_at: received.toISOString(),
               automated_outbound_count: 1, status: "ack_sent" });
  const connector = fakeConnector({ threads: { t1: { messages: [
    fakeMessage({ id: "ack", threadId: "t1", isFromUs: true, receivedAt: received }),
    fakeMessage({ id: "human", threadId: "t1", isFromUs: true, receivedAt: replyTime }),
  ] } } });
  await checkPreReplyThread(connector, getThreadRow("t1")!, undefined);
  const row = getThreadRow("t1")!;
  assert.equal(row.human_replied_at, replyTime.toISOString()); // pas Date.now()
});
```
**Effort : S | Risque de régression :** faible (un seul appel ; `discoverOutbound` déjà sur ce modèle).

---

### [BUG-002] La moyenne de délai du dashboard client intègre des valeurs NÉGATIVES (dossiers découverts en sortie)
**Gravité : MAJEUR | Probabilité : fréquente (dès qu'un envoi à froid existe) | Détectabilité : silencieux**
**Localisation :** `src/db.ts:1670-1680` (`getClientMonthlyStats`).

**Code fautif :**
```ts
const delays = db.prepare(
  "SELECT received_at, human_replied_at FROM threads WHERE received_at >= ? AND human_replied_at IS NOT NULL"
).all(monthStartIso) as Array<{ received_at: string; human_replied_at: string }>;
const avgMinutes = delays.length
  ? delays.reduce(
      (sum, r) => sum + (new Date(r.human_replied_at).getTime() - new Date(r.received_at).getTime()) / 60_000,
      0
    ) / delays.length
  : null;   // <-- aucun Math.max(0, ...) ; aucune exclusion des dossiers découverts
```

**Trace d'exécution :**
1. `discoverOutbound` traite un devis envoyé à froid à **09:00** (`message.receivedAt = 09:00`).
2. `registerIfNewThread` → `upsertThreadReceived(...)` : l'INSERT pose **`received_at = now`** (instant de découverte, ex. **09:03**), voir `db.ts:621` (`const now = new Date().toISOString()` puis colonne `received_at`).
3. Puis `setThreadHumanReplied(threadId, sentAt /* = 09:00 */, ...)` pose `human_replied_at = 09:00`.
4. État : `received_at = 09:03`, `human_replied_at = 09:00`.
5. Dans `getClientMonthlyStats` : terme = `(09:00 − 09:03)/60000` = **−3 min**.
6. Ce terme négatif entre dans la moyenne sans être borné.

Confirmé par `test/discoverOutbound.test.ts:61` (`human_replied_at === sentAt.toISOString()`) combiné au fait que `received_at` est toujours l'instant d'insertion.

**Comportement attendu :** la moyenne ne descend jamais sous 0 ; idéalement, les dossiers « découverts en sortie » (jamais entrants) sont exclus du délai de réponse *à un email client* — leur `received_at` n'a pas la même sémantique (c'est une heure de découverte, pas une heure de réception d'un email client).
**Comportement obtenu :** moyenne tirée vers le bas, potentiellement négative, affichée telle quelle au client.

**Reproduction :** partir d'une base propre ce mois-ci ; laisser `discoverOutbound` enregistrer un seul envoi à froid ; ouvrir le dashboard client → « délai moyen de réponse » incohérent (peut être négatif si peu d'autres dossiers).

**Impact métier :** KPI phare du client faussé silencieusement. Combiné à BUG-001, la métrique de délai est doublement peu fiable.

**Correction proposée** (deux volets — borne + sémantique) :
```ts
// 1) Exclure les dossiers dont received_at est postérieur à human_replied_at
//    (dossiers découverts en sortie : received_at = heure de découverte, pas
//    d'email client reçu) ET borner à 0 par sécurité.
const avgMinutes = delays.length
  ? (() => {
      const positives = delays
        .map((r) => (new Date(r.human_replied_at).getTime() - new Date(r.received_at).getTime()) / 60_000)
        .filter((m) => m >= 0);
      return positives.length ? positives.reduce((s, m) => s + m, 0) / positives.length : null;
    })()
  : null;
```
*(Alternative plus nette : marquer les dossiers issus de `discoverOutbound` — p. ex. une colonne `origin='outbound'` — et les exclure de ce calcul par une clause SQL. Décision métier : voir SPEC-2.)*

**Test de non-régression :**
```ts
test("monthly avg delay ignores discovered-outbound negative spans", () => {
  // dossier normal : reçu il y a 60 min, répondu il y a 30 min -> +30
  seedThread({ threadId: "in", received_at: iso(-60), human_replied_at: iso(-30), status: "awaiting_client_reply" });
  // dossier découvert en sortie : received_at = maintenant, human_replied_at = il y a 5 min -> -5
  seedThread({ threadId: "out", received_at: iso(0), human_replied_at: iso(-5), status: "awaiting_client_reply" });
  const stats = getClientMonthlyStats();
  assert.equal(stats.delaiMoyenReponseMinutes, 30); // et surtout : jamais < 0
});
```
**Effort : S | Risque de régression :** faible.

---

### [BUG-003] Un vrai email client dont l'objet commence par « [Rappel] » est ignoré et jamais accusé
**Gravité : MINEUR | Probabilité : rare | Détectabilité : silencieux**
**Localisation :** `src/pipeline/processIncoming.ts:37-40`.

**Code fautif :**
```ts
if (message.subject.startsWith("[Rappel]")) {
  markMessageProcessed(message.id, message.threadId);
  return;
}
```
Le garde-fou vise nos propres notifications internes (préfixe exact `"[Rappel] 🚨 …"`). Mais il matche **tout** objet commençant par `[Rappel]`, quelle qu'en soit l'origine.

**Trace d'exécution :**
1. Un client (ou un partenaire) envoie un email dont l'objet est, par ex., `"[Rappel] Facture 2024-0012 impayée"`.
2. `message.isFromUs` = false ; `isMessageProcessed` = false.
3. `startsWith("[Rappel]")` = true → marqué traité, `return`.
4. Aucune classification, aucun accusé, aucun dossier exploitable : le dossier disparaît du pipeline.

**Comportement attendu :** ne filtrer que **nos** rappels — reconnaissables par le fait qu'ils sont `isFromUs` (auto-adressés) ou par un marqueur non usurpable, pas par un préfixe d'objet qu'un tiers peut employer.
**Comportement obtenu :** faux positif silencieux sur un objet client légitime.

**Reproduction :** s'envoyer (depuis une autre adresse) un email `[Rappel] test` vers la boîte connectée → jamais accusé, invisible sur `/carnet` (aucune `recordClassification`).

**Impact métier :** un email client à l'objet malencontreux est perdu par l'automatisation. Faible probabilité, mais 100 % silencieux et contraire à INV-1 (le client attend un accusé qui ne viendra pas). Note : le préfixe « [Rappel] » est un vocabulaire courant côté relances de facture — pas si improbable chez un transitaire.

**Correction proposée :**
```ts
// Nos rappels sont auto-adressés : ils sont isFromUs. Un email entrant d'un
// tiers n'est jamais isFromUs -> ne jamais le filtrer sur le seul préfixe.
if (message.isFromUs && message.subject.startsWith("[Rappel]")) {
  markMessageProcessed(message.id, message.threadId);
  return;
}
```
*(Le `if (message.isFromUs) return;` en tête de fonction couvre déjà le cas où l'écho Inbox est correctement marqué `isFromUs` ; ce garde-fou ne sert que lorsque le fournisseur ne le marque pas ainsi. Restreindre à `isFromUs` conserve l'intention sans avaler d'emails tiers. À valider : voir SPEC-3, car sur certains fournisseurs la copie Inbox auto-adressée peut ne pas être `isFromUs`.)*

**Test de non-régression :**
```ts
test("incoming third-party email with [Rappel] subject is still processed", async () => {
  const msg = fakeMessage({ id: "x", subject: "[Rappel] Facture impayée", isFromUs: false });
  await processIncomingMessage(fakeConnector(...), msg);
  assert.ok(getThreadRow(msg.threadId)); // un dossier a bien été créé
});
```
**Effort : S | Risque de régression :** moyen — dépend du comportement `isFromUs` de la copie auto-adressée (tester Gmail ET Graph avant de livrer).

---

### [BUG-004] Course `discoverOutbound` / `pollInbox` : un dossier peut naître en post_reply puis être réécrit en « reçu » (état incohérent)
**Gravité : LATENT | Probabilité : occasionnelle | Détectabilité : silencieux**
**Localisation :** interaction `src/pipeline/discoverOutbound.ts:51-93` × `src/pipeline/processIncoming.ts:69-88` × `src/db.ts:610-651` (`upsertThreadReceived` ON CONFLICT).

**Code fautif (le ON CONFLICT n'efface pas `human_replied_at`) :**
```sql
ON CONFLICT(thread_id) DO UPDATE SET
  subject = excluded.subject,
  category_id = excluded.category_id,
  urgency = excluded.urgency,
  sla_hours = excluded.sla_hours,
  sla_minutes = excluded.sla_minutes,
  status = excluded.status,   -- repasse à 'received'
  due_at = excluded.due_at,
  updated_at = excluded.updated_at
-- human_replied_at, post_reply_relance_count, ack_sent_at : NON réinitialisés
```

**Trace d'exécution :**
1. Un email client arrive à 09:00 mais n'a pas encore été scruté (`pollInbox` n'a pas tourné).
2. L'équipe répond à la main à 09:01 depuis la boîte.
3. `discoverOutbound` (même cadence cron) voit la réponse dans « Envoyés » ; `getThreadRow` = `undefined` (le dossier n'existe pas encore) → `registerIfNewThread` crée le dossier en `awaiting_client_reply`, `human_replied_at = 09:01`, `sender_email = le client` (destinataire).
4. `pollInbox` tourne ensuite, traite l'email entrant, appelle `upsertThreadReceived` avec `status='received'`, `due_at = now+SLA` → **ON CONFLICT** : le statut repasse `received`, mais `human_replied_at` reste `09:01`.
5. État final incohérent : `status='received'` (phase pré-réponse) **et** `human_replied_at` déjà posé. `shouldAcknowledge` → accusé envoyé → `status='ack_sent'`. Le dossier réintègre la boucle pre_reply *avec* `human_replied_at` non nul.
6. Au cycle pre_reply suivant, `ourMessages.length` (réponse équipe + accusé = 2) `> automated_outbound_count` (1) → détection « réponse humaine » qui prend `ourMessages[last]` = **l'accusé** (le plus récent) et **ré-ancre** `human_replied_at` sur l'accusé. Bruit métrique et corpus (`recordHumanReplyCorpus`) pollué par le texte de l'accusé.

**Comportement attendu :** un dossier ne devrait jamais être simultanément en phase pré-réponse et porter `human_replied_at`. Soit `discoverOutbound` ne crée pas de dossier pour un fil ayant un message entrant plus récent, soit `upsertThreadReceived` ne rétrograde pas un dossier déjà passé en post_reply.
**Comportement obtenu :** oscillation ponctuelle + métriques/corpus faussés pour ce dossier.

**Reproduction :** difficile à provoquer manuellement (fenêtre de course), mais reproductible en test unitaire en appelant `registerIfNewThread` puis `upsertThreadReceived` sur le même `threadId` et en observant l'état.

**Impact métier :** rare (fenêtre = 1 intervalle cron entre l'arrivée et la scrutation, ET une réponse humaine dans cette fenêtre), mais 100 % silencieux et salit exactement les données de performance visées.

**Correction proposée (garde côté upsert) :**
```ts
// Ne jamais rétrograder un dossier déjà passé en post-réponse : si human_replied_at
// existe, conserver le statut post_reply plutôt que de le repasser à 'received'.
ON CONFLICT(thread_id) DO UPDATE SET
  subject = excluded.subject,
  category_id = excluded.category_id,
  urgency = excluded.urgency,
  sla_hours = excluded.sla_hours,
  sla_minutes = excluded.sla_minutes,
  status = CASE WHEN threads.human_replied_at IS NOT NULL THEN threads.status ELSE excluded.status END,
  due_at  = CASE WHEN threads.human_replied_at IS NOT NULL THEN threads.due_at  ELSE excluded.due_at  END,
  updated_at = excluded.updated_at
```
*(Alternative : dans `discoverOutbound`, ignorer un fil dont le dernier message est entrant — mais le garde côté DB est plus robuste car il couvre toutes les sources d'upsert. Décision : voir SPEC-4.)*

**Test de non-régression :**
```ts
test("upsertThreadReceived does not downgrade a thread already in post_reply", () => {
  registerIfNewThread(...); // crée t1 en awaiting_client_reply, human_replied_at posé
  const before = getThreadRow("t1")!.human_replied_at;
  upsertThreadReceived({ threadId: "t1", status: "received", dueAt: iso(+1440), /* ... */ });
  const row = getThreadRow("t1")!;
  assert.notEqual(row.status, "received");           // pas rétrogradé
  assert.equal(row.human_replied_at, before);        // préservé
});
```
**Effort : M | Risque de régression :** moyen (touche un ON CONFLICT central — bien couvrir par les tests d'intake existants).

---

### [BUG-005] `emailsTraites` compte les envois à froid comme des « emails traités » du mois
**Gravité : MINEUR | Probabilité : fréquente | Détectabilité : visible**
**Localisation :** `src/db.ts:1664-1666`.

**Code fautif :**
```ts
const traites = db
  .prepare("SELECT COUNT(*) AS n FROM threads WHERE received_at >= ? AND status != 'skipped'")
  .get(monthStartIso) as { n: number };
```
Les dossiers créés par `discoverOutbound` ont `received_at = now` (heure de découverte) et un statut ≠ `skipped`. Ils sont donc comptés dans « emails traités ce mois », alors que ce sont **nos** envois sortants, pas des emails client reçus.

**Trace :** un devis envoyé à froid → `received_at = now`, `status='awaiting_client_reply'` → `traites.n += 1`, alors qu'aucun email client n'a été « traité ».

**Comportement attendu :** « emails traités » = emails **entrants** pris en charge. Les envois à froid relèvent d'un autre compteur (ou sont exclus).
**Comportement obtenu :** léger gonflement du volume affiché.

**Impact métier :** cosmétique (sur-comptage du volume), mais fausse la lecture du dashboard client. Même cause racine que BUG-002/004 : les dossiers « découverts en sortie » n'ont pas de marqueur d'origine et se mélangent aux vrais entrants.

**Correction proposée :** introduire un marqueur d'origine (`origin TEXT DEFAULT 'inbound'`, posé à `'outbound'` par `discoverOutbound`) et filtrer/segmenter les KPI dessus — corrige BUG-002 **et** BUG-005 **et** BUG-004 à la racine (voir §6, dette de fiabilité). Décision métier : SPEC-2.

**Effort : M | Risque de régression :** faible (additif).

---

## 4. SUSPICIONS À CONFIRMER

**SUS-1 — Famine de la boucle post_reply sous charge par un budget externe épuisé en pré-réponse.**
`runRelanceCheck` partage un unique `externalBudget` (défaut 5) et exécute **d'abord** toute la boucle pre_reply, **puis** post_reply (`relanceCheck.ts:95-134`). Si ≥ 5 relances externes pré-réponse sont dues le même cycle, le budget tombe à 0 avant la boucle post_reply → les relances client post-réponse sont toutes différées, potentiellement plusieurs cycles d'affilée si la pression persiste.
*Protocole :* seeder 6 dossiers pre_reply dus (étape externe) + 2 dossiers post_reply dus, lancer `runRelanceCheck` une fois, vérifier qu'aucune relance post_reply n'est partie. À 1-2 boîtes le risque est faible ; à confirmer avant montée en charge. *Piste :* budgets séparés par phase, ou entrelacement.

**SUS-2 — `traiter` (reprise manuelle) ne réinitialise pas les compteurs.**
`POST /dossiers/:threadId/traiter` (`server.ts:590`) fait un `upsertThreadReceived` puis `sendAcknowledgementAndDrafts`, mais `upsertThreadReceived` ON CONFLICT ne remet pas `relance_count`, `automated_outbound_count`, `ack_sent_at`, ni les snapshots. Sur un dossier `skipped` neuf, ces compteurs valent 0 → sans effet. Mais si la route est appliquée à un dossier **déjà avancé** (compteurs > 0), l'accusé renvoyé incrémente `automated_outbound_count` par-dessus une valeur stale → la détection « humain » repart d'un compteur faux.
*Protocole :* appeler `/traiter` sur un dossier ayant déjà `relance_count=2`, vérifier l'état des compteurs. *Piste :* réinitialiser explicitement les compteurs dans ce chemin, ou n'autoriser `/traiter` que sur `skipped`.

**SUS-3 — `discoverOutbound` et l'auto-adressage du rappel interne quand `NOTIFICATION_EMAIL` pointe vers un tiers.**
Le rappel interne est marqué traité par `sent.id` (`relanceCheck.ts:459`), donc ignoré par `discoverOutbound`. Mais si le fournisseur attribue à la copie « Envoyés » un id différent de `sent.id`, `discoverOutbound` pourrait la voir comme un envoi à froid vers le destinataire du rappel. Le préfixe `[Rappel]` **n'est pas** filtré dans `discoverOutbound` (seulement dans `processIncoming`).
*Protocole :* inspecter, pour Gmail et Graph, si l'id retourné par `sendNotification` == l'id de la copie SENT listée par `listRecentSentMessages`. Si non, ajouter un filtre `subject.startsWith("[Rappel]")` dans `registerIfNewThread`.

---

## 5. SPÉCIFICATIONS MANQUANTES (décisions métier à trancher)

**SPEC-1 — Ordre accusé / notification équipe.** Le brief dit « notifier l'équipe du retard *d'abord*, puis l'accusé et la relance ». Aujourd'hui l'accusé part **immédiatement** à l'intake, et le rappel interne seulement à l'échéance. **Question fermée :** voulez-vous que l'accusé de réception au client soit *retardé* jusqu'après la première notification équipe, ou bien que l'accusé reste immédiat et que seule la *notification équipe précoce* (avant l'échéance SLA) soit ajoutée ? (Retarder l'accusé dégrade l'expérience client ; ajouter une notification équipe à l'intake est probablement ce qui est réellement voulu.)

**SPEC-2 — Sémantique des dossiers « découverts en sortie » dans les KPI.** Un envoi à froid (`discoverOutbound`) doit-il compter dans « emails traités » et dans « délai moyen de réponse » du dashboard client, ou être exclu / segmenté à part ? (Impacte BUG-002 et BUG-005 ; recommandation : les exclure du délai de réponse, les compter séparément.)

**SPEC-3 — Copie Inbox auto-adressée : est-elle `isFromUs` ?** Le filtre `[Rappel]` (BUG-003) n'existe que parce que, sur certains fournisseurs, l'écho auto-adressé n'est pas marqué `isFromUs`. **Question :** sur vos boîtes (Gmail et/ou Graph), la copie reçue d'un email qu'on s'envoie à soi-même est-elle bien détectée `isFromUs` ? Si oui, on peut restreindre le filtre à `isFromUs` sans risque.

**SPEC-4 — Rétrogradation d'un dossier post_reply.** Un `upsertThreadReceived` (arrivée d'un nouvel entrant) doit-il pouvoir ramener un dossier déjà en post_reply vers « reçu » ? (Recommandation : non — cf. BUG-004.) Cas limite légitime : le client relance sur le même fil *avant* qu'on ait traité — mais alors c'est une réponse client, pas un retour en pré-réponse.

**SPEC-5 — Délai « réponse équipe » : quel point de départ ?** `received_at` = arrivée de l'email. Pour un fil multi-messages (le client réécrit avant qu'on réponde), le délai se mesure-t-il depuis le **premier** message ou le **dernier** message entrant avant la réponse ? (Actuel : premier, figé à la création du dossier.)

---

## 6. DETTE DE FIABILITÉ (causes, pas symptômes)

1. **Pas de marqueur d'origine sur `threads`.** Les dossiers « entrants » et « découverts en sortie » partagent la même table sans distinction, alors que leur `received_at` n'a pas la même sémantique (réception réelle vs découverte). Cause racine de BUG-002, BUG-004 et BUG-005. *Traitement :* colonne `origin` + KPI segmentés.

2. **Durées calculées sans borne `≥ 0` systématique.** `toCarnetEntry` et `formatHumanDelay` bornent avec `Math.max(0, …)` ; `getClientMonthlyStats` **non**. Toute soustraction de deux instants stockés indépendamment peut être négative (horloges de sources différentes : réception vs envoi vs découverte). *Traitement :* un utilitaire unique `spanMinutes(fromIso, toIso)` bornant à 0, utilisé partout.

3. **Temps mesuré à l'instant de détection, pas à l'instant de l'événement.** BUG-001 en est le cas net : le pipeline étant piloté par cron, tout `now` capturé dans une boucle de vérification est « l'heure où on a remarqué », pas « l'heure où c'est arrivé ». *Traitement :* toujours ancrer les métriques sur `message.receivedAt`, jamais sur `Date.now()` dans les boucles de détection.

4. **Filtres par contenu d'objet (`startsWith("[Rappel]")`).** Fragiles par nature (usurpables, dépendants du fournisseur). Le projet a déjà appris cette leçon pour la détection humain/automate (passée au comptage) — la même logique devrait s'appliquer aux échos internes (marquage par id/label, pas par objet).

---

## 7. PLAN DE CORRECTION ORDONNÉ

| Ordre | Bug | Dépendances | Charge | Justification |
|------|-----|-------------|--------|---------------|
| 1 | **BUG-001** | aucune | S | Correctif isolé, fort impact KPI, zéro risque de cascade. À faire en premier. |
| 2 | **BUG-002** (borne `≥ 0`) | aucune | S | Correctif défensif immédiat, indépendant du refactor d'origine. |
| 3 | Dette #2 (utilitaire `spanMinutes`) | après BUG-002 | S | Consolide la borne partout, évite la récidive. |
| 4 | **SPEC-2** puis **BUG-005 + BUG-004** via colonne `origin` | décision SPEC-2 | M | Le marqueur d'origine corrige 005, fiabilise 002 (exclusion propre) et sous-tend 004. |
| 5 | **BUG-004** (garde ON CONFLICT) | peut se faire seul ou avec #4 | M | Garde DB robuste ; tester l'intake. |
| 6 | **BUG-003** | décision SPEC-3 | S | Restreindre le filtre à `isFromUs` après validation fournisseur. |
| 7 | **SUS-1 / SUS-2 / SUS-3** | investigation | M | Confirmer avant montée en charge / avant d'ouvrir `/traiter` largement. |
| 8 | **SPEC-1** (ordre notif/accusé) | décision produit | M–L | Changement de flux : à cadrer avec le client avant tout code. |

---

## 8. SUITE DE TESTS RECOMMANDÉE (priorisée)

Priorité **P0** = aurait attrapé un bug MAJEUR ; **P1** = MINEUR/LATENT ; **P2** = durcissement.

```ts
// P0 — BUG-001 : ancrage sur l'heure réelle de la réponse
test("checkPreReplyThread anchors human_replied_at on message.receivedAt", async () => {
  const reply = new Date(Date.now() - 20 * 60_000);
  seedAckedThread("t1", { automated_outbound_count: 1 });
  const conn = fakeConnectorWithThread("t1", [
    fakeMessage({ id: "ack", isFromUs: true, receivedAt: new Date(Date.now() - 40 * 60_000) }),
    fakeMessage({ id: "human", isFromUs: true, receivedAt: reply }),
  ]);
  await checkPreReplyThread(conn, getThreadRow("t1")!, undefined);
  assert.equal(getThreadRow("t1")!.human_replied_at, reply.toISOString());
});

// P0 — BUG-002 : moyenne jamais négative, envois à froid exclus
test("getClientMonthlyStats: negative/discovered spans excluded", () => {
  seedThread({ threadId: "in",  received_at: iso(-60), human_replied_at: iso(-30) });
  seedThread({ threadId: "out", received_at: iso(0),   human_replied_at: iso(-5) }); // découvert
  assert.equal(getClientMonthlyStats().delaiMoyenReponseMinutes, 30);
});

// P0 — BUG-002 bis : une seule ligne négative ne rend pas la moyenne < 0
test("getClientMonthlyStats never returns a negative average", () => {
  seedThread({ threadId: "out", received_at: iso(0), human_replied_at: iso(-5) });
  const avg = getClientMonthlyStats().delaiMoyenReponseMinutes;
  assert.ok(avg === null || avg >= 0);
});

// P1 — BUG-004 : pas de rétrogradation post_reply -> received
test("upsertThreadReceived keeps post_reply thread from being downgraded", () => {
  seedThread({ threadId: "t", status: "awaiting_client_reply", human_replied_at: iso(-1) });
  upsertThreadReceived({ threadId: "t", status: "received", dueAt: iso(+1440), /* ... */ });
  const r = getThreadRow("t")!;
  assert.notEqual(r.status, "received");
  assert.ok(r.human_replied_at);
});

// P1 — BUG-003 : email tiers "[Rappel] ..." bien traité
test("third-party [Rappel] subject is not skipped", async () => {
  const msg = fakeMessage({ subject: "[Rappel] Facture", isFromUs: false });
  await processIncomingMessage(fakeConnectorFor(msg), msg);
  assert.ok(getThreadRow(msg.threadId));
});

// P1 — BUG-003 bis : notre propre rappel auto-adressé reste ignoré
test("our own [Rappel] echo (isFromUs) is still skipped", async () => {
  const msg = fakeMessage({ subject: "[Rappel] 🚨 DOSSIER", isFromUs: true });
  await processIncomingMessage(fakeConnectorFor(msg), msg);
  assert.equal(getThreadRow(msg.threadId), undefined);
});

// P1 — BUG-005 : envois à froid non comptés comme "emails traités"
test("emailsTraites excludes discovered outbound threads", () => {
  seedThread({ threadId: "in",  status: "ack_sent",              received_at: iso(-10) });
  seedThread({ threadId: "out", status: "awaiting_client_reply", received_at: iso(0), origin: "outbound" });
  assert.equal(getClientMonthlyStats().emailsTraites, 1);
});

// P2 — SUS-1 : le budget externe ne doit pas affamer la phase post_reply
test("post_reply relances are not fully starved by pre_reply budget", async () => {
  for (let i = 0; i < 6; i++) seedDuePreReplyExternal(`pre${i}`);
  seedDuePostReplyExternal("post1");
  await runRelanceCheck(fakeConnectorAll());
  assert.ok(sentRelancesFor("post1") >= 1); // échoue aujourd'hui si budget épuisé avant post_reply
});

// P2 — SUS-2 : /traiter ne réutilise pas de compteurs stale
test("manual /traiter resets automated_outbound_count baseline", async () => {
  seedThread({ threadId: "t", status: "skipped", automated_outbound_count: 3 });
  await manualTraiter("t", { categoryId: "devis" });
  assert.equal(getThreadRow("t")!.automated_outbound_count, 1); // 1 = l'accusé qu'on vient d'envoyer
});

// P2 — invariant transverse : aucune durée affichée négative
test("formatHumanDelay and monthly stats never surface negative durations", () => {
  assert.equal(formatHumanDelay(iso(0), iso(-10)), "0 min");
});
```

---

### Annexe — Catégories passées en revue (Phase 1)

- **A. Logique métier** — 1 bug (BUG-003) + invariants INV-1..5 vérifiés OK. Indexation `steps[relance_count]` cohérente (incrément à chaque évaluation d'étape, y compris filtrée ; pas d'incrément si budget épuisé → réessai idempotent). RAS sur off-by-one d'étapes.
- **B. Machines à états** — INV-3 tenu (statuts pre/post disjoints). 1 état incohérent atteignable via course (BUG-004).
- **C. Valeurs nulles** — RAS bloquant : `due_at`/`human_replied_at` gardés avant usage ; `getCategory` a un repli `autre` ; `sla_minutes ?? sla_hours*60`.
- **D. Asynchrone** — verrous `*InProgress` corrects contre le chevauchement de cycles ; pas d'`await` manquant détecté. 1 course inter-tâches (BUG-004).
- **E. Gestion d'erreur** — solide : `tagSource`, `recordPipelineError`, best-effort sur cleanup/notification/markUnread. RAS.
- **F. Intégrité des données** — dédup par `processed_messages` (INSERT OR IGNORE) OK ; ON CONFLICT threads ne réinitialise pas certains compteurs (SUS-2) et peut rétrograder (BUG-004).
- **G. Concurrence** — compteurs incrémentés en SQL (`col = col + 1`) OK ; 1-2 boîtes, faible contention. RAS majeur.
- **H. Nombres/dates/texte** — **2 bugs de durée** (BUG-001 ancrage, BUG-002 signe) ; fuseau correctement centralisé via `formatDateTime`/`config.timezone` ; `slugify` normalise NFD (accents OK).
- **I. Validation frontières** — entrées IA validées par `zod` (`.parse`) ; enum catégories borné côté outil. RAS.
- **J. Cas limites** — vide/uni/épuisé gérés (séquence épuisée → détection continue de tourner, cf. commentaires `relanceCheck.ts:85-94`). Envoi à froid = source des cas limites KPI (BUG-002/005).
- **K. Couverture de tests** — bonne sur le pipeline d'envoi et la dédup ; **trou** sur la justesse *numérique* des délais (les tests existants n'assertent que « non nul »/« ≠ null », jamais la valeur ni le signe — d'où BUG-001/002 non détectés). Voir §8.
