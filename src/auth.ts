import { createHash, randomBytes } from 'node:crypto';
import { getAddress, isAddress, recoverMessageAddress } from 'viem';
import { CHALLENGE_TTL_MS } from './config.ts';
import type { Address, AuthRole } from './types.ts';
import { ServiceError } from './types.ts';

export const COOKIE = 'sid';
export const LOGIN_FAILED = '账号或密码不正确。';
export const LOGIN_REQUIRED = '请先登录。';

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$Cl2Ngowtioxy1ICqJUE6cfrKz+hRoLt+bPxmlXd9OFA$8BS5+G0bVKxCJJZg/QmZ3i/rgufBkc5oPdTi3Jr3Yo0';

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_KNOWN = 8;
export const LOGIN_MAX_UNKNOWN = 20;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(
  token: string,
  opts?: { secure?: boolean; maxAgeSec?: number },
): string {
  let value = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
  if (opts?.maxAgeSec != null) value += `; Max-Age=${opts.maxAgeSec}`;
  if (opts?.secure) value += '; Secure';
  return value;
}

export function clearSessionCookie(opts?: { secure?: boolean }): string {
  let value = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  if (opts?.secure) value += '; Secure';
  return value;
}

export function loopbackHostAllowed(hostHeader: string | null, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (port === 80) {
    allowed.add('127.0.0.1');
    allowed.add('localhost');
    allowed.add('[::1]');
  }
  return allowed.has(host);
}

export function publicHostAllowed(
  hostHeader: string | null,
  publicOrigin: string,
): boolean {
  if (!hostHeader) return false;
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    return false;
  }
  const host = hostHeader.trim().toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const expectedPort = url.port || '443';
  return host === `${hostname}:${expectedPort}` || (expectedPort === '443' && host === hostname);
}

export function allowedHost(
  hostHeader: string | null,
  port: number,
  publicOrigin?: string | null,
): boolean {
  if (publicOrigin) return publicHostAllowed(hostHeader, publicOrigin);
  return loopbackHostAllowed(hostHeader, port);
}

export function healthzHostAllowed(
  hostHeader: string | null,
  port: number,
  publicOrigin?: string | null,
): boolean {
  if (loopbackHostAllowed(hostHeader, port)) return true;
  if (publicOrigin) return publicHostAllowed(hostHeader, publicOrigin);
  return false;
}

export function originFromHost(hostHeader: string): string {
  return `http://${hostHeader}`;
}

export function canonicalOrigin(hostHeader: string, publicOrigin: string | null): string {
  return publicOrigin ?? originFromHost(hostHeader);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function credentialFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash, 'utf8').digest('hex');
}

export function randomSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isAuthRole(value: string): value is AuthRole {
  return value === 'merchant' || value === 'promoter';
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export async function verifyLoginPassword(
  username: string,
  password: string,
  hashes: { merchant: string; promoter: string },
): Promise<AuthRole | null> {
  const hash = isAuthRole(username)
    ? username === 'merchant'
      ? hashes.merchant
      : hashes.promoter
    : DUMMY_PASSWORD_HASH;
  const ok = await verifyPassword(password, hash);
  if (!ok || !isAuthRole(username)) return null;
  return username;
}

type AttemptBucket = { count: number; resetAt: number };

export function createLoginLimiter(opts?: {
  windowMs?: number;
  maxKnown?: number;
  maxUnknown?: number;
  now?: () => number;
}) {
  const windowMs = opts?.windowMs ?? LOGIN_WINDOW_MS;
  const maxKnown = opts?.maxKnown ?? LOGIN_MAX_KNOWN;
  const maxUnknown = opts?.maxUnknown ?? LOGIN_MAX_UNKNOWN;
  const now = opts?.now ?? Date.now;
  const known: Record<AuthRole, AttemptBucket> = {
    merchant: { count: 0, resetAt: 0 },
    promoter: { count: 0, resetAt: 0 },
  };
  const unknown: AttemptBucket = { count: 0, resetAt: 0 };

  const refresh = (bucket: AttemptBucket) => {
    const t = now();
    if (t >= bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = t + windowMs;
    }
  };

  const take = (username: string): AttemptBucket =>
    isAuthRole(username) ? known[username] : unknown;

  const limitOf = (username: string) =>
    isAuthRole(username) ? maxKnown : maxUnknown;

  return {
    blocked(username: string): boolean {
      const bucket = take(username);
      refresh(bucket);
      return bucket.count >= limitOf(username);
    },
    fail(username: string) {
      const bucket = take(username);
      refresh(bucket);
      bucket.count += 1;
    },
    succeed(role: AuthRole) {
      known[role] = { count: 0, resetAt: now() + windowMs };
    },
  };
}

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };
}

export function parseAddress(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new ServiceError(400, '钱包地址无效。');
  }
  return getAddress(value) as Address;
}

// A challenge is bound to its purpose so a signature gathered for one flow can
// never be replayed in another (wallet binding, agent draft, starter gas).
export type ChallengePurpose = 'wallet-binding' | 'agent-draft' | 'starter-gas';

const CHALLENGE_TITLES: Record<ChallengePurpose, string> = {
  'wallet-binding': 'Settlement wallet binding',
  'agent-draft': 'BF Market agent registration',
  'starter-gas': 'BF Market starter gas request',
};

export function challengeMessage(input: {
  domain: string;
  userId: string;
  address: Address;
  nonce: string;
  chainId: number;
  issuedAt: number;
  expiresAt: number;
  purpose?: ChallengePurpose;
}): string {
  const purpose = input.purpose ?? 'wallet-binding';
  const lines = [CHALLENGE_TITLES[purpose]];
  if (purpose !== 'wallet-binding') {
    lines.push(`Purpose: ${purpose}`);
  }
  lines.push(
    `Domain: ${input.domain}`,
    `User: ${input.userId}`,
    `Address: ${input.address}`,
    `Nonce: ${input.nonce}`,
    `Chain ID: ${input.chainId}`,
    `Issued at: ${new Date(input.issuedAt).toISOString()}`,
    `Expires at: ${new Date(input.expiresAt).toISOString()}`,
  );
  return lines.join('\n');
}

export function issueChallenge(input: {
  domain: string;
  userId: string;
  address: Address;
  chainId: number;
  now: number;
  purpose?: ChallengePurpose;
}) {
  const nonce = `0x${crypto.randomUUID().replaceAll('-', '')}`;
  const issuedAt = input.now;
  const expiresAt = issuedAt + CHALLENGE_TTL_MS;
  const message = challengeMessage({
    ...input,
    nonce,
    issuedAt,
    expiresAt,
  });
  return { nonce, issuedAt, expiresAt, message };
}

export async function recoverBoundAddress(message: string, signature: unknown): Promise<Address> {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new ServiceError(400, '签名无效。');
  }
  try {
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    return getAddress(recovered) as Address;
  } catch {
    throw new ServiceError(400, '签名无效。');
  }
}
