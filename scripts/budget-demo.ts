import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUsdt } from '../src/budget.ts';
import type { Address } from '../src/types.ts';

// Daily-budget CLI for agents and operators: set or remove an owner ceiling for
// an agent, set or remove a payment wallet's own budget, and show any wallet's
// summary. It drives the same two-step signed flow the browser console uses
// (POST /api/budgets/challenge → personal_sign → POST /api/budgets).
//
// Keys are read from the environment, so a caller loads a .secrets file into the
// environment for the duration of one command. --owner-key / --wallet-key take
// the NAME of the environment variable, never the key itself. No private key is
// ever printed, logged or put into a request body.

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const BASE_DEFAULT = 'http://127.0.0.1:4333';

const USAGE = `Usage: bun scripts/budget-demo.ts <command> [options]

Commands:
  show            Print the daily-budget summary of a wallet.
  set-ceiling     Set the owner's daily ceiling for an agent (owner key).
  remove-ceiling  Remove the owner's ceiling for an agent (owner key).
  set-own         Set the payment wallet's own daily budget (wallet key).
  remove-own      Remove the payment wallet's own daily budget (wallet key).

Options:
  --base-url <url>    BF Market base URL (default $BFM_BASE_URL, else ${BASE_DEFAULT})
  --wallet <0x..>     Payment wallet address (default: the signer's address)
  --agent <id>        Agent id, required by the ceiling commands
  --amount <USDT>     Daily budget in USDT, e.g. 0.05 (set commands)
  --owner-key <ENV>   Env var holding the owner key (default OWNER_PRIVATE_KEY)
  --wallet-key <ENV>  Env var holding the payment wallet key (default AGENT_PRIVATE_KEY)
  --help              Print this text

Examples:
  bun scripts/budget-demo.ts show --wallet 0xW --base-url http://127.0.0.1:4333
  set -a; . .secrets/botchain-testnet/buyer-demo.env; set +a
  bun scripts/budget-demo.ts set-ceiling --agent 2 --wallet 0xW --amount 0.05 \\
    --owner-key BOTCHAIN_TESTNET_BUYER_DEMO_PRIVATE_KEY
  set -a; . .secrets/botchain-testnet/budget-agent.env; set +a
  bun scripts/budget-demo.ts set-own --wallet 0xW --amount 0.03 \\
    --wallet-key BOTCHAIN_TESTNET_BUDGET_AGENT_PRIVATE_KEY`;

export type BudgetDemoResult = {
  command: string;
  wallet: Address | null;
  summary: Record<string, unknown> | null;
};

// USDT input ("0.05") to atomic units (50000), the form the API expects.
export function parseUsdtAmount(value: string): bigint {
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(value)) {
    throw new Error(
      `--amount must be a USDT amount with at most 6 decimals (for example 0.05), got "${value}".`,
    );
  }
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((frac || '0').padEnd(6, '0'));
}

type BudgetScope = 'ceiling' | 'wallet';

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
): Promise<BudgetDemoResult> {
  const hasFlag = (name: string): boolean => argv.includes(name);
  const argValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (argv.length === 0 || hasFlag('--help') || hasFlag('-h')) {
    log(USAGE);
    return { command: 'help', wallet: null, summary: null };
  }

  const command = argv[0]!;
  const baseUrl = (argValue('--base-url') ?? env.BFM_BASE_URL ?? BASE_DEFAULT).replace(/\/+$/, '');
  const walletArg = argValue('--wallet');
  const agentArg = argValue('--agent');
  const amountArg = argValue('--amount');
  const ownerKeyName = argValue('--owner-key') ?? 'OWNER_PRIVATE_KEY';
  const walletKeyName = argValue('--wallet-key') ?? 'AGENT_PRIVATE_KEY';

  const readKey = (name: string, role: string): ReturnType<typeof privateKeyToAccount> => {
    const key = env[name];
    if (!key || !KEY_RE.test(key)) {
      throw new Error(`Set ${name} to the ${role} 32-byte hex private key.`);
    }
    return privateKeyToAccount(key as `0x${string}`);
  };

  if (command === 'show') {
    if (!walletArg) throw new Error('--wallet is required for show.');
    const wallet = getAddress(walletArg);
    const summary = await getSummary(baseUrl, wallet);
    log(JSON.stringify(summary, null, 2));
    return { command, wallet, summary };
  }

  if (command !== 'set-ceiling' && command !== 'remove-ceiling' && command !== 'set-own' && command !== 'remove-own') {
    throw new Error(`Unknown command "${command}". Run with --help for usage.`);
  }

  const scope: BudgetScope = command.endsWith('ceiling') ? 'ceiling' : 'wallet';
  const removing = command.startsWith('remove');
  const account = readKey(
    scope === 'ceiling' ? ownerKeyName : walletKeyName,
    scope === 'ceiling' ? "agent owner's" : "payment wallet's",
  );
  const signer = getAddress(account.address) as Address;
  const wallet = walletArg ? (getAddress(walletArg) as Address) : signer;

  let agentId: string | undefined;
  if (scope === 'ceiling') {
    if (!agentArg || !/^[0-9]+$/.test(agentArg)) {
      throw new Error(`--agent <id> is required for ${command}.`);
    }
    agentId = agentArg;
  }
  if (!removing && amountArg === undefined) {
    throw new Error(`--amount <USDT> is required for ${command}.`);
  }
  const dailyLimit = removing ? null : parseUsdtAmount(amountArg!).toString();

  const intent = { scope, wallet, signer, agentId, dailyLimit };
  const challenge = await postJson(baseUrl, '/api/budgets/challenge', intent);
  const message = challenge.message as string | undefined;
  if (!message) throw new Error('The server did not return a challenge message.');
  const signature = await account.signMessage({ message });
  const summary = await postJson(baseUrl, '/api/budgets', { ...intent, signature });

  log(`wallet ${wallet}`);
  const userBudget = summary.userBudget as { effective: string; source: string } | null;
  if (userBudget) {
    log(`effective ${formatUsdt(BigInt(userBudget.effective))} USDT (source ${userBudget.source})`);
  } else {
    log('effective none (no daily budget)');
  }
  return { command, wallet, summary };
}

async function getSummary(baseUrl: string, wallet: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/wallets/${wallet}/summary`);
  return readResponse(res);
}

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readResponse(res);
}

// A non-2xx answer surfaces the server's own error text, so a caller sees the
// same message the API documents.
async function readResponse(res: Response): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!res.ok) {
    const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return payload;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
