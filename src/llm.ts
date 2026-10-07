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
  // `video` services take {video_url, prompt} instead of chat messages.
  input?: 'chat' | 'video';
  // Input-token allowance in the fixed quote; defaults to LLM_QUOTE_INPUT_TOKENS.
  quoteInputTokens?: bigint;
};

const MICRO = 1_000_000n;

export const LLM_MAX_CONTENT_CHARS = 8000;
export const LLM_DEFAULT_MAX_TOKENS = 1000;
export const LLM_MAX_MAX_TOKENS = 2000;
export const LLM_REQUEST_TIMEOUT_MS = 60_000;
// Reserve this much of the authorization deadline before calling the upstream,
// so a slow model call can still be settled before the signature expires.
export const LLM_SETTLE_MARGIN_SECONDS = 90;

// The 402 quote is a fixed per-model maximum, the same for every request.
// Upstream models add hidden prompt tokens (system prompts, tool scaffolding)
// that a client-side estimate cannot see, so a quote keyed to the request body
// undercounts and the provider absorbs the difference. `upto` settles only the
// actual usage, so a cap above the real cost never costs the buyer more than
// the call used. The input allowance covers a realistic hidden prefix; the
// output allowance is the largest request (LLM_MAX_MAX_TOKENS) plus 10%,
// computed with integer math so 1.1 never rounds up from floating point.
export const LLM_QUOTE_INPUT_TOKENS = 12_000n;
export const LLM_QUOTE_OUTPUT_TOKENS = (BigInt(LLM_MAX_MAX_TOKENS) * 11n + 9n) / 10n;

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
  // Native video understanding. A minute of video is roughly 16k input tokens,
  // so the quote allows 64k input tokens instead of the chat default.
  'gemini-3.8-flash': {
    modelId: 'gemini-3.8-flash',
    inputMicroUsdPerMillion: 500_000n,
    outputMicroUsdPerMillion: 3_000_000n,
    input: 'video',
    quoteInputTokens: 64_000n,
  },
};

export const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_MAX_PROMPT_CHARS = 4000;
export const VIDEO_FETCH_TIMEOUT_MS = 30_000;
// Video calls take far longer than chat; 150s still settles inside the 300s
// authorization window after LLM_SETTLE_MARGIN_SECONDS.
export const VIDEO_REQUEST_TIMEOUT_MS = 150_000;
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export type MeteredMessage = { role: string; content: string };

export type MeteredRequest = {
  messages: MeteredMessage[];
  maxTokens: number;
  video?: { url: string };
};

export type LlmUsage = { promptTokens: number; completionTokens: number };

export type LlmChatResult = {
  content: string;
  usage: LlmUsage;
  upstreamRequestId: string | null;
};

export class LlmError extends Error {
  constructor(
    readonly reason: 'timeout' | 'upstream' | 'malformed' | 'video',
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

function parseMaxTokens(body: Record<string, unknown>): number {
  if (body.max_tokens === undefined) return LLM_DEFAULT_MAX_TOKENS;
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
  return body.max_tokens;
}

// The server fetches the video itself, so only public https hosts are allowed:
// no credentials, no IP literals, no local names.
export function parseVideoUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new ServiceError(400, 'video_url must be an https URL of at most 2048 characters.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError(400, 'video_url must be an https URL of at most 2048 characters.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !host.includes('.') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new ServiceError(400, 'video_url must be a public https URL.');
  }
  return url.toString();
}

function parseVideoRequest(body: Record<string, unknown>): MeteredRequest {
  const url = parseVideoUrl(body.video_url);
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
    throw new ServiceError(400, 'prompt must be a non-empty string.');
  }
  if (body.prompt.length > VIDEO_MAX_PROMPT_CHARS) {
    throw new ServiceError(400, `prompt must be at most ${VIDEO_MAX_PROMPT_CHARS} characters.`);
  }
  return {
    messages: [{ role: 'user', content: body.prompt }],
    maxTokens: parseMaxTokens(body),
    video: { url },
  };
}

// Parses and bounds the request. Throws 400 with a buyer-facing reason so the
// client can fix the body before paying.
export function parseMeteredRequest(
  body: Record<string, unknown>,
  pricing?: MeteredPricing,
): MeteredRequest {
  if (body.stream !== undefined && body.stream !== false) {
    throw new ServiceError(400, 'Streaming is not supported; set stream to false.');
  }
  if (pricing?.input === 'video') return parseVideoRequest(body);
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
  return { messages, maxTokens: parseMaxTokens(body) };
}

// Fixed 402 quote for a metered service, independent of the request body (see
// LLM_QUOTE_INPUT_TOKENS). The final charge is the actual usage capped here.
export function meteredUpperBound(pricing: MeteredPricing): bigint {
  return (
    tokensCost(pricing.quoteInputTokens ?? LLM_QUOTE_INPUT_TOKENS, pricing.inputMicroUsdPerMillion) +
    tokensCost(LLM_QUOTE_OUTPUT_TOKENS, pricing.outputMicroUsdPerMillion)
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

function videoMimeOf(url: string, contentType: string | null): string | null {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('video/')) return type;
  // Static hosts often serve video as application/octet-stream.
  if (type !== '' && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    return null;
  }
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_MIME_BY_EXT[ext] ?? null;
}

// Downloads the buyer's video with a size cap and returns it as a data URL.
export async function fetchVideoDataUrl(url: string): Promise<string> {
  const fail = () => {
    throw new LlmError(
      'video',
      `The video could not be fetched. Use a public https URL to a video of at most ${VIDEO_MAX_BYTES / 1024 / 1024} MB.`,
    );
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    } catch {
      return fail();
    }
    if (!response.ok || !response.body) return fail();
    // Redirects must land on a public https URL too.
    try {
      parseVideoUrl(response.url || url);
    } catch {
      return fail();
    }
    const mime = videoMimeOf(response.url || url, response.headers.get('content-type'));
    if (!mime) return fail();
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > VIDEO_MAX_BYTES) return fail();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch {
        return fail();
      }
      if (step.done) break;
      received += step.value.byteLength;
      if (received > VIDEO_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return fail();
      }
      chunks.push(step.value);
    }
    if (received === 0) return fail();
    return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
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
      video?: { url: string };
    }): Promise<LlmChatResult> {
      let messages: unknown[] = input.messages;
      if (input.video) {
        const dataUrl = await fetchVideoDataUrl(input.video.url);
        messages = input.messages.map((message, index) =>
          index === input.messages.length - 1
            ? {
                role: message.role,
                content: [
                  { type: 'text', text: message.content },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              }
            : message,
        );
      }
      const controller = new AbortController();
      const timeoutMs = input.video
        ? Math.max(config.llmRequestTimeoutMs, VIDEO_REQUEST_TIMEOUT_MS)
        : config.llmRequestTimeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
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
            messages,
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
