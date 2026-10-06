import { getAddress, isAddress } from 'viem';
import { validateAgentProfile } from '../src/agent-registry.ts';
import type { RuntimeConfig } from '../src/config.ts';
import type { SeedAgentInput, SeedDraftInput, Store } from '../src/store.ts';
import {
  ServiceError,
  type Address,
  type AgentRole,
  type ListedStatus,
} from '../src/types.ts';

// One-shot identity seed for a fresh Workers database. The Bun ledger on BOT
// Chain testnet (chainId 968) already holds the registered agents and their
// drafts; scripts/export-seed.ts turns it into the JSON this route accepts.
//
// The route lives in the Workers entry only (worker/ledger.ts). It is never
// registered in src/server.ts, so the Bun entry keeps no public seed surface.

const MAX_RECORDS = 50;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_URI_CHARS = 512;
const MAX_BLOCK_CHARS = 64;

const ROLES = new Set<AgentRole>(['provider', 'buyer']);
const LISTED = new Set<ListedStatus>(['pending', 'approved', 'rejected']);
const AGENT_ID_RE = /^(0|[1-9][0-9]*)$/;
const DRAFT_ID_RE = /^[0-9a-f]{32}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function sha256(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

// Compares through fixed-length SHA-256 digests so neither the length nor the
// prefix of a wrong token is observable from the response timing.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function bearerToken(header: string | null): string | null {
  if (header == null) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1]! : null;
}

async function readBodyText(req: Request): Promise<string> {
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader != null && lengthHeader !== '') {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) {
      throw new ServiceError(400, 'Invalid request body.');
    }
    if (length > MAX_BODY_BYTES) {
      throw new ServiceError(413, 'Request body is too large.');
    }
  }
  const buffer = await req.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new ServiceError(413, 'Request body is too large.');
  }
  return new TextDecoder().decode(buffer);
}

function requireString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ServiceError(400, `${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ServiceError(400, `${label} must be between 1 and ${max} characters.`);
  }
  return trimmed;
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new ServiceError(400, `${label} is not a valid address.`);
  }
  return getAddress(value) as Address;
}

function parseRole(value: unknown): AgentRole {
  if (typeof value !== 'string' || !ROLES.has(value as AgentRole)) {
    throw new ServiceError(400, 'Invalid role.');
  }
  return value as AgentRole;
}

function parseListed(value: unknown): ListedStatus {
  if (typeof value !== 'string' || !LISTED.has(value as ListedStatus)) {
    throw new ServiceError(400, 'Invalid listed status.');
  }
  return value as ListedStatus;
}

function parseAgentId(value: unknown, label: string): string {
  const id = requireString(value, label, 78);
  if (!AGENT_ID_RE.test(id)) {
    throw new ServiceError(400, `${label} must be a numeric string.`);
  }
  return id;
}

function parseOptionalNumber(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ServiceError(400, `${label} must be a non-negative integer.`);
  }
  return value;
}

function parseUri(value: unknown, label: string): string {
  const uri = requireString(value, label, MAX_URI_CHARS);
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new ServiceError(400, `${label} must be a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ServiceError(400, `${label} must be an http(s) URL.`);
  }
  return uri;
}

function parseRecords(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ServiceError(400, `${label} must be an array.`);
  }
  if (value.length > MAX_RECORDS) {
    throw new ServiceError(400, `${label} must contain at most ${MAX_RECORDS} entries.`);
  }
  return value;
}

function parseAgent(value: unknown, chainId: number): SeedAgentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(400, 'Invalid agents entry.');
  }
  const row = value as Record<string, unknown>;
  if (row.chainId !== chainId) {
    throw new ServiceError(400, `chainId must equal the current network (${chainId}).`);
  }
  const registerTx = requireString(row.registerTx, 'registerTx', 66);
  if (!TX_HASH_RE.test(registerTx)) {
    throw new ServiceError(400, 'Invalid registerTx.');
  }
  const blockNumber =
    row.blockNumber == null
      ? null
      : requireString(row.blockNumber, 'blockNumber', MAX_BLOCK_CHARS);
  return {
    chainId,
    agentId: parseAgentId(row.agentId, 'agentId'),
    owner: parseAddress(row.owner, 'owner'),
    agentWallet: parseAddress(row.agentWallet, 'agentWallet'),
    role: parseRole(row.role),
    listed: parseListed(row.listed),
    agentUri: parseUri(row.agentUri, 'agentUri'),
    registerTx: registerTx as SeedAgentInput['registerTx'],
    blockNumber,
    createdAt: parseOptionalNumber(row.createdAt, 'createdAt'),
  };
}

function parseDraft(value: unknown): SeedDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(400, 'Invalid drafts entry.');
  }
  const row = value as Record<string, unknown>;
  const draftId = requireString(row.draftId, 'draftId', 32);
  if (!DRAFT_ID_RE.test(draftId)) {
    throw new ServiceError(400, 'Invalid draftId.');
  }
  const registeredAgentId =
    row.registeredAgentId == null
      ? null
      : parseAgentId(row.registeredAgentId, 'registeredAgentId');
  return {
    draftId,
    address: parseAddress(row.address, 'address'),
    role: parseRole(row.role),
    profile: validateAgentProfile(row.profile, { allowInsecureLocal: true }),
    createdAt: parseOptionalNumber(row.createdAt, 'createdAt'),
    registeredAgentId,
  };
}

function parseSeedBody(raw: string, chainId: number): {
  agents: SeedAgentInput[];
  drafts: SeedDraftInput[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceError(400, 'Invalid request body.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ServiceError(400, 'Invalid request body.');
  }
  const body = parsed as Record<string, unknown>;
  const agents = parseRecords(body.agents, 'agents').map((entry) =>
    parseAgent(entry, chainId),
  );
  const drafts = parseRecords(body.drafts, 'drafts').map(parseDraft);
  return { agents, drafts };
}

// Handler factory. The Workers entry builds it once with the Durable Object's
// store and the SEED_TOKEN binding. A missing token disables the route entirely.
export function createSeedHandler(deps: {
  store: Store;
  config: RuntimeConfig;
  token: string | undefined;
}): (req: Request) => Promise<Response> {
  const { store, config, token } = deps;
  const chainId = config.chain.chainId;
  return async (req) => {
    try {
      if (req.method !== 'POST') {
        return json(405, { error: 'Method not allowed.' });
      }
      if (!token) {
        return json(404, { error: 'Endpoint not found.' });
      }
      const provided = bearerToken(req.headers.get('authorization'));
      if (provided == null || !(await constantTimeEqual(provided, token))) {
        return json(401, { error: 'Unauthorized.' });
      }
      const raw = await readBodyText(req);
      const state = store.seedState();
      if (state.seeded) {
        return json(410, { error: 'The identity seed was already imported.' });
      }
      if (state.agents > 0 || state.drafts > 0) {
        return json(409, { error: 'The ledger already has agent data; import refused.' });
      }
      const body = parseSeedBody(raw, chainId);
      const result = store.importSeed(body);
      return json(200, {
        ok: true,
        agents: result.agents,
        drafts: result.drafts,
      });
    } catch (err) {
      if (err instanceof ServiceError) {
        return json(err.status, { error: err.message });
      }
      return json(500, { error: 'The identity seed import failed.' });
    }
  };
}
