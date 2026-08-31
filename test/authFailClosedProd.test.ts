import "./_authEnvProdUnconfigured.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { requireAuth, requireCsrf } from "../src/web/auth.js";

function fakeReq(): Request {
  return { headers: {}, originalUrl: "/dossiers", body: {} } as unknown as Request;
}

/** Espion minimal: capture le code HTTP envoye, sans dependre d'Express. */
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

test("SEC-001: requireAuth denies with 503 in production when admin credentials are not configured, instead of letting everyone through", () => {
  const { res, statusCode } = fakeRes();
  let nextCalled = false;
  requireAuth(fakeReq(), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(statusCode(), 503);
});

test("SEC-001: requireCsrf denies with 503 in production when admin credentials are not configured", () => {
  const { res, statusCode } = fakeRes();
  let nextCalled = false;
  requireCsrf(fakeReq(), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(statusCode(), 503);
});
