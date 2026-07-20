import type { NextFunction, Request, Response } from "express";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const SESSION_COOKIE = "sess";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;

// ---------- Cookies ----------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  (header ?? "").split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// ---------- Sessions (en memoire — un seul processus, single-tenant) ----------

export type SessionRole = "admin" | "client";

interface SessionData {
  csrfToken: string;
  expiresAt: number;
  role: SessionRole;
}

const sessions = new Map<string, SessionData>();

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [token, data] of sessions) {
    if (data.expiresAt < now) sessions.delete(token);
  }
}

export function createSession(role: SessionRole): { token: string; csrfToken: string } {
  pruneExpiredSessions();
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  sessions.set(token, { csrfToken, role, expiresAt: Date.now() + SESSION_TTL_MS });
  return { token, csrfToken };
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

function getSession(token: string | undefined): SessionData | undefined {
  if (!token) return undefined;
  const data = sessions.get(token);
  if (!data) return undefined;
  if (data.expiresAt < Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return data;
}

// ---------- Mots de passe (scrypt) ----------

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function hashPasswordForStorage(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${derived}`;
}

let memoizedLegacyHash: string | null = null;
let warnedLegacyPassword = false;

function effectivePasswordHash(): string {
  if (config.auth.passwordHash) return config.auth.passwordHash;
  if (config.auth.legacyPlaintextPassword) {
    if (!memoizedLegacyHash) {
      memoizedLegacyHash = hashPasswordForStorage(config.auth.legacyPlaintextPassword);
    }
    if (!warnedLegacyPassword) {
      warnedLegacyPassword = true;
      console.warn(
        '[avertissement] SETUP_PASSWORD (en clair) est deprecie. Generez un hash avec ' +
          '"npm run auth:hash-password -- motdepasse" et definissez SETUP_PASSWORD_HASH a la place.'
      );
    }
    return memoizedLegacyHash;
  }
  return "";
}

export function authConfigured(): boolean {
  return Boolean(config.auth.username) && Boolean(effectivePasswordHash());
}

export function verifyLogin(username: string, password: string): boolean {
  const expectedHash = effectivePasswordHash();
  if (!expectedHash || !config.auth.username) return false;
  const [salt, expectedDerived] = expectedHash.split(":");
  if (!salt || !expectedDerived) return false;
  const candidateDerived = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  const passwordOk = safeEqual(candidateDerived, expectedDerived);
  const usernameOk = safeEqual(username, config.auth.username);
  return usernameOk && passwordOk;
}

// ---------- Identifiants du dashboard client (compte separe de l'admin) ----------

export function clientAuthConfigured(): boolean {
  return Boolean(config.auth.clientUsername) && Boolean(config.auth.clientPasswordHash);
}

export function verifyClientLogin(username: string, password: string): boolean {
  const expectedHash = config.auth.clientPasswordHash;
  if (!expectedHash || !config.auth.clientUsername) return false;
  const [salt, expectedDerived] = expectedHash.split(":");
  if (!salt || !expectedDerived) return false;
  const candidateDerived = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  const passwordOk = safeEqual(candidateDerived, expectedDerived);
  const usernameOk = safeEqual(username, config.auth.clientUsername);
  return usernameOk && passwordOk;
}

// ---------- Limitation des tentatives de connexion ----------

const loginAttempts = new Map<string, { count: number; windowStart: number }>();

export function isLoginRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: Date.now() });
    return;
  }
  entry.count += 1;
}

export function resetLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// ---------- Middlewares Express ----------

let warnedAuthDisabled = false;
function warnAuthDisabledOnce(): void {
  if (warnedAuthDisabled) return;
  warnedAuthDisabled = true;
  console.warn(
    "[avertissement] SETUP_USERNAME / SETUP_PASSWORD(_HASH) non definis: l'application n'est pas protegee. " +
      "A ne jamais laisser ainsi en dehors de localhost."
  );
}

let warnedClientAuthDisabled = false;
function warnClientAuthDisabledOnce(): void {
  if (warnedClientAuthDisabled) return;
  warnedClientAuthDisabled = true;
  console.warn(
    "[avertissement] CLIENT_USERNAME / CLIENT_PASSWORD_HASH non definis: le dashboard client n'est pas protege. " +
      "A ne jamais laisser ainsi en dehors de localhost."
  );
}

/** Espace admin uniquement — un client authentifie sous le role "client" est refuse, meme s'il devine l'URL. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authConfigured()) {
    warnAuthDisabledOnce();
    next();
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE]);
  if (!session || session.role !== "admin") {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  res.locals.csrfToken = session.csrfToken;
  next();
}

/**
 * Espace client (/client/... + le flux OAuth de reconnexion messagerie,
 * partage avec l'admin) — accepte le role "client" ET "admin" (l'admin peut
 * ainsi previsualiser le dashboard client), mais jamais l'inverse: une
 * session client n'ouvre jamais une route admin (voir requireAuth ci-dessus).
 * Verrouillage cote serveur systematique, pas un simple masquage de lien
 * dans le menu — un client qui devine une URL admin est quand meme bloque.
 */
export function requireClientAuth(req: Request, res: Response, next: NextFunction): void {
  if (!clientAuthConfigured()) {
    warnClientAuthDisabledOnce();
    next();
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE]);
  if (!session || (session.role !== "client" && session.role !== "admin")) {
    res.redirect(`/client/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  res.locals.csrfToken = session.csrfToken;
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!authConfigured()) {
    next();
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE]);
  const submitted = (req.body as Record<string, string> | undefined)?._csrf;
  if (!session || !submitted || !safeEqual(submitted, session.csrfToken)) {
    res.status(403).send("Jeton de securite invalide ou expire. Rechargez la page et reessayez.");
    return;
  }
  next();
}

export function getSessionFromRequest(req: Request): { csrfToken: string } | undefined {
  const cookies = parseCookies(req.headers.cookie);
  return getSession(cookies[SESSION_COOKIE]);
}
