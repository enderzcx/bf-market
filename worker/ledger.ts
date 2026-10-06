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

// Single Durable Object instance that owns the whole application. Every request
// is routed here (idFromName('ledger')), so the ops signer's nonce queue, the
// payment idempotency locks and the starter-gas budget stay serialized in one
// place. State lives in ctx.storage.sql, which survives restarts and evictions.
export class Ledger extends DurableObject<Env> {
  private readonly app: SettlementApp;

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
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}
