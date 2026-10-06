import { DurableObject } from 'cloudflare:workers';
import { createDoDb, type SqlLike } from '../src/db.ts';
import {
  createApp,
  createDisabledChain,
  runtimeFingerprint,
  type SettlementApp,
} from '../src/server.ts';
import { createSource } from '../src/source.ts';
import { createStore } from '../src/store.ts';
import { createWorker } from '../src/worker.ts';
import { configFromEnv } from './config.ts';
import type { Env } from './env.ts';
import { createSeedHandler } from './seed.ts';

// Single Durable Object instance that owns the whole application. Every request
// is routed here (idFromName('ledger')), so the ops signer's nonce queue, the
// payment idempotency locks and the starter-gas budget stay serialized in one
// place. State lives in ctx.storage.sql, which survives restarts and evictions.
export class Ledger extends DurableObject<Env> {
  private readonly app: SettlementApp;
  private readonly seed: (req: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = configFromEnv(env);
    const db = createDoDb(
      ctx.storage.sql as unknown as SqlLike,
      (fn) => ctx.storage.transactionSync(fn),
    );
    const store = createStore({
      path: ':memory:',
      db,
      fingerprint: runtimeFingerprint(config),
    });
    // botchain-testnet has no Settlement payout contract, so the payout chain is
    // disabled and the Fuji payout worker is never started in the Worker entry.
    const chain = createDisabledChain(config);
    const source = createSource(store, config);
    const worker = createWorker({ store, chain, source, config });
    this.app = createApp({
      store,
      worker,
      chain,
      source,
      config,
      publicDir: '',
      // Workers Assets serves web/dist before the Worker is invoked.
      staticFileResolver: () => null,
    });
    // One-shot identity seed, handled here and never registered in the shared
    // app so the Bun entry exposes no seed surface.
    this.seed = createSeedHandler({ store, config, token: env.SEED_TOKEN });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/seed') {
      return this.seed(request);
    }
    return this.app.fetch(request);
  }
}
