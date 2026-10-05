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
import { createServiceDiscovery, parseDiscoveryFilter } from "./discovery.ts";
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
    throw new ServiceError(415, "请使用 JSON 提交。");
  }
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader != null && lengthHeader !== "") {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > BODY_LIMIT) {
      throw new ServiceError(413, "请求内容过大。");
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
      throw new ServiceError(413, "请求内容过大。");
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
      throw new ServiceError(400, "请求内容无效。");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(400, "请求内容无效。");
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

function createDisabledChain(config: RuntimeConfig): Chain {
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
      throw new ServiceError(403, "请求主机不被允许。");
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
        requirementsOf: (input) => permit2Facilitator.requirementsOf(input),
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

  const requireRegistry = () => {
    if (!registryChain || !identityRegistry) {
      throw new ServiceError(503, "该网络未配置身份注册表，注册功能不可用。");
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

  const AGENT_CHALLENGE_PURPOSES = new Set(["agent-draft", "starter-gas"] as const);
  type AgentChallengePurpose = "agent-draft" | "starter-gas";
  const challengeKey = (purpose: AgentChallengePurpose, address: string) =>
    `${purpose}:${address.toLowerCase()}`;
  const parseChallengePurpose = (value: unknown): AgentChallengePurpose => {
    if (value == null || value === "") return "agent-draft";
    if (typeof value !== "string" || !AGENT_CHALLENGE_PURPOSES.has(value as AgentChallengePurpose)) {
      throw new ServiceError(400, "验证用途无效。");
    }
    return value as AgentChallengePurpose;
  };
  const isAgentRole = (value: string): value is AgentRole =>
    value === "provider" || value === "buyer";
  const isListedStatus = (value: string): value is ListedStatus =>
    value === "pending" || value === "approved" || value === "rejected";
  const parseAgentRole = (value: unknown): AgentRole => {
    if (typeof value !== "string" || !isAgentRole(value)) {
      throw new ServiceError(400, "代理角色无效。");
    }
    return value;
  };
  const parseTxHash = (value: unknown): Hex => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new ServiceError(400, "交易哈希无效。");
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
    if (!challenge) throw new ServiceError(400, "请先获取验证信息。");
    if (challenge.consumed) {
      throw new ServiceError(409, "验证信息已使用，请重新发起。");
    }
    if (now() > challenge.expiresAt) {
      throw new ServiceError(400, "验证信息已过期，请重新发起。");
    }
    if (challenge.address.toLowerCase() !== address.toLowerCase()) {
      throw new ServiceError(400, "钱包地址与验证信息不一致。");
    }
    const recovered = await recoverBoundAddress(challenge.message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      throw new ServiceError(400, "签名无效。");
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
        `未完成的注册草稿最多 ${MAX_AGENT_DRAFTS_PER_ADDRESS} 个。`,
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
      throw new ServiceError(400, "注册交易未成功。");
    }
    if (!receipt.to || receipt.to.toLowerCase() !== registry.toLowerCase()) {
      throw new ServiceError(400, "该交易不是身份注册表交易。");
    }
    const event = decodeRegisteredEvent(receipt, registry);
    if (!event) throw new ServiceError(400, "未找到注册事件。");
    const draftId = parseDraftIdFromUri(event.agentURI, agentOriginOf(host));
    if (!draftId) throw new ServiceError(400, "注册 URI 与平台不符。");
    const draft = opts.store.getAgentDraft(draftId);
    if (!draft) throw new ServiceError(400, "注册 URI 与任何草稿不匹配。");
    if (draft.address.toLowerCase() !== event.owner.toLowerCase()) {
      throw new ServiceError(400, "注册事件的所有者与草稿地址不符。");
    }
    const ownerOf = await chain.readOwnerOf(event.agentId);
    if (ownerOf.toLowerCase() !== event.owner.toLowerCase()) {
      throw new ServiceError(400, "链上所有者与注册事件不符。");
    }
    const agentWallet = await chain.readAgentWallet(event.agentId);
    if (draft.role === "provider" && /^0x0{40}$/i.test(agentWallet)) {
      throw new ServiceError(400, "服务方必须设置收款地址。");
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
      throw new ServiceError(403, "启动 gas 未开启。");
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
        return mcpEndpoint.handle(req, canonicalOrigin(host, publicOrigin));
      }
      if (req.method !== "GET" && req.method !== "POST") {
        return json(405, { error: "不支持的请求方法。" });
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        const host = req.headers.get("host");
        if (!healthzHostAllowed(host, opts.config.port, publicOrigin)) {
          throw new ServiceError(403, "请求主机不被允许。");
        }
        if (opts.config.payoutsEnabled) return json(200, { ok: true });
        return json(200, {
          ok: true,
          payouts: "disabled",
          network: opts.config.network.name,
        });
      }
      const staticFile = req.method === "GET" ? staticFileFor(url.pathname) : null;
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
          return json(404, { error: "找不到该注册文件。" });
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
        if (!discovery) throw new ServiceError(404, "找不到该接口。");
        const origin = canonicalOrigin(host, publicOrigin);
        const filter = parseDiscoveryFilter(url.searchParams);
        if (url.pathname === "/discovery/search") {
          const query = url.searchParams.get("query") ?? "";
          return json(200, discovery.search(origin, { ...filter, query }));
        }
        return json(200, discovery.list(origin, filter));
      }

      if (!url.pathname.startsWith("/api/")) {
        requireHost(req);
        return json(404, { error: "找不到该页面。" });
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
            throw new ServiceError(400, "代理角色无效。");
          }
          filter.role = roleParam;
        }
        if (listedParam != null && listedParam !== "") {
          if (!isListedStatus(listedParam)) {
            throw new ServiceError(400, "上架状态无效。");
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
        if (!record) throw new ServiceError(404, "找不到该代理。");
        return json(200, { agent: publicAgent(record) });
      }
      if (req.method === "GET" && url.pathname === "/api/services") {
        if (!permit2Service) throw new ServiceError(404, "找不到该接口。");
        requireHost(req);
        return json(200, {
          services: serviceCatalog.list().map((definition) => ({
            serviceId: definition.serviceId,
            providerAgentId: definition.providerAgentId,
            price: definition.price.toString(),
            description: definition.description,
            network: opts.config.network.caip2,
            asset: opts.config.network.asset.address,
          })),
        });
      }
      if (req.method !== "POST")
        return json(405, { error: "不支持的请求方法。" });

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
        if (!permit2Service) throw new ServiceError(404, "找不到该接口。");
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
