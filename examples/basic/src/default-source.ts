/**
 * Seed code that appears in the editor on first page load.
 *
 * The editor submits this source verbatim to the Worker Loader — no
 * TypeScript, no bundling, no npm installs. Whatever JavaScript the user
 * writes here runs as the tenant worker.
 *
 * The only contract is:
 *   - It must export a default `{ fetch }` handler that creates the workflow
 *     via `env.WORKFLOWS.create({ id, params })`. The dispatcher calls this
 *     handler to kick off a run.
 *   - It must export a `TenantWorkflow` class that extends `WorkflowEntrypoint`
 *     — the Workflows engine invokes `TenantWorkflow.run()` via the
 *     dispatcher.
 */

export const DEFAULT_SOURCE = `import { WorkflowEntrypoint } from 'cloudflare:workers';

// --- Your workflow -------------------------------------------------------
//
// Edit this to build whatever pipeline you like. Each \`step.do()\` appears
// as a checkpoint in the UI; \`console.log()\` output streams live.

export class TenantWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const name = event.payload?.name ?? 'world';
    console.log('starting workflow for', name);

    const greeting = await step.do('compose greeting', async () => {
      const message = \`Hello, \${name}!\`;
      console.log('composed:', message);
      return message;
    });

    await step.sleep('pause for effect', '2 seconds');

    const shouted = await step.do('shout it', async () => {
      const result = greeting.toUpperCase() + '!!!';
      console.warn('shouting:', result);
      return result;
    });

    await step.sleep('catch breath', '2 seconds');

    const summary = await step.do('summarise', async () => {
      return {
        original: greeting,
        shouted,
        length: shouted.length,
      };
    });

    console.log('done, returning', summary);
    return summary;
  }
}

// --- Plumbing ------------------------------------------------------------
//
// The dispatcher POSTs { id, payload } to this handler with the pre-allocated
// runId. We forward it straight into \`env.WORKFLOWS.create()\` — which is the
// wrapped binding provided by dynamic-workflows, so the tenant id travels
// along automatically.

export default {
  async fetch(request, env) {
    const { id, payload } = await request.json();
    const instance = await env.WORKFLOWS.create({ id, params: payload });
    return Response.json({
      id: await instance.id,
      status: await instance.status(),
    });
  },
};
`;
