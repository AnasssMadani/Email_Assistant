# @global-link/email

`EmailConnector` implementations for Gmail and Microsoft Graph, ported from
`legacy/src/connectors/*` with tokens moved from per-provider files on disk to
encrypted columns on `mailboxes` (see `tokenStore.ts`) — what makes more than one
connected mailbox possible.

## Ported as-is (semantics unchanged, see CLAUDE.md "Rules carried over")

- `isFromUs` set by the connector from the sender address, never inferred.
- `getThread()` filters out DRAFT-labeled/`isDraft` messages before counting.
- `markMessageUnread()` after sending an automated reply.
- MIME parsing/building (`mime.ts`) — copied verbatim, no changes.

## New in this package

- `rateLimiter.ts` — per-mailbox token bucket + Retry-After backoff (Phase 1
  requirement: "mailbox-aware concurrency" for Graph). In-memory, scoped to a single
  worker process — see the comment at the top of that file for when this needs to
  move to a shared store.
- `tokenStore.ts` — DB-backed OAuth token persistence (AES-256-GCM, same cipher as
  legacy, now on a Postgres column instead of a file).

## Known gap — TODO before Phase 1 is complete

`listRecentInboxMessages`/`listRecentSentMessages` still poll the newest N messages,
exactly like the legacy app. The refonte plan calls for **cursor-based incremental
sync** (Gmail `historyId` + `users.history.list`, Graph delta queries) plus a
reconciliation sweep, using `mailboxes.syncCursor` (already in the schema, unused so
far). Not implemented yet — do not claim Phase 1 ingestion is complete until it is;
a burst of more than the poll size in one interval is still silently lost until then.
