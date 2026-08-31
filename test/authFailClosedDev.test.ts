import "./_authEnvDevUnconfigured.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { requireAuth, requireClientAuth } from "../src/web/auth.js";

function fakeReq(): Request {
  return { headers: {}, originalUrl: "/dossiers", body: {} } as unknown as Request;
}

function fakeRes(): Response {
  const res = {
    status() {
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
  return res;
}

test("requireAuth still lets requests through (with a warning) outside production when admin credentials are not configured", () => {
  let nextCalled = false;
  requireAuth(fakeReq(), fakeRes(), (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
});

test("requireClientAuth still lets requests through outside production when client credentials are not configured", () => {
  let nextCalled = false;
  requireClientAuth(fakeReq(), fakeRes(), (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
});
