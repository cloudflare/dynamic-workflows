/**
 * In a real dispatcher this would be something like R2 / KV / a database.
 * For the demo we just hold a few tenants in memory — each tenant has its
 * own workflow implementation.
 */

export interface TenantScript {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
}

/**
 * Template used by every tenant script. The body of the `run()` method is
 * swapped per tenant. The tenant worker's default `fetch` calls
 * `env.WORKFLOWS.create()` — which is the *wrapped* binding we hand it —
 * so it transparently tags the workflow with its tenant id.
 */
function tenantScript(tenantName: string, runBody: string): string {
  return /* js */ `
import { WorkflowEntrypoint } from 'cloudflare:workers';

export class TenantWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    ${runBody}
  }
}

export default {
  async fetch(request, env) {
    const payload = await request.json().catch(() => ({}));
    const instance = await env.WORKFLOWS.create({ params: payload });
    return Response.json({
      tenant: '${tenantName}',
      id: instance.id,
      status: await instance.status(),
    });
  },
};
`;
}

const ACME_SCRIPT = tenantScript(
  'acme',
  `
    const greeting = await step.do('say hello', async () => {
      return \`Hello, \${event.payload?.name ?? 'stranger'}! (from acme)\`;
    });
    const detail = await step.do('describe tenant', async () => {
      return { tenant: 'acme', instanceId: event.instanceId };
    });
    return { greeting, detail };
  `
);

const GLOBEX_SCRIPT = tenantScript(
  'globex',
  `
    const shouted = await step.do('shout it', async () => {
      const name = event.payload?.name ?? 'world';
      return String(name).toUpperCase() + '!!! (from globex)';
    });
    return { shouted };
  `
);

export const TENANTS: Record<string, TenantScript> = {
  acme: {
    compatibilityDate: '2026-01-01',
    mainModule: 'index.js',
    modules: { 'index.js': ACME_SCRIPT },
  },
  globex: {
    compatibilityDate: '2026-01-01',
    mainModule: 'index.js',
    modules: { 'index.js': GLOBEX_SCRIPT },
  },
};

export function getTenantScript(tenantId: string): TenantScript {
  const script = TENANTS[tenantId];
  if (!script) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }
  return script;
}
