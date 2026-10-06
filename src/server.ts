import { staticFileFor } from "./static.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import {
  allowedHost,
  canonicalOrigin,
  clearSessionCookie,
  COOKIE,
  createLoginLimiter,
  credentialFingerprint,
  hashSessionToken,
  healthzHostAllowed,
  issueChallenge,
  LOGIN_FAILED,
  LOGIN_REQUIRED,
  originFromHost,
  parseAddress,
  parseCookies,
  randomSessionToken,
  recoverBoundAddress,
  securityHeaders,
  sessionCookie,
  verifyLoginPassword,
} from "./auth.ts";
import {
  AUTH_COOKIE_MAX_AGE_SEC,
  AUTH_SESSION_TTL_MS,
  assertLoopbackBind,
  BODY_LIMIT,
  demoWalletAddress,
  loadConfig,
  networkMeta,
  originOf,
  runtimeConfig,
  runtimeFingerprint,
  type RuntimeConfig,
} from "./config.ts";
import { acquireProcessLock } from "./lock.ts";
import { assertNetworkPreflight, rpcPreflightClient } from "./preflight.ts";
import {
  agentRegistryId,
  agentUriFor,
  buildRegistrationDocument,
  createRpcAgentRegistryChain,
  decodeRegisteredEvent,
  MAX_AGENT_DRAFTS_PER_ADDRESS,
  newDraftId,
  parseDraftIdFromUri,
  registerCalldata,
  validateAgentProfile,
  type AgentRegistryChain,
} from "./agent-registry.ts";
import {
  createRpcStarterGasChain,
  createStarterGasService,
  type StarterGasChain,
} from "./starter-gas.ts";
import { createOpsSigner, type OpsSigner } from "./ops-signer.ts";
import { createServiceCatalog, type ServiceCatalog } from "./services.ts";
import {
  LLM_MAX_CONTENT_CHARS,
  LLM_MAX_MAX_TOKENS,
  meteredUpperBound,
  type MeteredRequest,
} from "./llm.ts";
import { createServiceDiscovery, parseDiscoveryFilter } from "./discovery.ts";
import { buildLlmsTxt, buildSkillMarkdown } from "./skill.ts";
import { createMcpEndpoint } from "./mcp.ts";
import { parseAmount } from "./money.ts";
import {
  commissionFromBalances,
  createSource,
  DEFAULT_PAYMENT_AMOUNT_MINOR,
  orderReservationRequestId,
  parseOrderRequestId,
  parsePaymentAmountMinor,
} from "./source.ts";
import { createStore, type Store } from "./store.ts";
import {
  type Address,
  type AgentRecord,
  type AgentRole,
  type AppState,
  type AuthRole,
  type Chain,
  type Hex,
  type ListedStatus,
  type PublicOrder,
  type ServicePaymentRecord,
  type Source,
  type SourceOrder,
  ServiceError,
  sanitizeError,
} from "./types.ts";
import { createWorker, type SettlementWorker } from "./worker.ts";
import {
  createHttpFacilitator,
  createPermit2Service,
  createRpcPermit2Facilitator,
  createRpcX402Chain,
  createX402Service,
  headerGet,
  PAYMENT_SIGNATURE_HEADER,
  UPTO_PERMIT2_PROXY,
  type Permit2Facilitator,
  type X402Chain,
  type X402Facilitator,
} from "./x402/index.ts";

export type { RuntimeConfig, Store, SettlementWorker, Chain, Source, AppState };
export {
  createStore,
  createWorker,
  createSource,
  loadConfig,
  runtimeConfig,
  runtimeFingerprint,
  acquireProcessLock,
};


export type SettlementApp = {
  fetch: (req: Request) => Promise<Response>;
  origin: string;
  store: Store;
  worker: SettlementWorker;
  config: RuntimeConfig;
};

// Worst-case request a metered service accepts, used to advertise its upper
// bound in the discovery catalog (the real quote is computed per body).
const DISCOVERY_MAX_REQUEST: MeteredRequest = {
  messages: [{ role: "user", content: "x".repeat(LLM_MAX_CONTENT_CHARS) }],
  maxTokens: LLM_MAX_MAX_TOKENS,
  inputChars: LLM_MAX_CONTENT_CHARS,
  inputTokens: BigInt(LLM_MAX_CONTENT_CHARS / 2),
};

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...securityHeaders(),
      ...(extra ?? {}),
    },
  });
}

function fail(err: unknown): Response {
  if (err instanceof ServiceError)
    return json(err.status, { error: err.message });
  return json(500, { error: sanitizeError(err) });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new ServiceError(415, "Send the request body as JSON.");
  }
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader != null && lengthHeader !== "") {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > BODY_LIMIT) {
      throw new ServiceError(413, "Request body is too large.");
    }
  }
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > BODY_LIMIT) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new ServiceError(413, "Request body is too large.");
    }
    chunks.push(value);
  }
  if (received === 0) return {};
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ServiceError(400, "Invalid request body.");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(400, "Invalid request body.");
  }
}

async function loadEvmChain(config: RuntimeConfig): Promise<Chain> {
  const path = join(import.meta.dir, "chain.ts");
  if (!existsSync(path)) {
    throw new Error("缺少 src/chain.ts 链适配，拒绝以模拟出款启动。");
  }
  if (!config.chain.privateKey) {
    throw new Error("缺少执行钱包私钥，拒绝启动出款。");
  }
  const mod = (await import(pathToFileURL(path).href)) as {
    EvmChain: new (c: {
      rpcUrl: string;
      chainId: number;
      contract: `0x${string}`;
      token: `0x${string}`;
      privateKey: `0x${string}`;
    }) => Chain;
  };
  return new mod.EvmChain({
    rpcUrl: config.chain.rpcUrl,
    chainId: config.chain.chainId,
    contract: config.chain.contract,
    token: config.chain.token,
    privateKey: config.chain.privateKey,
  });
}

export function createDisabledChain(config: RuntimeConfig): Chain {
  const reason = config.payoutsDisabledReason ?? "出款未启用。";
  const blocked = async (): Promise<never> => {
    throw new ServiceError(503, reason);
  };
  return {
    prepare: blocked,
    broadcast: blocked,
    inspect: blocked,
    balances: blocked,
  };
}

export function createApp(opts: {
  store: Store;
  worker: SettlementWorker;
  chain: Chain;
  source: Source;
  config: RuntimeConfig;
  publicDir?: string;
  // Overrides static-file resolution. The Workers entry passes a resolver that
  // returns null because Workers Assets serves web/dist before the Durable
  // Object sees a request; the Bun entry keeps the filesystem default.
  staticFileResolver?: (pathname: string) => { file: string; type: string } | null;
  now?: () => number;
  x402Facilitator?: X402Facilitator;
  x402Chain?: X402Chain;
  agentRegistryChain?: AgentRegistryChain;
  starterGasChain?: StarterGasChain;
  opsSigner?: OpsSigner;
  permit2Facilitator?: Permit2Facilitator;
  serviceCatalog?: ServiceCatalog;
}): SettlementApp {
  assertLoopbackBind(opts.config.host);
  const origin = originOf(opts.config.host, opts.config.port);
  const publicDir = opts.publicDir ?? opts.config.publicDir;
  const resolveStatic = opts.staticFileResolver ?? staticFileFor;
  const now = opts.now ?? opts.store.now ?? Date.now;
  const authEnabled = opts.config.authEnabled === true;
  const publicOrigin = opts.config.publicOrigin;
  const secureCookie = !!publicOrigin;
  const loginLimiter = createLoginLimiter({ now });
  let activePasswordChecks = 0;
  const orderLocks = new Map<string, Promise<unknown>>();
  const AUTH_DISABLED = new Set([
    "/api/demo/commission",
    "/api/demo/wallet",
    "/api/partner/transfer",
    "/api/partner/auto",
  ]);

  const lockOrder = <T>(requestId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (orderLocks.get(requestId) ?? Promise.resolve()).then(fn, fn);
    const settled = run.then(() => undefined, () => undefined);
    orderLocks.set(requestId, settled);
    void settled.then(() => {
      if (orderLocks.get(requestId) === settled) orderLocks.delete(requestId);
    });
    return run;
  };

  const cookieOpts = {
    secure: secureCookie,
    maxAgeSec: AUTH_COOKIE_MAX_AGE_SEC,
  };

  const authCookie = (token: string) =>
    sessionCookie(token, cookieOpts);

  const requireHost = (req: Request) => {
    const host = req.headers.get("host");
    if (!allowedHost(host, opts.config.port, publicOrigin)) {
      throw new ServiceError(403, "Request host is not allowed.");
    }
    return host!;
  };

  const requireOrigin = (req: Request, host: string) => {
    const originHeader = req.headers.get("origin");
    if (!originHeader || originHeader !== canonicalOrigin(host, publicOrigin)) {
      throw new ServiceError(403, "请求来源不被允许。");
    }
  };

  const fingerprintFor = (role: AuthRole) =>
    credentialFingerprint(
      role === "merchant"
        ? opts.config.merchantPasswordHash
        : opts.config.promoterPasswordHash,
    );

  const readAuthSession = (req: Request) => {
    const sid = parseCookies(req.headers.get("cookie"))[COOKIE];
    if (!sid) return null;
    const row = opts.store.getAuthSession(hashSessionToken(sid));
    if (!row) return null;
    if (row.credentialFingerprint !== fingerprintFor(row.role)) {
      opts.store.deleteAuthSession(row.tokenHash);
      return null;
    }
    return { sid, ...row };
  };

  const requireLegacySession = (req: Request) => {
    const sid = parseCookies(req.headers.get("cookie"))[COOKIE];
    if (!sid || !opts.store.hasSession(sid)) {
      throw new ServiceError(401, "请从本页重新打开结算台。");
    }
    return sid;
  };

  const requireAuthSession = (req: Request) => {
    const session = readAuthSession(req);
    if (!session) throw new ServiceError(401, LOGIN_REQUIRED);
    return session;
  };

  const requireMutation = async (req: Request) => {
    const host = requireHost(req);
    requireOrigin(req, host);
    const body = await readJson(req);
    if (authEnabled) {
      const session = requireAuthSession(req);
      return { sid: session.sid, role: session.role, body, host };
    }
    const sid = requireLegacySession(req);
    return { sid, role: null as AuthRole | null, body, host };
  };

  const challengeDomain = (host: string) =>
    publicOrigin ?? originFromHost(host);

  const denyAuthPath = (role: AuthRole | null, pathname: string) => {
    if (!authEnabled) return;
    if (AUTH_DISABLED.has(pathname)) {
      throw new ServiceError(403, "当前账号不能执行该操作。");
    }
    const payMatch = /^\/api\/demo\/orders\/[^/]+\/pay$/.exec(pathname);
    const x402PayMatch = /^\/api\/x402\/orders\/[^/]+\/pay$/.exec(pathname);
    const merchantPath =
      pathname === "/api/demo/orders" ||
      pathname === "/api/admin/pause" ||
      pathname === "/api/admin/run" ||
      !!payMatch ||
      !!x402PayMatch;
    const promoterPath =
      pathname === "/api/partner/wallet/challenge" ||
      pathname === "/api/partner/wallet/verify";
    if (!((role === "merchant" && merchantPath) || (role === "promoter" && promoterPath))) {
      throw new ServiceError(403, "当前账号不能执行该操作。");
    }
  };

  const orderDemoEnabled = () =>
    opts.config.orderDemo === true && opts.source.kind === "beefapi";

  const requireOrderDemo = () => {
    if (!orderDemoEnabled()) {
      throw new ServiceError(404, "找不到该接口。");
    }
  };

  const awardDemoOrder = async (requestId: string): Promise<PublicOrder> => {
    requireOrderDemo();
    if (!opts.source.payOrder) {
      throw new ServiceError(502, "来源服务暂时不可用。");
    }
    const partner = opts.store.getPartner();
    const existing = opts.store.getOrderSnapshot(requestId);
    if (!existing && !partner.wallet) {
      throw new ServiceError(400, "请先绑定收款钱包，再确认测试订单。");
    }
    const recipient = opts.store.snapshotOrderRecipient(
      requestId,
      existing?.recipient ?? partner.wallet,
      orderReservationRequestId(requestId),
    );
    try {
      const paid = await opts.source.payOrder(requestId);
      if (paid.commissionUsdc === "0") {
        opts.store.setOrderError(requestId, null);
        return toPublicOrder(paid, { recipient, error: null });
      }
      if (!opts.source.reserveFrozen) {
        throw new ServiceError(502, "来源服务暂时不可用。");
      }
      await opts.source.reserveFrozen({
        requestId: orderReservationRequestId(requestId),
        recipient,
        amountUsdc: paid.commissionUsdc,
      });
      opts.store.setOrderError(requestId, null);
      return toPublicOrder(paid, { recipient, error: null });
    } catch (err) {
      const message = sanitizeError(err);
      try {
        opts.store.setOrderError(requestId, message);
      } catch {
        /* snapshot must already exist */
      }
      throw err instanceof ServiceError ? err : new ServiceError(502, message);
    }
  };

  const x402Enabled = opts.config.x402Enabled === true;
  const x402Service = x402Enabled
    ? createX402Service({
        store: opts.store,
        source: opts.source,
        config: opts.config,
        facilitator:
          opts.x402Facilitator ??
          createHttpFacilitator(opts.config.x402FacilitatorUrl),
        chain:
          opts.x402Chain ??
          createRpcX402Chain({
            rpcUrl: opts.config.chain.rpcUrl,
            chainId: opts.config.chain.chainId,
          }),
        now,
        originOf: (host) => canonicalOrigin(host, publicOrigin),
        awardOrder: awardDemoOrder,
      })
    : null;

  const identityRegistry = opts.config.identityRegistry;
  const registryChain = identityRegistry
    ? (opts.agentRegistryChain ??
      createRpcAgentRegistryChain({
        rpcUrl: opts.config.chain.rpcUrl,
        chainId: opts.config.chain.chainId,
        registry: identityRegistry,
      }))
    : null;
  // One ops signer per process: starter gas and Permit2 settlement both sign
  // through it so their nonces cannot collide.
  const opsSigner = opts.config.opsPrivateKey
    ? (opts.opsSigner ??
      createOpsSigner({
        rpcUrl: opts.config.chain.rpcUrl,
        chainId: opts.config.chain.chainId,
        privateKey: opts.config.opsPrivateKey,
      }))
    : null;
  const starterGas = opts.config.starterGasEnabled
    ? createStarterGasService({
        store: opts.store,
        chain:
          opts.starterGasChain ??
          createRpcStarterGasChain({
            rpcUrl: opts.config.chain.rpcUrl,
            chainId: opts.config.chain.chainId,
            privateKey: opts.config.opsPrivateKey!,
            signer: opsSigner ?? undefined,
          }),
        config: opts.config,
        now,
      })
    : null;

  const serviceCatalog =
    opts.serviceCatalog ??
    createServiceCatalog({ store: opts.store, config: opts.config });
  const permit2Facilitator = opts.config.settlementX402Permit2Enabled
    ? (opts.permit2Facilitator ??
      createRpcPermit2Facilitator({
        rpcUrl: opts.config.chain.rpcUrl,
        chainId: opts.config.chain.chainId,
        network: opts.config.network.caip2,
        asset: getAddress(opts.config.chain.token) as Address,
        permit2: opts.config.permit2!,
        proxy: opts.config.x402Permit2Proxy!,
        uptoProxy: UPTO_PERMIT2_PROXY,
        opsSigner: opsSigner!,
      }))
    : null;
  const permit2Service = permit2Facilitator
    ? createPermit2Service({
        store: opts.store,
        config: opts.config,
        catalog: serviceCatalog,
        facilitator: permit2Facilitator,
      })
    : null;
  // Discovery catalog and MCP entry share the same service catalog and payment
  // requirements as the paid HTTP route, so their terms cannot drift.
  const discovery = permit2Facilitator
    ? createServiceDiscovery({
        store: opts.store,
        config: opts.config,
        catalog: serviceCatalog,
        acceptsFor: (definition, payTo) => {
          if (definition.pricing.mode === 'metered') {
            const upperBound = meteredUpperBound(
              definition.pricing.pricing,
              DISCOVERY_MAX_REQUEST,
            );
            return [
              permit2Facilitator.uptoRequirementsOf({
                amount: upperBound.toString(),
                asset: getAddress(opts.config.chain.token) as Address,
                payTo,
              }),
              permit2Facilitator.requirementsOf({
                amount: upperBound.toString(),
                asset: getAddress(opts.config.chain.token) as Address,
                payTo,
              }),
            ];
          }
          return [
            permit2Facilitator.requirementsOf({
              amount: definition.price.toString(),
              asset: getAddress(opts.config.chain.token) as Address,
              payTo,
            }),
          ];
        },
        now,
      })
    : null;
  const mcpEndpoint = createMcpEndpoint({
    config: opts.config,
    permit2Service,
    discovery,
  });

  const allowInsecureLocal = opts.config.network.name === "local";
  const agentOriginOf = (host: string) =>
    opts.config.agentOrigin ?? originFromHost(host);
  // Catalog, MCP, skill.md and llms.txt advertise links on the configured
  // public origin (SETTLEMENT_PUBLIC_ORIGIN) when one is set, so a caller that
  // reached us over a proxy still gets reachable URLs. Otherwise the request
  // host is used.
  const marketOriginOf = (host: string) =>
    opts.config.agentOrigin ??
    opts.config.publicOrigin ??
    originFromHost(host);

  const requireRegistry = () => {
    if (!registryChain || !identityRegistry) {
      throw new ServiceError(
        503,
        "No identity registry is configured on this network, so registration is unavailable.",
      );
    }
    return { chain: registryChain, registry: identityRegistry };
  };

  const publicAgent = (record: AgentRecord) => ({
    agentId: record.agentId,
    chainId: record.chainId,
    owner: record.owner,
    agentWallet: record.agentWallet,
    role: record.role,
    listed: record.listed,
    agentUri: record.agentUri,
    registerTx: record.registerTx,
    blockNumber: record.blockNumber,
    createdAt: record.createdAt,
  });

  // A receipt reports money that actually moved. `amount` is only the signed
  // upper bound (metered) or the fixed price (exact), so it is never a charge
  // unless the payment settled on chain. A failed payment settled nothing; an
  // in-flight payment has not settled yet, so its charge is still unknown.
  const reportedCharge = (record: ServicePaymentRecord): string | null => {
    switch (record.status) {
      case "settled":
      case "delivered":
        return record.chargedAmount ?? record.amount;
      case "failed":
        return "0";
      case "required":
      case "verified":
      case "settling":
        return null;
    }
  };

  // Public receipt projection. Never exposes the signature, the signed
  // journal, upstream request bodies, internal error detail, or the delivered
  // result payload. Addresses are shown in full so a payer can verify their own
  // history.
  const publicReceipt = (record: ServicePaymentRecord) => {
    const explorer = opts.config.network.explorerUrl.replace(/\/+$/, "");
    const definition = serviceCatalog.get(record.serviceId);
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    if (record.usageJson) {
      try {
        const parsed = JSON.parse(record.usageJson) as {
          promptTokens?: unknown;
          completionTokens?: unknown;
        };
        if (
          typeof parsed.promptTokens === "number" &&
          typeof parsed.completionTokens === "number"
        ) {
          usage = {
            promptTokens: parsed.promptTokens,
            completionTokens: parsed.completionTokens,
          };
        }
      } catch {
        /* a malformed usage row is reported as no usage */
      }
    }
    return {
      paymentKey: record.paymentKey,
      serviceId: record.serviceId,
      providerAgentId: definition?.providerAgentId ?? null,
      payer: record.payer,
      payTo: record.payTo,
      asset: record.asset,
      symbol: opts.config.network.asset.symbol,
      network: opts.config.network.caip2,
      scheme: record.scheme,
      status: record.status,
      createdAt: record.createdAt,
      // Signed upper bound for metered calls; the fixed price for exact ones.
      amount: record.amount,
      // Actual charge; only set once the payment settled on chain.
      charged: reportedCharge(record),
      usage: usage
        ? { ...usage, totalTokens: usage.promptTokens + usage.completionTokens }
        : null,
      settlement: record.txHash
        ? {
            txHash: record.txHash,
            explorerUrl: explorer ? `${explorer}/tx/${record.txHash}` : null,
          }
        : null,
    };
  };

  const parseReceiptLimit = (value: string | null): number => {
    if (value == null || value === "") return 50;
    if (!/^[0-9]+$/.test(value)) throw new ServiceError(400, "Invalid limit.");
    const n = Number(value);
    if (n < 0) throw new ServiceError(400, "Invalid limit.");
    return Math.min(n, 200);
  };

  const AGENT_CHALLENGE_PURPOSES = new Set(["agent-draft", "starter-gas"] as const);
  type AgentChallengePurpose = "agent-draft" | "starter-gas";
  const challengeKey = (purpose: AgentChallengePurpose, address: string) =>
    `${purpose}:${address.toLowerCase()}`;
  const parseChallengePurpose = (value: unknown): AgentChallengePurpose => {
    if (value == null || value === "") return "agent-draft";
    if (typeof value !== "string" || !AGENT_CHALLENGE_PURPOSES.has(value as AgentChallengePurpose)) {
      throw new ServiceError(400, "Invalid challenge purpose.");
    }
    return value as AgentChallengePurpose;
  };
  const isAgentRole = (value: string): value is AgentRole =>
    value === "provider" || value === "buyer";
  const isListedStatus = (value: string): value is ListedStatus =>
    value === "pending" || value === "approved" || value === "rejected";
  const parseAgentRole = (value: unknown): AgentRole => {
    if (typeof value !== "string" || !isAgentRole(value)) {
      throw new ServiceError(400, "Invalid agent role.");
    }
    return value;
  };
  const parseTxHash = (value: unknown): Hex => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new ServiceError(400, "Invalid transaction hash.");
    }
    return value.toLowerCase() as Hex;
  };

  const issueAgentChallenge = (
    body: Record<string, unknown>,
    host: string,
  ): { message: string; purpose: AgentChallengePurpose } => {
    requireRegistry();
    const address = parseAddress(body.address);
    const purpose = parseChallengePurpose(body.purpose);
    const issued = issueChallenge({
      domain: agentOriginOf(host),
      userId: "agent",
      address,
      chainId: opts.config.chain.chainId,
      now: now(),
      purpose,
    });
    opts.store.putChallenge({
      sessionId: challengeKey(purpose, address),
      address,
      nonce: issued.nonce,
      message: issued.message,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
    });
    return { message: issued.message, purpose };
  };

  const verifyAgentChallenge = async (
    purpose: AgentChallengePurpose,
    address: Address,
    signature: unknown,
  ): Promise<string> => {
    const key = challengeKey(purpose, address);
    const challenge = opts.store.getChallenge(key);
    if (!challenge) throw new ServiceError(400, "Request a challenge first.");
    if (challenge.consumed) {
      throw new ServiceError(409, "This challenge was already used. Request a new one.");
    }
    if (now() > challenge.expiresAt) {
      throw new ServiceError(400, "This challenge has expired. Request a new one.");
    }
    if (challenge.address.toLowerCase() !== address.toLowerCase()) {
      throw new ServiceError(400, "The wallet address does not match the challenge.");
    }
    const recovered = await recoverBoundAddress(challenge.message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      throw new ServiceError(400, "Invalid signature.");
    }
    return key;
  };

  const createAgentDraft = async (
    body: Record<string, unknown>,
    host: string,
  ) => {
    const { registry } = requireRegistry();
    const address = parseAddress(body.address);
    const key = await verifyAgentChallenge("agent-draft", address, body.signature);
    const role = parseAgentRole(body.role);
    const profile = validateAgentProfile(body.profile, { allowInsecureLocal });
    if (
      opts.store.countOpenAgentDrafts(address) >= MAX_AGENT_DRAFTS_PER_ADDRESS
    ) {
      throw new ServiceError(
        429,
        `At most ${MAX_AGENT_DRAFTS_PER_ADDRESS} open registration drafts are allowed.`,
      );
    }
    opts.store.consumeChallenge(key);
    const draftId = newDraftId();
    const agentURI = agentUriFor(agentOriginOf(host), draftId);
    opts.store.createAgentDraft({
      draftId,
      address,
      role,
      profile,
      createdAt: now(),
    });
    return {
      draftId,
      agentURI,
      registerTx: {
        chainId: opts.config.chain.chainId,
        to: getAddress(registry),
        data: registerCalldata(agentURI),
        value: "0",
      },
    };
  };

  const confirmAgent = async (body: Record<string, unknown>, host: string) => {
    const { chain, registry } = requireRegistry();
    const txHash = parseTxHash(body.txHash);
    const receipt = await chain.getFinalizedReceipt(txHash);
    if (!receipt) return { status: "pending" as const };
    if (receipt.status !== "success") {
      throw new ServiceError(400, "The registration transaction did not succeed.");
    }
    if (!receipt.to || receipt.to.toLowerCase() !== registry.toLowerCase()) {
      throw new ServiceError(400, "This transaction is not to the identity registry.");
    }
    const event = decodeRegisteredEvent(receipt, registry);
    if (!event) throw new ServiceError(400, "No registration event found.");
    const draftId = parseDraftIdFromUri(event.agentURI, agentOriginOf(host));
    if (!draftId) throw new ServiceError(400, "The registration URI does not belong to this platform.");
    const draft = opts.store.getAgentDraft(draftId);
    if (!draft) throw new ServiceError(400, "The registration URI does not match any draft.");
    if (draft.address.toLowerCase() !== event.owner.toLowerCase()) {
      throw new ServiceError(400, "The registration event owner does not match the draft address.");
    }
    const ownerOf = await chain.readOwnerOf(event.agentId);
    if (ownerOf.toLowerCase() !== event.owner.toLowerCase()) {
      throw new ServiceError(400, "The on-chain owner does not match the registration event.");
    }
    const agentWallet = await chain.readAgentWallet(event.agentId);
    if (draft.role === "provider" && /^0x0{40}$/i.test(agentWallet)) {
      throw new ServiceError(400, "A provider must set a payout address.");
    }
    const record = opts.store.upsertAgent({
      chainId: opts.config.chain.chainId,
      agentId: event.agentId.toString(),
      owner: event.owner,
      agentWallet,
      role: draft.role,
      listed: draft.role === "provider" ? "pending" : "approved",
      agentUri: event.agentURI,
      registerTx: txHash,
      blockNumber: receipt.blockNumber.toString(),
      createdAt: now(),
    });
    opts.store.setDraftRegistered(draftId, event.agentId.toString());
    return { status: "confirmed" as const, agent: publicAgent(record) };
  };

  const requestStarterGas = async (body: Record<string, unknown>) => {
    if (!starterGas) {
      throw new ServiceError(403, "Starter gas is not enabled.");
    }
    requireRegistry();
    const address = parseAddress(body.address);
    const key = await verifyAgentChallenge("starter-gas", address, body.signature);
    const grant = await starterGas.grant(address);
    opts.store.consumeChallenge(key);
    return grant;
  };

  const toPublicOrder = (
    order: SourceOrder,
    snapshot?: {
      recipient: string;
      error: string | null;
    } | null,
  ): PublicOrder => {
    const pub: PublicOrder = {
      requestId: order.requestId,
      tradeNo: order.tradeNo,
      paymentAmountMinor: order.paymentAmountMinor,
      commissionRate: order.commissionRate,
      commissionUsdc: order.commissionUsdc,
      status: order.status,
      recipient: snapshot?.recipient ?? "",
      error: snapshot?.error ?? null,
    };
    return x402Service ? x402Service.attach(pub) : pub;
  };

  const loadPublicOrders = async (): Promise<PublicOrder[]> => {
    if (!opts.source.listOrders) {
      throw new ServiceError(502, "来源服务暂时不可用。");
    }
    const listed = await opts.source.listOrders();
    const snapshots = new Map(
      opts.store.listOrderSnapshots().map((row) => [row.requestId, row]),
    );
    return listed.map((order) => toPublicOrder(order, snapshots.get(order.requestId)));
  };

  const createDemoOrder = async (body: Record<string, unknown>): Promise<PublicOrder> => {
    requireOrderDemo();
    if (!opts.source.createOrder) {
      throw new ServiceError(502, "来源服务暂时不可用。");
    }
    const paymentAmountMinor = parsePaymentAmountMinor(
      body.payment_amount_minor,
      DEFAULT_PAYMENT_AMOUNT_MINOR,
    );
    const requestId = body.request_id === undefined ? crypto.randomUUID() : parseOrderRequestId(body.request_id);
    const order = await opts.source.createOrder({
      requestId,
      paymentAmountMinor,
    });
    if (x402Service) x402Service.persistCreatedOrder(order);
    return toPublicOrder(order, opts.store.getOrderSnapshot(order.requestId));
  };

  const payDemoOrder = async (requestIdRaw: string): Promise<PublicOrder> => {
    requireOrderDemo();
    const requestId = parseOrderRequestId(requestIdRaw);
    return lockOrder(requestId, async () => {
      if (opts.store.getX402Order(requestId)) {
        throw new ServiceError(403, "请完成订单付款。");
      }
      if (x402Enabled) {
        const existing = (await opts.source.listOrders?.())?.find(order => order.requestId === requestId);
        if (existing?.status !== "paid") throw new ServiceError(403, "请完成订单付款。");
      }
      return awardDemoOrder(requestId);
    });
  };

  const state = async (role: AuthRole | null): Promise<AppState> => {
    const promoterView = authEnabled && role === "promoter";
    let wallet = { token: "", gas: "" };
    let configured = true;
    let networkError: string | undefined;
    try {
      wallet = await opts.chain.balances();
    } catch (err) {
      wallet = { token: "", gas: "" };
      configured = false;
      networkError = sanitizeError(err);
    }
    const sourceBalances = await opts.source.balances();
    const partner = opts.store.partnerPublic(
      opts.source.kind === "beefapi"
        ? (sourceBalances ?? {
            available: "",
            pending: "",
            paid: "",
            consumed: "",
          })
        : (sourceBalances ?? undefined),
    );
    const sourceError = opts.worker.getSourceError() ?? undefined;
    const orderDemo =
      opts.config.orderDemo === true && opts.source.kind === "beefapi";
    let orders: PublicOrder[] | undefined;
    let orderError: string | undefined;
    if (orderDemo && !promoterView) {
      try {
        orders = await loadPublicOrders();
      } catch (err) {
        orders = [];
        orderError = sanitizeError(err);
      }
    }
    const visibleError = promoterView ? undefined : sourceError ?? orderError;
    const body: AppState = {
      network: networkMeta(opts.config.chain.chainId, opts.config.chain.token, {
        configured,
        error: promoterView ? undefined : networkError,
      }),
      paused: opts.store.isPaused(),
      wallet: promoterView ? { token: "", gas: "" } : wallet,
      partner: promoterView ? { ...partner, autoSettle: false } : partner,
      payouts: opts.store.publicPayouts(),
      source: opts.source.kind,
      minAmount: opts.config.minAmount.toString(),
      commission: commissionFromBalances(opts.source.kind, sourceBalances),
      orderDemo,
      x402: {
        enabled: x402Enabled,
        network: opts.config.network.caip2,
        asset: opts.config.network.asset.address,
        payTo: opts.config.chain.contract,
      },
      ...(authEnabled ? { authEnabled: true, role: role ?? undefined } : {}),
    };
    if (!promoterView) {
      if (orders) body.orders = orders;
      else if (orderDemo) body.orders = [];
    }
    if (visibleError) body.sourceError = visibleError;
    return body;
  };

  const issueAuthSession = (role: AuthRole, previousSid?: string) => {
    if (previousSid) {
      opts.store.deleteAuthSession(hashSessionToken(previousSid));
    }
    const token = randomSessionToken();
    opts.store.createAuthSession({
      tokenHash: hashSessionToken(token),
      role,
      credentialFingerprint: fingerprintFor(role),
      expiresAt: now() + AUTH_SESSION_TTL_MS,
    });
    return token;
  };

  const fetch = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      // MCP entry point (Streamable HTTP). Free to connect; paid tools require
      // an x402 payment payload inside the tool call.
      if (url.pathname === "/mcp") {
        const host = requireHost(req);
        return mcpEndpoint.handle(req, marketOriginOf(host));
      }
      if (req.method !== "GET" && req.method !== "POST") {
        return json(405, { error: "Method not allowed." });
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        const host = req.headers.get("host");
        if (!healthzHostAllowed(host, opts.config.port, publicOrigin)) {
          throw new ServiceError(403, "Request host is not allowed.");
        }
        if (opts.config.payoutsEnabled) return json(200, { ok: true });
        return json(200, {
          ok: true,
          payouts: "disabled",
          network: opts.config.network.name,
        });
      }
      const staticFile = req.method === "GET" ? resolveStatic(url.pathname) : null;
      if (staticFile) {
        requireHost(req);
        const spec = staticFile;
        let headers: Record<string, string> = {
          ...securityHeaders(),
          "Content-Type": spec.type,
        };
        if (!authEnabled) {
          const cookies = parseCookies(req.headers.get("cookie"));
          if (!cookies[COOKIE] || !opts.store.hasSession(cookies[COOKIE])) {
            headers = {
              ...headers,
              "Set-Cookie": sessionCookie(opts.store.createSession()),
            };
          }
        }
        const filePath = join(publicDir, spec.file);
        if (!existsSync(filePath)) {
          return new Response("Not found", { status: 404, headers });
        }
        return new Response(readFileSync(filePath), { status: 200, headers });
      }

      const registrationMatch =
        req.method === "GET"
          ? /^\/registrations\/([0-9a-f]{32})\.json$/.exec(url.pathname)
          : null;
      if (registrationMatch) {
        requireHost(req);
        const draft = opts.store.getAgentDraft(registrationMatch[1]!);
        if (!draft) {
          return json(404, { error: "Registration file not found." });
        }
        const document = buildRegistrationDocument({
          profile: draft.profile,
          registrations:
            draft.registeredAgentId && identityRegistry
              ? [
                  {
                    agentId: draft.registeredAgentId,
                    agentRegistry: agentRegistryId(
                      opts.config.chain.chainId,
                      identityRegistry,
                    ),
                  },
                ]
              : [],
        });
        return new Response(JSON.stringify(document), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...securityHeaders(),
            "Cache-Control": "public, max-age=60",
          },
        });
      }

      // x402 Bazaar discovery: catalog of available paid services in the
      // /discovery/resources format, plus a natural-language search.
      if (
        req.method === "GET" &&
        (url.pathname === "/discovery/resources" || url.pathname === "/discovery/search")
      ) {
        const host = requireHost(req);
        if (!discovery) throw new ServiceError(404, "Endpoint not found.");
        const origin = marketOriginOf(host);
        const filter = parseDiscoveryFilter(url.searchParams);
        if (url.pathname === "/discovery/search") {
          const query = url.searchParams.get("query") ?? "";
          return json(200, discovery.search(origin, { ...filter, query }));
        }
        return json(200, discovery.list(origin, filter));
      }

      // Agent-facing instructions, generated from the current network config
      // and the live catalog. No login and no session cookie.
      if (req.method === "GET" && url.pathname === "/skill.md") {
        const host = requireHost(req);
        return new Response(
          buildSkillMarkdown({
            config: opts.config,
            catalog: serviceCatalog,
            origin: marketOriginOf(host),
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              ...securityHeaders(),
            },
          },
        );
      }
      if (req.method === "GET" && url.pathname === "/llms.txt") {
        const host = requireHost(req);
        return new Response(
          buildLlmsTxt({ origin: marketOriginOf(host) }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...securityHeaders(),
            },
          },
        );
      }

      if (!url.pathname.startsWith("/api/")) {
        requireHost(req);
        return json(404, { error: "Page not found." });
      }

      requireHost(req);
      if (req.method === "GET" && url.pathname === "/api/auth/session") {
        if (!authEnabled) {
          return json(200, {
            authenticated: false,
            role: null,
            authEnabled: false,
          });
        }
        const session = readAuthSession(req);
        return json(200, {
          authenticated: !!session,
          role: session?.role ?? null,
          authEnabled: true,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        if (authEnabled) {
          const session = requireAuthSession(req);
          return json(200, await state(session.role));
        }
        requireLegacySession(req);
        return json(200, await state(null));
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        requireRegistry();
        const roleParam = url.searchParams.get("role");
        const listedParam = url.searchParams.get("listed");
        const filter: { role?: AgentRole; listed?: ListedStatus } = {};
        if (roleParam != null && roleParam !== "") {
          if (!isAgentRole(roleParam)) {
            throw new ServiceError(400, "Invalid agent role.");
          }
          filter.role = roleParam;
        }
        if (listedParam != null && listedParam !== "") {
          if (!isListedStatus(listedParam)) {
            throw new ServiceError(400, "Invalid listing status.");
          }
          filter.listed = listedParam;
        }
        return json(200, {
          agents: opts.store.listAgents(filter).map(publicAgent),
        });
      }
      const agentIdMatch =
        req.method === "GET" ? /^\/api\/agents\/([0-9]+)$/.exec(url.pathname) : null;
      if (agentIdMatch) {
        requireRegistry();
        const record = opts.store.getAgent(
          opts.config.chain.chainId,
          agentIdMatch[1]!,
        );
        if (!record) throw new ServiceError(404, "Agent not found.");
        return json(200, { agent: publicAgent(record) });
      }
      if (req.method === "GET" && url.pathname === "/api/services") {
        if (!permit2Service) throw new ServiceError(404, "Endpoint not found.");
        requireHost(req);
        return json(200, {
          services: serviceCatalog.list().map((definition) => ({
            serviceId: definition.serviceId,
            providerAgentId: definition.providerAgentId,
            price: definition.price.toString(),
            pricing: definition.pricing.mode,
            ...(definition.pricing.mode === 'metered'
              ? { modelId: definition.pricing.pricing.modelId }
              : {}),
            description: definition.description,
            network: opts.config.network.caip2,
            asset: opts.config.network.asset.address,
          })),
        });
      }
      // Public receipts. The list is scoped to one payer and the payer is
      // mandatory, so the endpoint cannot be used to enumerate the whole site.
      if (req.method === "GET" && url.pathname === "/api/receipts") {
        const payerRaw = url.searchParams.get("payer");
        if (payerRaw == null || payerRaw === "") {
          throw new ServiceError(400, "The payer query parameter is required.");
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(payerRaw)) {
          throw new ServiceError(400, "Invalid payer address.");
        }
        const limit = parseReceiptLimit(url.searchParams.get("limit"));
        const receipts = opts.store
          .listServicePaymentsByPayer(getAddress(payerRaw), limit)
          .map(publicReceipt);
        return json(200, { receipts });
      }
      const receiptMatch =
        req.method === "GET"
          ? /^\/api\/receipts\/([^/]+)$/.exec(url.pathname)
          : null;
      if (receiptMatch) {
        const key = decodeURIComponent(receiptMatch[1] ?? "");
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
          throw new ServiceError(400, "Invalid payment key.");
        }
        const record = opts.store.getServicePayment(key.toLowerCase() as Hex);
        if (!record) throw new ServiceError(404, "Receipt not found.");
        return json(200, { receipt: publicReceipt(record) });
      }
      if (req.method === "GET" && url.pathname === "/api/stats/public") {
        const stats = opts.store.publicServiceStats();
        return json(200, stats);
      }
      if (req.method !== "POST")
        return json(405, { error: "Method not allowed." });

      // Public agent routes: a wallet signature is the identity, so no session
      // and no Origin header are required. They are handled before the
      // session-gated mutations below.
      if (url.pathname === "/api/agents/challenge") {
        return json(200, issueAgentChallenge(await readJson(req), requireHost(req)));
      }
      if (url.pathname === "/api/agents/drafts") {
        return json(200, await createAgentDraft(await readJson(req), requireHost(req)));
      }
      if (url.pathname === "/api/agents/confirm") {
        const result = await confirmAgent(await readJson(req), requireHost(req));
        return json(result.status === "pending" ? 202 : 200, result);
      }
      if (url.pathname === "/api/agents/starter-gas") {
        requireHost(req);
        const grant = await requestStarterGas(await readJson(req));
        return json(grant.status === "confirmed" ? 200 : 202, grant);
      }

      // Public paid-service call: a wallet-signed x402 Permit2 payment is the
      // identity, so no session and no Origin header are required. Handled
      // before the session-gated mutations below.
      const serviceCallMatch = /^\/api\/services\/([^/]+)\/call$/.exec(url.pathname);
      if (serviceCallMatch) {
        if (!permit2Service) throw new ServiceError(404, "Endpoint not found.");
        const host = requireHost(req);
        const body = await readJson(req);
        const result = await permit2Service.call({
          serviceId: decodeURIComponent(serviceCallMatch[1] ?? ""),
          signatureHeader: headerGet(req.headers, PAYMENT_SIGNATURE_HEADER),
          body,
          origin: canonicalOrigin(host, publicOrigin),
        });
        return json(result.status, result.body, result.headers);
      }

      if (url.pathname === "/api/auth/login") {
        if (!authEnabled) return json(404, { error: "找不到该接口。" });
        const host = requireHost(req);
        requireOrigin(req, host);
        const body = await readJson(req);
        const username =
          typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!username || !password) {
          throw new ServiceError(400, "请填写账号和密码。");
        }
        if (loginLimiter.blocked(username)) throw new ServiceError(401, LOGIN_FAILED);
        if (activePasswordChecks >= 4) throw new ServiceError(429, "登录请求过多，请稍后再试。");
        activePasswordChecks += 1;
        let role: AuthRole | null;
        try {
          role = await verifyLoginPassword(username, password, {
            merchant: opts.config.merchantPasswordHash,
            promoter: opts.config.promoterPasswordHash,
          });
        } finally { activePasswordChecks -= 1; }
        if (!role) {
          loginLimiter.fail(username);
          throw new ServiceError(401, LOGIN_FAILED);
        }
        loginLimiter.succeed(role);
        const previous = parseCookies(req.headers.get("cookie"))[COOKIE];
        const token = issueAuthSession(role, previous);
        return json(
          200,
          { ok: true, role },
          { "Set-Cookie": authCookie(token) },
        );
      }

      if (url.pathname === "/api/auth/logout") {
        if (!authEnabled) return json(404, { error: "找不到该接口。" });
        const host = requireHost(req);
        requireOrigin(req, host);
        const previous = parseCookies(req.headers.get("cookie"))[COOKIE];
        if (previous) opts.store.deleteAuthSession(hashSessionToken(previous));
        return json(
          200,
          { ok: true },
          { "Set-Cookie": clearSessionCookie({ secure: secureCookie }) },
        );
      }

      const { sid, role, body, host } = await requireMutation(req);
      denyAuthPath(role, url.pathname);
      const challengeSid = authEnabled ? hashSessionToken(sid) : sid;
      if (url.pathname === "/api/demo/orders") {
        return json(200, { order: await createDemoOrder(body) });
      }
      const payMatch = /^\/api\/demo\/orders\/([^/]+)\/pay$/.exec(url.pathname);
      if (payMatch) {
        return json(200, {
          order: await payDemoOrder(decodeURIComponent(payMatch[1] ?? "")),
        });
      }
      const x402Match = /^\/api\/x402\/orders\/([^/]+)\/pay$/.exec(url.pathname);
      if (x402Match) {
        if (!x402Service) throw new ServiceError(404, "找不到该接口。");
        requireOrderDemo();
        const requestId = parseOrderRequestId(
          decodeURIComponent(x402Match[1] ?? ""),
        );
        const signatureHeader = headerGet(req.headers, PAYMENT_SIGNATURE_HEADER);
        const result = await lockOrder(requestId, () =>
          x402Service.pay({
            requestId,
            host,
            signatureHeader,
          }),
        );
        return json(result.status, { order: result.order }, result.headers);
      }
      switch (url.pathname) {
        case "/api/demo/commission": {
          if (opts.source.kind !== "fixture") {
            throw new ServiceError(403, "当前来源不支持添加测试佣金。");
          }
          opts.store.addCommission(parseAmount(body.amount));
          return json(200, { ok: true });
        }
        case "/api/partner/auto": {
          if (typeof body.enabled !== "boolean") {
            throw new ServiceError(400, "请选择是否开启自动结算。");
          }
          opts.store.setAutoSettle(body.enabled);
          return json(200, { ok: true });
        }
        case "/api/partner/wallet/challenge": {
          const address = parseAddress(body.address);
          const issued = issueChallenge({
            domain: challengeDomain(host),
            userId: opts.config.partnerId,
            address,
            chainId: opts.config.chain.chainId,
            now: now(),
          });
          opts.store.putChallenge({
            sessionId: challengeSid,
            address,
            nonce: issued.nonce,
            message: issued.message,
            issuedAt: issued.issuedAt,
            expiresAt: issued.expiresAt,
          });
          return json(200, { message: issued.message });
        }
        case "/api/partner/wallet/verify": {
          const address = parseAddress(body.address);
          const challenge = opts.store.getChallenge(challengeSid);
          if (!challenge) throw new ServiceError(400, "请先获取验证信息。");
          if (challenge.consumed)
            throw new ServiceError(409, "验证信息已使用，请重新发起。");
          if (now() > challenge.expiresAt)
            throw new ServiceError(400, "验证信息已过期，请重新发起。");
          if (challenge.address.toLowerCase() !== address.toLowerCase()) {
            throw new ServiceError(400, "钱包地址与验证信息不一致。");
          }
          const recovered = await recoverBoundAddress(
            challenge.message,
            body.signature,
          );
          if (recovered.toLowerCase() !== address.toLowerCase()) {
            throw new ServiceError(400, "签名无效。");
          }
          opts.store.consumeChallenge(challengeSid);
          opts.store.setWallet(recovered);
          return json(200, { ok: true });
        }
        case "/api/demo/wallet": {
          if (orderDemoEnabled()) {
            throw new ServiceError(403, "请签名绑定收款钱包。");
          }
          opts.store.setWallet(demoWalletAddress(opts.config));
          return json(200, { ok: true });
        }
        case "/api/partner/transfer": {
          if (opts.source.kind !== "fixture") {
            throw new ServiceError(403, "当前来源不支持划入测试消费余额。");
          }
          opts.store.transfer(parseAmount(body.amount));
          return json(200, { ok: true });
        }
        case "/api/admin/pause": {
          if (typeof body.paused !== "boolean") {
            throw new ServiceError(400, "请选择是否暂停出款。");
          }
          opts.store.setPaused(body.paused);
          return json(200, { ok: true });
        }
        case "/api/admin/run": {
          await opts.worker.tick({ force: true });
          const sourceError = opts.worker.getSourceError();
          return json(
            200,
            sourceError ? { ok: true, sourceError } : { ok: true },
          );
        }
        default:
          return json(404, { error: "找不到该接口。" });
      }
    } catch (err) {
      return fail(err);
    }
  };

  return {
    fetch,
    origin,
    store: opts.store,
    worker: opts.worker,
    config: opts.config,
  };
}

export async function startFromEnv(env = process.env, options: { handleSignals?: boolean } = {}) {
  const config = loadConfig({ env });
  assertLoopbackBind(config.host);
  const lock = acquireProcessLock(config.lockPath);
  let store: Store | undefined;
  try {
    const fingerprint = runtimeFingerprint(config);
    store = createStore({
      path: config.dbPath,
      merchantId: config.merchantId,
      partnerId: config.partnerId,
      partnerName: config.partnerName,
      fingerprint,
    });
    if (config.network.name !== "local") {
      await assertNetworkPreflight({
        profile: config.network,
        rpc: rpcPreflightClient({
          rpcUrl: config.chain.rpcUrl,
          chainId: config.network.chainId,
        }),
        token: config.chain.token,
      });
    }
    const chain = config.payoutsEnabled
      ? await loadEvmChain(config)
      : createDisabledChain(config);
    if (config.payoutsEnabled) {
      try {
        await chain.balances();
      } catch {
        throw new Error("结算链未就绪，拒绝启动。");
      }
    } else {
      console.warn(`[settlement] ${config.payoutsDisabledReason}`);
    }
    const source = createSource(store, config);
    const worker = createWorker({ store, chain, source, config });
    const app = createApp({ store, worker, chain, source, config });
    const server = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: app.fetch,
    });
    if (config.payoutsEnabled) {
      worker.start();
      void worker.tick().catch(() => {});
    }
    let shuttingDown: Promise<void> | undefined;
    const shutdown = () =>
      (shuttingDown ??= (async () => {
        worker.stop();
        server.stop(true);
        await worker.drain();
        store?.close();
        lock.release();
      })());
    if (options.handleSignals !== false) {
      process.on("SIGINT", () => {
        void shutdown().then(() => process.exit(0));
      });
      process.on("SIGTERM", () => {
        void shutdown().then(() => process.exit(0));
      });
    }
    return { app, server, lock, shutdown };
  } catch (err) {
    try {
      store?.close();
    } catch {
      /* ignore */
    }
    lock.release();
    throw err;
  }
}

if (import.meta.main) {
  startFromEnv().catch((err) => {
    console.error(sanitizeError(err));
    process.exit(1);
  });
}
