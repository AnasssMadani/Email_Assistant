// SEC-007: la CSRF des routes CLIENT ne doit plus dependre uniquement de la
// config ADMIN. Ici l'admin n'est PAS configure mais le client L'EST — avant
// le correctif, requireCsrf court-circuitait (next()) des qu'authConfigured()
// etait false, laissant les mutations du dashboard client sans protection.
import "./_authEnvClientOnlyProd.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { requireCsrf } from "../src/web/auth.js";

function fakeReq(): Request {
  // Aucune session/csrf soumis: si la garde est bien active, elle doit
  // rejeter (403), jamais laisser passer (next()) ni renvoyer 503 (le client
  // EST configure, ce n'est pas un cas de configuration manquante).
  return { headers: {}, originalUrl: "/client/dossiers/t1/resoudre", body: {} } as unknown as Request;
}

function fakeRes(): { res: Response; statusCode(): number | undefined } {
  let statusCode: number | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    send() {
      return res;
    },
    redirect() {
      return res;
    },
    locals: {},
  } as unknown as Response;
  return { res, statusCode: () => statusCode };
}

test("SEC-007: requireCsrf is enforced on client mutations even when only the client (not the admin) is configured", () => {
  const { res, statusCode } = fakeRes();
  let nextCalled = false;
  requireCsrf(fakeReq(), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  // Rejete pour absence de session/jeton valide (403) — surtout PAS un
  // passage silencieux (next()) ni un 503 (le client est bien configure).
  assert.equal(nextCalled, false);
  assert.equal(statusCode(), 403);
});
