import type { RuntimeConfig } from '../config.ts';
import { ServiceError } from '../types.ts';

export type ImageGenerationResult = {
  url: string;
  model: string;
  created: number;
};

export class ImageError extends Error {
  constructor(
    readonly reason: 'timeout' | 'upstream' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

export function createImageClient(config: RuntimeConfig) {
  const base = config.llmBeefapiBaseUrl.replace(/\/+$/, '');

  return {
    async generate(input: {
      prompt: string;
      model?: string;
      size?: string;
      user?: string;
    }): Promise<ImageGenerationResult> {
      const model = input.model || 'gpt-image-2.5';
      const prompt = input.prompt.trim();
      if (!prompt) {
        throw new ServiceError(400, 'prompt must not be empty.');
      }
      if (prompt.length > 2000) {
        throw new ServiceError(400, 'prompt must be at most 2000 characters.');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);

      try {
        const response = await fetch(`${base}/v1/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.llmBeefapiApiKey}`,
          },
          body: JSON.stringify({
            model,
            prompt,
            size: input.size || '1024x1024',
            n: 1,
            user: input.user,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new ImageError('upstream', 'The image generation provider rejected the request.');
        }

        const data = (await response.json()) as {
          created?: number;
          data?: Array<{ url?: string; b64_json?: string }>;
        };

        const first = data.data?.[0];
        const url = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : null);
        if (!url) {
          throw new ImageError('malformed', 'The image generation provider returned no image URL.');
        }

        return {
          url,
          model,
          created: data.created ?? Math.floor(Date.now() / 1000),
        };
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          throw new ImageError('timeout', 'Image generation timed out.');
        }
        if (err instanceof ImageError || err instanceof ServiceError) throw err;
        throw new ImageError('upstream', 'The image generation provider did not respond.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
