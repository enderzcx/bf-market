import { Ledger } from './ledger.ts';
import type { Env } from './env.ts';

export { Ledger };

// Stateless entry point. Static assets (web/dist) are served by Workers Assets
// for every path that is not listed in `assets.run_worker_first`; the dynamic
// paths listed there reach this fetch and are forwarded to the one Ledger
// Durable Object so the ledger and the ops signer stay single-threaded.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.Ledger.idFromName('ledger');
    return env.Ledger.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
