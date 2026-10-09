import type { RuntimeConfig } from '../config.ts';
import { ServiceError } from '../types.ts';

export type VideoGenerationResult = {
  url: string;
  model: string;
  taskId: string;
};

export class VideoGenError extends Error {
  constructor(
    readonly reason: 'timeout' | 'upstream' | 'malformed' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'VideoGenError';
  }
}

export function createVideoGenClient(config: RuntimeConfig) {
  const base = config.llmBeefapiBaseUrl.replace(/\/+$/, '');

  return {
    async generate(input: {
      prompt: string;
      model?: string;
    }): Promise<VideoGenerationResult> {
      const model = input.model || 'wan3.0-video';
      const prompt = input.prompt.trim();
      if (!prompt) {
        throw new ServiceError(400, 'prompt must not be empty.');
      }
      if (prompt.length > 2000) {
        throw new ServiceError(400, 'prompt must be at most 2000 characters.');
      }

      // 1. Submit task
      let taskId = '';
      try {
        const submitRes = await fetch(`${base}/v1/videos`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.llmBeefapiApiKey}`,
          },
          body: JSON.stringify({ model, prompt }),
        });
        if (!submitRes.ok) {
          throw new VideoGenError('upstream', 'Failed to submit video generation task.');
        }
        const submitData = (await submitRes.json()) as { id?: string; task_id?: string };
        taskId = submitData.id || submitData.task_id || '';
      } catch (err) {
        if (err instanceof VideoGenError) throw err;
        throw new VideoGenError('upstream', 'Video provider did not respond to submit.');
      }

      if (!taskId) {
        throw new VideoGenError('malformed', 'Video provider returned no task ID.');
      }

      // 2. Poll until completed or timeout (120 seconds max)
      const start = Date.now();
      const MAX_WAIT_MS = 120_000;
      const POLL_INTERVAL_MS = 3_000;

      while (Date.now() - start < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        try {
          const pollRes = await fetch(`${base}/v1/videos/${taskId}`, {
            headers: {
              Authorization: `Bearer ${config.llmBeefapiApiKey}`,
            },
          });
          if (!pollRes.ok) continue;

          const task = (await pollRes.json()) as {
            status?: string;
            metadata?: { url?: string };
            url?: string;
            error?: string;
          };

          if (task.status === 'completed' || task.status === 'succeeded') {
            const url = task.url || task.metadata?.url;
            if (!url) {
              throw new VideoGenError('malformed', 'Video task completed but returned no URL.');
            }
            return { url, model, taskId };
          }
          if (task.status === 'failed') {
            throw new VideoGenError('failed', task.error || 'Video generation task failed.');
          }
        } catch (err) {
          if (err instanceof VideoGenError) throw err;
          // Transient poll errors are retried
        }
      }

      throw new VideoGenError('timeout', 'Video generation timed out.');
    },
  };
}
