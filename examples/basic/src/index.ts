/**
 * Example dispatcher worker.
 *
 * The dispatcher is the only worker registered with Cloudflare Workflows.
 * When a tenant's code wants to start a workflow, it calls the wrapped
 * binding we hand it — which tags the create() call with the tenant's id.
 *
 * Later, when Workflows dispatches the run() call back to this dispatcher,
 * our `DynamicWorkflow` class reads the tenant id off the event, loads the
 * correct dynamic worker via the Worker Loader binding, and forwards
 * `run(event, step)` to that worker's `WorkflowEntrypoint` subclass.
 */

import {
  createDynamicWorkflowEntrypoint,
  type WorkflowRunner,
  wrapWorkflowBinding,
} from 'dynamic-workflows';
import { getTenantScript } from './tenants.js';

interface Env {
  WORKFLOWS: Workflow;
  LOADER: WorkerLoader;
}

/**
 * Load a tenant's dynamic worker. This is the one piece of glue that only the
 * dispatcher knows how to do — loading a tenant's code from wherever the
 * dispatcher keeps it and giving it a wrapped Workflow binding tagged with
 * that tenant's id.
 */
function loadTenantWorker(env: Env, tenantId: string): WorkerStub {
  return env.LOADER.get(`tenant-${tenantId}`, async () => {
    const script = getTenantScript(tenantId);
    return {
      compatibilityDate: script.compatibilityDate,
      mainModule: script.mainModule,
      modules: script.modules,
      env: {
        // Hand the tenant worker a wrapped binding. When their code calls
        // `env.WORKFLOWS.create(...)` it will automatically be tagged with
        // `{ tenantId }` so we can route the run back here.
        WORKFLOWS: wrapWorkflowBinding(env.WORKFLOWS, { tenantId }),
      },
      globalOutbound: null,
    };
  });
}

/**
 * Workflow class registered in wrangler.jsonc as `class_name: "DynamicWorkflow"`.
 *
 * When Workflows dispatches a run back to us, the wrapped entrypoint reads
 * the tenant id off the metadata we stashed at create-time, loads the
 * matching dynamic worker, and forwards `run(event, step)` to its
 * `TenantWorkflow` class.
 */
export const DynamicWorkflow = createDynamicWorkflowEntrypoint<Env>(({ env, metadata }) => {
  const tenantId = metadata['tenantId'];
  if (typeof tenantId !== 'string') {
    throw new Error('Missing tenantId in dispatcher metadata');
  }
  const stub = loadTenantWorker(env, tenantId);
  return stub.getEntrypoint('TenantWorkflow') as unknown as WorkflowRunner;
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /start?tenant=<id>  body=<json payload> — start a workflow for a tenant
    if (url.pathname === '/start' && request.method === 'POST') {
      const tenantId = url.searchParams.get('tenant');
      if (!tenantId) {
        return new Response('Missing ?tenant=<id>', { status: 400 });
      }

      let payload: unknown = {};
      try {
        const text = await request.text();
        if (text) payload = JSON.parse(text);
      } catch {
        return new Response('Invalid JSON body', { status: 400 });
      }

      // Load the tenant's dynamic worker. Its entrypoint is a normal Worker
      // (default export) — we let *it* call `env.WORKFLOWS.create()` so the
      // tenant stays in control of ids and params.
      const stub = loadTenantWorker(env, tenantId);
      const entrypoint = stub.getEntrypoint() as Fetcher;

      // Forward the request to the tenant worker — it will create the
      // workflow through the wrapped binding we gave it.
      const startRequest = new Request('https://tenant.internal/start', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      });
      return entrypoint.fetch(startRequest);
    }

    // GET /status/<id> — look up an instance
    if (url.pathname.startsWith('/status/') && request.method === 'GET') {
      const id = url.pathname.slice('/status/'.length);
      const instance = await env.WORKFLOWS.get(id);
      return Response.json({
        id: instance.id,
        status: await instance.status(),
      });
    }

    return new Response(
      'dynamic-workflows basic example\n\n' +
        'POST /start?tenant=acme   body: {"name":"world"}\n' +
        'POST /start?tenant=globex body: {"name":"world"}\n' +
        'GET  /status/<instance-id>\n',
      { headers: { 'content-type': 'text/plain' } }
    );
  },
};
