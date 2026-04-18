/**
 * Interactive playground dispatcher.
 *
 * The user writes a JavaScript Worker that defines a `TenantWorkflow` class.
 * Hitting "Run" POSTs that code plus a JSON payload to `/api/run`. We:
 *
 *   1. Allocate a `runId` (also used as the Workflow instance id and the
 *      LogSession DO key).
 *   2. Load the user's code as a dynamic worker, attaching a Tail Worker
 *      that forwards every `console.log()` / exception into the matching
 *      `LogSession` DO.
 *   3. Forward an HTTP request to the tenant's `default.fetch`, which calls
 *      the wrapped `env.WORKFLOWS.create({ id: runId, params })`.
 *   4. The browser subscribes to `/api/stream/:runId` (Server-Sent Events)
 *      to watch logs arrive in real time, and polls `/api/status/:runId`
 *      to drive the step timeline.
 *
 * One `DynamicWorkflow` class is still registered with Cloudflare Workflows.
 * `dynamic-workflows` handles the routing back to whichever tenant worker
 * the dispatcher last loaded for that runId.
 */

import { exports as workersExports } from 'cloudflare:workers';
import {
  createDynamicWorkflowEntrypoint,
  DynamicWorkflowBinding,
  type WorkflowRunner,
  wrapWorkflowBinding,
} from 'dynamic-workflows';
import { DASHBOARD_HTML } from './dashboard.js';
import { DEFAULT_SOURCE } from './default-source.js';
import { DynamicWorkerTail, getLogSession, LogSession, streamLogsResponse } from './logging.js';

// `wrapWorkflowBinding()` looks these up on `cloudflare:workers` `exports`.
// The Tail Worker and Durable Object are discovered by the runtime the same
// way — all three MUST be top-level named exports.
export { DynamicWorkerTail, DynamicWorkflowBinding, LogSession };

interface Env {
  WORKFLOWS: Workflow;
  LOADER: WorkerLoader;
}

/**
 * Load (or fetch the cached) tenant worker for a given run.
 *
 * The loader caches by id — the callback is only invoked on cache miss.
 * On a cache miss we fetch the source from the per-run LogSession DO,
 * so workflow runs that resume after an isolate recycle can still find
 * their code.
 */
function loadTenantWorker(env: Env, runId: string): WorkerStub {
  const exports = workersExports as unknown as {
    DynamicWorkerTail: (init: { props: { runId: string } }) => Fetcher;
  };

  return env.LOADER.get(`run-${runId}`, async () => {
    const session = getLogSession(runId);
    const source = await session.getSource();
    if (!source) {
      throw new Error(`No source registered for run ${runId}`);
    }
    return {
      compatibilityDate: '2026-01-28',
      mainModule: 'index.js',
      modules: { 'index.js': source },
      env: {
        // Tagged with runId so we can route workflow runs back to this worker.
        WORKFLOWS: wrapWorkflowBinding({ runId }),
      },
      globalOutbound: null,
      // Attach a *streaming* tail so every console.log() / exception is
      // delivered in real time. The non-streaming `tails:` field only fires
      // at the end of each invocation and doesn't capture logs emitted
      // inside workflow `run()` calls during local dev. Streaming tails
      // are experimental so we have to opt in explicitly.
      allowExperimental: true,
      streamingTails: [exports.DynamicWorkerTail({ props: { runId } })],
    };
  });
}

/**
 * Registered as `class_name: "DynamicWorkflow"` in wrangler.jsonc.
 *
 * `dynamic-workflows` has already unwrapped the envelope and handed us the
 * `runId` by the time `loadRunner` is called. We re-load the same dynamic
 * worker (the loader caches it by id), get a reference to the tenant's
 * `TenantWorkflow` class, and delegate `run(event, step)` to it.
 */
export const DynamicWorkflow = createDynamicWorkflowEntrypoint<Env>(({ env, metadata }) => {
  const runId = metadata['runId'];
  if (typeof runId !== 'string') {
    throw new Error('Missing runId in dispatcher metadata');
  }
  const stub = loadTenantWorker(env, runId);
  return stub.getEntrypoint('TenantWorkflow') as unknown as WorkflowRunner;
});

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- Dashboard ---------------------------------------------------
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // GET /api/source — default seed code for first page load.
    if (url.pathname === '/api/source' && request.method === 'GET') {
      return new Response(DEFAULT_SOURCE, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }

    // POST /api/run — body: { source: string, payload?: unknown }
    if (url.pathname === '/api/run' && request.method === 'POST') {
      let body: { source?: string; payload?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const source = body.source;
      if (!source || typeof source !== 'string') {
        return json({ error: 'Missing source code' }, { status: 400 });
      }

      const runId = crypto.randomUUID();
      // Stash the source in the per-run DO so the workflow run() can reload
      // the same code later if the isolate recycles.
      await getLogSession(runId).setSource(source);

      const stub = loadTenantWorker(env, runId);

      try {
        // Forward into the tenant worker so it calls env.WORKFLOWS.create()
        // itself, via the wrapped binding. We pass the pre-allocated runId
        // so the Workflow instance id matches our LogSession key.
        const res = await (stub.getEntrypoint() as Fetcher).fetch(
          new Request('https://tenant.internal/start', {
            method: 'POST',
            body: JSON.stringify({ id: runId, payload: body.payload ?? {} }),
            headers: { 'content-type': 'application/json' },
          })
        );
        if (!res.ok) {
          const text = await res.text();
          return json(
            { error: text || 'Tenant returned error', status: res.status },
            { status: 500 }
          );
        }
        const created = (await res.json()) as { id: string; status: unknown };
        return json({ runId, id: created.id, status: created.status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, { status: 500 });
      }
    }

    // GET /api/status/:runId
    if (url.pathname.startsWith('/api/status/') && request.method === 'GET') {
      const runId = decodeURIComponent(url.pathname.slice('/api/status/'.length));
      try {
        const instance = await env.WORKFLOWS.get(runId);
        return json({ id: instance.id, status: await instance.status() });
      } catch (err) {
        return json({ error: (err as Error).message }, { status: 404 });
      }
    }

    // GET /api/stream/:runId — Server-Sent Events stream of log entries.
    if (url.pathname.startsWith('/api/stream/') && request.method === 'GET') {
      const runId = decodeURIComponent(url.pathname.slice('/api/stream/'.length));
      return streamLogsResponse(runId, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};
