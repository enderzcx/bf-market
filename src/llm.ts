import type { RuntimeConfig } from './config.ts';
import { ServiceError } from './types.ts';

// BeefAPI-backed metered LLM services (M5). Pricing is quoted per million
// tokens in USD and settled in 6-decimal USDT, so one token costs exactly
// `price_usd_per_million` atomic units of USDT:
//
//   cost_atomic = tokens * P_usd_per_1M     (because 1 USD = 1e6 atomic, 1e6 tokens)
//
// Prices are stored as micro-USD per million tokens (`P * 1e6`) so fractional
// retail prices survive integer math. See specs/schemes/upto for the scheme the
// 402 offer uses.
export type MeteredPricing = {
  modelId: string;
  inputMicroUsdPerMillion: bigint;
  outputMicroUsdPerMillion: bigint;
};

const MICRO = 1_000_000n;

export const LLM_MAX_CONTENT_CHARS = 8000;
export const LLM_DEFAULT_MAX_TOKENS = 1000;
export const LLM_MAX_MAX_TOKENS = 2000;
export const LLM_REQUEST_TIMEOUT_MS = 60_000;
// Reserve this much of the authorization deadline before calling the upstream,
// so a slow model call can still be settled before the signature expires.
export const LLM_SETTLE_MARGIN_SECONDS = 90;

// Overseas retail prices (USD per 1M tokens): input / output.
export const METERED_PRICING: Record<string, MeteredPricing> = {
  'glm-5.3': {
    modelId: 'glm-5.3',
    inputMicroUsdPerMillion: 1_000_000n,
    outputMicroUsdPerMillion: 3_200_000n,
  },
  'claude-opus-5-5': {
    modelId: 'claude-opus-5-5',
    inputMicroUsdPerMillion: 1_600_000n,
    outputMicroUsdPerMillion: 8_000_000n,
  },
  'gpt-6-astra': {
    modelId: 'gpt-6-astra',
    inputMicroUsdPerMillion: 3_000_000n,
    outputMicroUsdPerMillion: 15_000_000n,
  },
};

export type MeteredMessage = { role: string; content: string };

export type MeteredRequest = {
  messages: MeteredMessage[];
  maxTokens: number;
  inputChars: number;
  // Conservative prompt estimate: one token per two characters, rounded up.
  // Retail tokenizers average ~4 English chars/token and ~1-2 CJK chars/token,
  // so `chars / 2` never undercounts the billable prompt for either script.
  inputTokens: bigint;
};

export type LlmUsage = { promptTokens: number; completionTokens: number };

export type LlmChatResult = {
  content: string;
  usage: LlmUsage;
  upstreamRequestId: string | null;
};

export class LlmError extends Error {
  constructor(
    readonly reason: 'timeout' | 'upstream' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function tokensCost(tokens: bigint, microUsdPerMillion: bigint): bigint {
  return ceilDiv(tokens * microUsdPerMillion, MICRO);
}

// Parses and bounds the OpenAI chat request. Throws 400 with a buyer-facing
// reason so the client can fix the body before paying.
export function parseMeteredRequest(body: Record<string, unknown>): MeteredRequest {
  if (body.stream !== undefined && body.stream !== false) {
    throw new ServiceError(400, 'Streaming is not supported; set stream to false.');
  }
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ServiceError(400, 'messages must be a non-empty array.');
  }
  const messages: MeteredMessage[] = [];
  let inputChars = 0;
  for (const item of rawMessages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ServiceError(400, 'Each message must be an object with role and content.');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.role !== 'string' || row.role.length === 0) {
      throw new ServiceError(400, 'Each message must have a role.');
    }
    if (typeof row.content !== 'string') {
      throw new ServiceError(400, 'Each message must have string content.');
    }
    inputChars += row.content.length;
    messages.push({ role: row.role, content: row.content });
  }
  if (inputChars > LLM_MAX_CONTENT_CHARS) {
    throw new ServiceError(
      400,
      `Total content length must be at most ${LLM_MAX_CONTENT_CHARS} characters.`,
    );
  }
  let maxTokens = LLM_DEFAULT_MAX_TOKENS;
  if (body.max_tokens !== undefined) {
    if (
      typeof body.max_tokens !== 'number' ||
      !Number.isInteger(body.max_tokens) ||
      body.max_tokens <= 0
    ) {
      throw new ServiceError(400, 'max_tokens must be a positive integer.');
    }
    if (body.max_tokens > LLM_MAX_MAX_TOKENS) {
      throw new ServiceError(400, `max_tokens must be at most ${LLM_MAX_MAX_TOKENS}.`);
    }
    maxTokens = body.max_tokens;
  }
  const inputTokens = BigInt(Math.ceil(inputChars / 2));
  return { messages, maxTokens, inputChars, inputTokens };
}

// Upper bound quoted in the 402: worst-case prompt plus the full completion
// allowance. The final charge is computed from the upstream usage and is capped
// at this amount.
export function meteredUpperBound(pricing: MeteredPricing, request: MeteredRequest): bigint {
  return (
    tokensCost(request.inputTokens, pricing.inputMicroUsdPerMillion) +
    tokensCost(BigInt(request.maxTokens), pricing.outputMicroUsdPerMillion)
  );
}

// Actual charge for a completed call, capped at the quoted upper bound.
export function meteredCharge(
  pricing: MeteredPricing,
  usage: LlmUsage,
  upperBound: bigint,
): bigint {
  const raw =
    tokensCost(BigInt(usage.promptTokens), pricing.inputMicroUsdPerMillion) +
    tokensCost(BigInt(usage.completionTokens), pricing.outputMicroUsdPerMillion);
  return raw > upperBound ? upperBound : raw;
}

function normalizeUsage(value: unknown): LlmUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const prompt = row.prompt_tokens;
  const completion = row.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  if (prompt < 0 || completion < 0) return null;
  return { promptTokens: prompt, completionTokens: completion };
}

export type LlmClient = ReturnType<typeof createLlmClient>;

export function createLlmClient(config: RuntimeConfig) {
  const base = config.llmBeefapiBaseUrl.replace(/\/+$/, '');

  return {
    async chat(input: {
      model: string;
      messages: MeteredMessage[];
      maxTokens: number;
      user: string;
    }): Promise<LlmChatResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.llmRequestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.llmBeefapiApiKey}`,
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages,
            max_tokens: input.maxTokens,
            stream: false,
            user: input.user,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        // Never surface the upstream error text: it may echo the request, and
        // the request carries the API key.
        throw new LlmError(
          (err as Error)?.name === 'AbortError' ? 'timeout' : 'upstream',
          'The model provider did not respond.',
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new LlmError('upstream', 'The model provider rejected the request.');
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new LlmError('malformed', 'The model provider returned an invalid response.');
      }
      const row = (data ?? {}) as Record<string, unknown>;
      const usage = normalizeUsage(row.usage);
      const choices = row.choices;
      const first =
        Array.isArray(choices) && choices.length > 0
          ? (choices[0] as Record<string, unknown>)
          : null;
      const message =
        first && first.message && typeof first.message === 'object'
          ? (first.message as Record<string, unknown>)
          : null;
      const content = message && typeof message.content === 'string' ? message.content : null;
      if (!usage || content === null) {
        throw new LlmError('malformed', 'The model provider returned no usage or content.');
      }
      return {
        content,
        usage,
        upstreamRequestId: typeof row.id === 'string' ? row.id : null,
      };
    },
  };
}
