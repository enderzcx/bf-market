import { BODY_LIMIT } from './config.ts';
import type { RuntimeConfig } from './config.ts';
import type { ServiceDiscovery } from './discovery.ts';
import { ServiceError, sanitizeError } from './types.ts';
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from './x402/codec.ts';
import type { Permit2CallResult, Permit2Service } from './x402/permit2-service.ts';
import type { X402PaymentPayload } from './x402/types.ts';

// Minimal MCP Streamable HTTP endpoint (specs/transports-v2/mcp.md). Paid tools
// signal payment with a tool result of `isError: true` carrying the x402
// PaymentRequired object; clients retry with the payment payload in
// `_meta["x402/payment"]` and read settlement from `_meta["x402/payment-response"]`.
//
// The server never holds a private key and never signs for a user.
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'bf-market';
const SERVER_VERSION = '0.1.0';
const PAYMENT_META = 'x402/payment';
const PAYMENT_RESPONSE_META = 'x402/payment-response';

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ServiceError(400, '参数无效。');
  return n;
}

function text(value: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content: [{ type: 'text', text: value }], ...extra };
}

function jsonText(value: unknown): ToolResult {
  return text(JSON.stringify(value), { structuredContent: value });
}

// PaymentRequired as a tool result (both structuredContent and content text, as
// the transport spec requires).
function paymentRequired(required: unknown): ToolResult {
  return {
    isError: true,
    structuredContent: required,
    content: [{ type: 'text', text: JSON.stringify(required) }],
  };
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function readBoundedJson(req: Request): Promise<unknown> {
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader != null && lengthHeader !== '') {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > BODY_LIMIT) {
      throw new ServiceError(413, '请求内容过大。');
    }
  }
  if (!req.body) throw new ServiceError(400, '请求内容无效。');
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
      throw new ServiceError(413, '请求内容过大。');
    }
    chunks.push(value);
  }
  if (received === 0) throw new ServiceError(400, '请求内容无效。');
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ServiceError(400, '请求内容无效。');
  }
}

export function createMcpEndpoint(opts: {
  config: RuntimeConfig;
  permit2Service: Permit2Service | null;
  discovery: ServiceDiscovery | null;
}) {
  const registry = opts.config.identityRegistry;
  // Set on each request so platform/registration text can reference the origin.
  let originRef = '';

  const toolDefs = () => [
    {
      name: 'platform_info',
      description: '平台介绍：这是什么、支持哪些网络、如何注册身份与如何付款。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'search_services',
      description: '按关键词或价格上限搜索可用的付费服务，返回服务目录条目与付款要求。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，匹配服务地址、描述、服务方名称。' },
          maxPrice: {
            type: 'string',
            description: '价格上限，单位为代币最小单位（如 USDT 6 位小数）。',
          },
          network: { type: 'string', description: '按网络过滤，如 eip155:968。' },
          limit: { type: 'number', description: '最多返回条数。' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_service',
      description: '获取单个服务的详情、输入输出 schema 与付款要求。',
      inputSchema: {
        type: 'object',
        properties: { serviceId: { type: 'string', description: '服务 ID。' } },
        required: ['serviceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'call_service',
      description:
        '付费调用服务。未携带付款时返回付款要求；在 _meta["x402/payment"] 携带 x402 付款后结算并交付结果。',
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: '服务 ID。' },
          body: { type: 'object', description: '服务请求体，见 get_service 的输入 schema。' },
        },
        required: ['serviceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'register_agent_info',
      description: '说明如何注册链上身份（ERC-8004），返回相关接口用法、链 ID 与注册表地址。不代签任何交易。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const platformText = () => {
    const net = opts.config.network;
    const lines = [
      'BF Market 是一个 Agent 商业平台：Agent 可以自己发现服务、用 x402 付款并拿到结果。',
      '',
      `当前网络：${net.displayName}（chainId ${net.chainId}，${net.caip2}）。`,
      `结算代币：${net.asset.symbol}（${net.asset.address}）。`,
      registry ? `身份注册表：${registry}` : '本网络未配置身份注册表。',
      '',
      '注册身份（服务方必须，买家可选）：用 register_agent_info 获取步骤。',
      '付款：对 Permit2 做一次授权后，每次调用只需签名；钱直接到服务方收款地址。',
      '找服务：用 search_services，再用 get_service 看详情，最后用 call_service 调用。',
    ];
    return lines.join('\n');
  };

  const platformStructured = () => {
    const net = opts.config.network;
    return {
      platform: 'BF Market',
      description: 'Agent 商业平台：发现服务、x402 付款、拿到结果。',
      networks: [
        {
          name: net.name,
          displayName: net.displayName,
          chainId: net.chainId,
          caip2: net.caip2,
          asset: net.asset.address,
          symbol: net.asset.symbol,
          explorer: net.explorerUrl,
        },
      ],
      registry,
      payment: {
        protocol: 'x402',
        version: 2,
        scheme: 'exact',
        transferMethod: 'permit2',
      },
    };
  };

  const registerText = () => {
    const origin = originRef;
    return [
      '注册链上身份（ERC-8004）：用你自己的钱包签名并广播交易，平台不代签。',
      '',
      `1. POST ${origin}/api/agents/challenge  { address }        → 得到待签消息 message`,
      `2. 用钱包对 message 做 EIP-191 签名`,
      `3. POST ${origin}/api/agents/drafts     { address, signature, role, profile }`,
      '   role 取 provider（服务方）或 buyer（买家）；profile 为服务方档案。',
      '   返回 agentURI 与待签注册交易 registerTx。',
      `4. 用钱包广播 registerTx，得到交易哈希`,
      `5. POST ${origin}/api/agents/confirm    { txHash }          → 读回 agentId`,
      '',
      '服务方注册后 agentWallet 即收款地址；上架状态由平台链下审核。',
    ].join('\n');
  };

  const registerStructured = () => {
    const origin = originRef;
    const endpoints: Record<string, string> = {
      challenge: `${origin}/api/agents/challenge`,
      drafts: `${origin}/api/agents/drafts`,
      confirm: `${origin}/api/agents/confirm`,
    };
    if (opts.config.starterGasEnabled) endpoints['starter-gas'] = `${origin}/api/agents/starter-gas`;
    return {
      chainId: opts.config.chain.chainId,
      caip2: opts.config.network.caip2,
      registry,
      endpoints,
      steps: [
        { step: 'challenge', method: 'POST', body: { address: '0x…' } },
        {
          step: 'drafts',
          method: 'POST',
          body: { address: '0x…', signature: '0x…', role: 'provider|buyer', profile: {} },
        },
        { step: 'confirm', method: 'POST', body: { txHash: '0x…' } },
      ],
    };
  };

  const mapCallResult = (result: Permit2CallResult): ToolResult => {
    if (result.status === 402) return paymentRequired(result.body);
    if (result.status === 200) {
      const body = result.body as { result?: unknown };
      const encoded = result.headers['PAYMENT-RESPONSE'];
      const settle = encoded ? decodePaymentResponseHeader(encoded) : undefined;
      const out: ToolResult = {
        content: [{ type: 'text', text: JSON.stringify(body.result ?? null) }],
        structuredContent: body.result ?? null,
      };
      if (settle !== undefined) out._meta = { [PAYMENT_RESPONSE_META]: settle };
      return out;
    }
    if (result.status === 202) return jsonText(result.body);
    const message = isRecord(result.body) ? optionalString(result.body.error) : undefined;
    return toolError(message ?? '服务暂时不可用。');
  };

  const callTool = async (
    name: unknown,
    args: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
  ): Promise<ToolResult> => {
    switch (name) {
      case 'platform_info':
        return text(platformText(), { structuredContent: platformStructured() });

      case 'search_services': {
        if (!opts.discovery) return toolError('服务目录未启用。');
        const query = optionalString(args.query);
        const network = optionalString(args.network);
        const maxPrice = optionalString(args.maxPrice);
        if (maxPrice !== undefined && !/^[0-9]+$/.test(maxPrice)) {
          throw new ServiceError(400, '价格上限无效。');
        }
        const result = opts.discovery.search(originRef, {
          ...(query ? { query } : {}),
          ...(network ? { network } : {}),
          ...(args.limit !== undefined ? { limit: optionalPositiveInt(args.limit) } : {}),
        });
        const items = maxPrice
          ? result.resources.filter((item) =>
              item.accepts.some((a) => BigInt(a.amount) <= BigInt(maxPrice)),
            )
          : result.resources;
        return jsonText({ services: items, total: items.length });
      }

      case 'get_service': {
        if (!opts.discovery) return toolError('服务目录未启用。');
        const serviceId = optionalString(args.serviceId);
        if (!serviceId) throw new ServiceError(400, '缺少服务 ID。');
        const item = opts.discovery.get(originRef, serviceId);
        if (!item) return toolError('找不到该服务。');
        return jsonText(item);
      }

      case 'call_service': {
        if (!opts.permit2Service) return toolError('付费服务未启用。');
        const serviceId = optionalString(args.serviceId);
        if (!serviceId) throw new ServiceError(400, '缺少服务 ID。');
        const body = isRecord(args.body) ? args.body : {};
        const payment = meta?.[PAYMENT_META];
        const signatureHeader = payment
          ? encodePaymentSignatureHeader(payment as X402PaymentPayload)
          : null;
        const result = await opts.permit2Service.call({
          serviceId,
          signatureHeader,
          body,
          origin: originRef,
          transport: 'mcp',
        });
        return mapCallResult(result);
      }

      case 'register_agent_info':
        return text(registerText(), { structuredContent: registerStructured() });

      default:
        throw new ServiceError(400, `未知工具：${String(name)}`);
    }
  };

  const dispatch = async (
    msg: JsonRpcMessage,
    origin: string,
  ): Promise<Record<string, unknown> | null> => {
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: toolDefs() } };
      case 'tools/call': {
        const params = isRecord(msg.params) ? msg.params : {};
        const meta = isRecord(params._meta) ? params._meta : undefined;
        const args = isRecord(params.arguments) ? params.arguments : {};
        try {
          const result = await callTool(params.name, args, meta);
          return { jsonrpc: '2.0', id, result };
        } catch (err) {
          if (err instanceof ServiceError) return { jsonrpc: '2.0', id, result: toolError(err.message) };
          return { jsonrpc: '2.0', id, result: toolError(sanitizeError(err)) };
        }
      }
      default:
        if (isNotification) return null;
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown method: ${String(msg.method)}` },
        };
    }
  };

  const rpcResponse = (
    body: unknown,
    init: { status?: number; sessionId?: string; allow?: string } = {},
  ): Response => {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    headers.set('MCP-Protocol-Version', PROTOCOL_VERSION);
    if (init.sessionId) headers.set('Mcp-Session-Id', init.sessionId);
    if (init.allow) headers.set('Allow', init.allow);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    });
  };

  const handle = async (req: Request, origin: string): Promise<Response> => {
    originRef = origin;
    if (req.method === 'GET') return rpcResponse(undefined, { status: 405, allow: 'POST, DELETE' });
    if (req.method === 'DELETE') return rpcResponse(undefined, { status: 204 });
    if (req.method !== 'POST') {
      return rpcResponse(undefined, { status: 405, allow: 'POST, DELETE' });
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(req);
    } catch (err) {
      const status = err instanceof ServiceError ? err.status : 400;
      const message = err instanceof ServiceError ? err.message : '请求内容无效。';
      return rpcResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message } }, { status });
    }

    const batch = Array.isArray(payload);
    const messages = (batch ? payload : [payload]) as unknown[];
    const responses: Array<Record<string, unknown>> = [];
    let sessionId: string | undefined;
    for (const raw of messages) {
      if (!isRecord(raw) || typeof raw.method !== 'string') {
        responses.push({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        });
        continue;
      }
      const msg = raw as JsonRpcMessage;
      if (msg.method === 'initialize' && !sessionId) sessionId = crypto.randomUUID();
      const res = await dispatch(msg, origin);
      if (res) responses.push(res);
    }

    if (responses.length === 0) return rpcResponse(undefined, { status: 202, sessionId });
    return rpcResponse(batch ? responses : responses[0], { sessionId });
  };

  return { handle, tools: toolDefs };
}

export type McpEndpoint = ReturnType<typeof createMcpEndpoint>;
