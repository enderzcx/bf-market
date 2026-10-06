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
  if (!Number.isInteger(n) || n < 0) throw new ServiceError(400, 'Invalid argument.');
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
      throw new ServiceError(413, 'Request body too large.');
    }
  }
  if (!req.body) throw new ServiceError(400, 'Invalid request body.');
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
      throw new ServiceError(413, 'Request body too large.');
    }
    chunks.push(value);
  }
  if (received === 0) throw new ServiceError(400, 'Invalid request body.');
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ServiceError(400, 'Invalid request body.');
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
      description:
        'Describe BF Market: what it is, the network it runs on, how to register an identity, and how to pay.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'search_services',
      description:
        'Search available paid services by keyword or price cap. Returns catalog entries with their payment requirements.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keyword. Matches the service URL, its description, and the provider name.',
          },
          maxPrice: {
            type: 'string',
            description: "Price cap in the token's smallest unit (USDT has 6 decimals).",
          },
          network: { type: 'string', description: 'Filter by network, for example eip155:968.' },
          limit: { type: 'number', description: 'Maximum number of entries to return.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_service',
      description:
        "Get one service's details, its input and output schemas, and its payment requirements.",
      inputSchema: {
        type: 'object',
        properties: { serviceId: { type: 'string', description: 'Service ID.' } },
        required: ['serviceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'call_service',
      description:
        'Call a paid service. Without a payment it returns the payment requirements; with an x402 payment in _meta["x402/payment"] it settles the payment and delivers the result.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'Service ID.' },
          body: {
            type: 'object',
            description: "Service request body. See the input schema from get_service.",
          },
        },
        required: ['serviceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'register_agent_info',
      description:
        'Explain how to register an on-chain identity (ERC-8004). Returns the endpoint usage, chain ID, and registry address. The platform never signs transactions for you.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const platformText = () => {
    const net = opts.config.network;
    const lines = [
      'BF Market is an agent commerce platform: find services, pay per call with x402, get results.',
      '',
      `Network: ${net.displayName}, chain ${net.chainId} (${net.caip2}). Settlement token: ${net.asset.symbol} (${net.asset.address}).`,
      registry ? `Identity registry: ${registry}` : 'No identity registry is configured on this network.',
      '',
      'Providers must register an ERC-8004 identity to list services and receive payments; buyers can pay without registering.',
      'To register, call register_agent_info for the steps.',
      'Metered services (for example the LLM chat services) quote a fixed per-call maximum with the x402 `upto` scheme and settle only the actual usage, at or below that maximum and possibly zero. Fixed-price services use the x402 `exact` scheme and charge the fixed quoted price. Both settle through Permit2.',
      'To pay, approve Permit2 once and then sign for each call; funds go directly to the provider payout address.',
      'To find a service, use search_services, then get_service for details, then call_service.',
    ];
    return lines.join('\n');
  };

  const platformStructured = () => {
    const net = opts.config.network;
    return {
      platform: 'BF Market',
      description: 'Agent commerce platform: find services, pay per call with x402, get results.',
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
        schemes: ['exact', 'upto'],
        transferMethod: 'permit2',
      },
    };
  };

  const registerText = () => {
    const origin = originRef;
    return [
      'Register an on-chain identity (ERC-8004). Sign and broadcast with your own wallet; the platform never signs for you.',
      '',
      `1. POST ${origin}/api/agents/challenge  { address }        → returns the message to sign`,
      `2. Sign the message with your wallet (EIP-191)`,
      `3. POST ${origin}/api/agents/drafts     { address, signature, role, profile }`,
      '   role is provider or buyer; profile is the provider profile.',
      '   Returns agentURI and the registration transaction registerTx.',
      `4. Broadcast registerTx with your wallet to get the transaction hash`,
      `5. POST ${origin}/api/agents/confirm    { txHash }          → reads back agentId`,
      '',
      'After registration the provider agentWallet receives payments; listing is reviewed off-chain by the platform.',
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
    return toolError(message ?? 'Service temporarily unavailable.');
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
        if (!opts.discovery) return toolError('Service catalog is not enabled.');
        const query = optionalString(args.query);
        const network = optionalString(args.network);
        const maxPrice = optionalString(args.maxPrice);
        if (maxPrice !== undefined && !/^[0-9]+$/.test(maxPrice)) {
          throw new ServiceError(400, 'Invalid price cap.');
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
        if (!opts.discovery) return toolError('Service catalog is not enabled.');
        const serviceId = optionalString(args.serviceId);
        if (!serviceId) throw new ServiceError(400, 'Missing service ID.');
        const item = opts.discovery.get(originRef, serviceId);
        if (!item) return toolError('Service not found.');
        return jsonText(item);
      }

      case 'call_service': {
        if (!opts.permit2Service) return toolError('Paid services are not enabled.');
        const serviceId = optionalString(args.serviceId);
        if (!serviceId) throw new ServiceError(400, 'Missing service ID.');
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
        throw new ServiceError(400, `Unknown tool: ${String(name)}`);
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
      const message = err instanceof ServiceError ? err.message : 'Invalid request body.';
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
