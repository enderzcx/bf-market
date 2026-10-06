import { Database } from 'bun:sqlite';
import { getAddress } from 'viem';

// Dumps the agents and agent_drafts of a local Bun ledger as the JSON body that
// POST /internal/seed accepts. Read-only: it never writes to the source database
// and never emits a key or any column outside those two tables.
//
//   bun scripts/export-seed.ts --db .local/settlement.botchain-testnet.sqlite \
//     --rewrite-uri-origin https://market.bflabs.app > seed.json

// Origins the local Bun entry used before the Workers deploy. Any agent_uri or
// draft profile URL that starts with one of these is re-pointed at the target
// origin; the path, query and fragment are preserved.
const SOURCE_ORIGINS = new Set([
  'http://127.0.0.1:4311',
  'http://localhost:4311',
]);

const args = process.argv.slice(2);
const argValue = (name: string, fallback: string): string => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
};

const dbPath = argValue('--db', '');
if (!dbPath) {
  console.error(
    '用法: bun scripts/export-seed.ts --db <path> [--rewrite-uri-origin <origin>]',
  );
  process.exit(1);
}

const rewriteTarget = argValue('--rewrite-uri-origin', '');
let targetOrigin = '';
if (rewriteTarget) {
  try {
    targetOrigin = new URL(rewriteTarget).origin;
  } catch {
    console.error(`--rewrite-uri-origin 不是合法来源：${rewriteTarget}`);
    process.exit(1);
  }
}

function rewriteUri(value: string): string {
  if (!targetOrigin) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!SOURCE_ORIGINS.has(url.origin)) return value;
  return `${targetOrigin}${url.pathname}${url.search}${url.hash}`;
}

function rewriteProfile<T>(profile: T): T {
  if (!targetOrigin || !profile || typeof profile !== 'object') return profile;
  const record = profile as Record<string, unknown>;
  if (typeof record.image === 'string') {
    record.image = rewriteUri(record.image);
  }
  if (Array.isArray(record.services)) {
    for (const service of record.services) {
      if (service && typeof service === 'object') {
        const entry = service as Record<string, unknown>;
        if (typeof entry.endpoint === 'string') {
          entry.endpoint = rewriteUri(entry.endpoint);
        }
      }
    }
  }
  return profile;
}

const db = new Database(dbPath, { readonly: true });
try {
  const agentRows = db
    .query(
      'SELECT * FROM agents ORDER BY chain_id ASC, CAST(agent_id AS INTEGER) ASC',
    )
    .all() as Record<string, unknown>[];
  const draftRows = db
    .query('SELECT * FROM agent_drafts ORDER BY created_at ASC')
    .all() as Record<string, unknown>[];

  const payload = {
    agents: agentRows.map((row) => ({
      chainId: Number(row.chain_id),
      agentId: String(row.agent_id),
      owner: getAddress(String(row.owner)),
      agentWallet: getAddress(String(row.agent_wallet)),
      role: String(row.role),
      listed: String(row.listed),
      agentUri: rewriteUri(String(row.agent_uri)),
      registerTx: String(row.register_tx),
      blockNumber: row.block_number == null ? null : String(row.block_number),
      createdAt: Number(row.created_at),
    })),
    drafts: draftRows.map((row) => ({
      draftId: String(row.draft_id),
      address: getAddress(String(row.address)),
      role: String(row.role),
      profile: rewriteProfile(JSON.parse(String(row.profile_json))),
      createdAt: Number(row.created_at),
      registeredAgentId:
        row.registered_agent_id == null ? null : String(row.registered_agent_id),
    })),
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} finally {
  db.close();
}
