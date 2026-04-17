# dynamic-workflows

Integrate [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) with [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/).

Cloudflare Workflows binds a workflow to a single, static `class_name` at deploy time — there is no built-in way to run a different workflow implementation per tenant / per request. If you're building a platform where each customer runs their own code inside a dynamic worker, you need a tiny bit of glue to route a workflow's `run()` call to the correct customer's dynamic worker.

This library is that glue.

## How it works

```
┌──────────── Dispatcher Worker ────────────┐          ┌──── Tenant's dynamic worker ────┐
│                                           │          │                                 │
│  env.WORKFLOWS (real Workflow binding)    │          │  env.WORKFLOWS (wrapped!)       │
│                                           │          │                                 │
│                                           │          │  ── env.WORKFLOWS.create({      │
│                                           │          │        params: { ... }          │
│                                           │          │      })                         │
│                                           │          │         │                       │
│  ┌──── wrapWorkflowBinding ──────────┐    │  tags    │         │                       │
│  │ injects { __dispatcherMetadata,   │◀───┼──────────┼─────────┘                       │
│  │   params } into create(...)       │    │          │                                 │
│  └────────────────┬──────────────────┘    │          └─────────────────────────────────┘
│                   │                       │
│                   ▼                       │
│            Workflows engine               │
│                   │                       │
│                   │ run(event, step)      │
│                   ▼                       │
│  ┌── createDynamicWorkflowEntrypoint ──┐  │          ┌──── Tenant's dynamic worker ────┐
│  │ pulls metadata off event.payload    │  │          │                                 │
│  │ loadRunner({metadata, env, ctx})    │──┼─────────▶│  class TenantWorkflow           │
│  │ forwards run(innerEvent, step)      │  │          │    extends WorkflowEntrypoint { │
│  └─────────────────────────────────────┘  │          │      run(event, step) { … }     │
└───────────────────────────────────────────┘          │    }                            │
                                                       └─────────────────────────────────┘
```

1. The dispatcher gives each dynamic worker a **wrapped** `Workflow` binding via `wrapWorkflowBinding(env.WORKFLOWS, { tenantId })`. When the dynamic worker calls `env.WORKFLOWS.create({ params })`, the wrapper transparently replaces `params` with `{ __dispatcherMetadata: { tenantId }, params }` before calling the real binding.
2. The dispatcher registers a single `WorkflowEntrypoint` class — built with `createDynamicWorkflowEntrypoint(loader)` — as the workflow's `class_name`.
3. When Workflows later invokes the dispatcher, the wrapped entrypoint pulls `__dispatcherMetadata` back out of the event, calls the dispatcher's `loader({ metadata, env, ctx })`, and forwards `run(innerEvent, step)` to whatever dynamic worker that loader returned.

The dispatcher is still in full control of how it loads tenant code (Worker Loader, service bindings, whatever) — this library just moves the tenant id between the two halves of the dance.

## Installation

```bash
npm install dynamic-workflows
```

## Quick Start

```typescript
// dispatcher/src/index.ts
import {
  createDynamicWorkflowEntrypoint,
  wrapWorkflowBinding,
  type WorkflowRunner,
} from 'dynamic-workflows';

interface Env {
  WORKFLOWS: Workflow;
  LOADER: WorkerLoader;
}

// Load a tenant's dynamic worker and give it a wrapped WORKFLOWS binding.
function loadTenantWorker(env: Env, tenantId: string) {
  return env.LOADER.get(tenantId, async () => {
    const code = await loadTenantCodeFromStorage(tenantId); // your code
    return {
      compatibilityDate: '2026-01-01',
      mainModule: 'index.js',
      modules: { 'index.js': code },
      env: {
        // The tenant will use this exactly like the real Workflow binding.
        // Every create() will be tagged with { tenantId } automatically.
        WORKFLOWS: wrapWorkflowBinding(env.WORKFLOWS, { tenantId }),
      },
      globalOutbound: null,
    };
  });
}

// The workflow class that Cloudflare Workflows actually invokes.
// Register this in wrangler.jsonc as class_name: "DynamicWorkflow".
export const DynamicWorkflow = createDynamicWorkflowEntrypoint<Env>(
  async ({ env, metadata }) => {
    const tenantId = metadata.tenantId as string;
    const stub = loadTenantWorker(env, tenantId);
    // The tenant exports a `TenantWorkflow` class (any name works).
    return stub.getEntrypoint('TenantWorkflow') as unknown as WorkflowRunner;
  }
);

export default {
  async fetch(request: Request, env: Env) {
    const tenantId = request.headers.get('x-tenant-id')!;
    const stub = loadTenantWorker(env, tenantId);
    return stub.getEntrypoint().fetch(request);
  },
};
```

```jsonc
// dispatcher/wrangler.jsonc
{
  "name": "my-dispatcher",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "worker_loaders": [{ "binding": "LOADER" }],
  "workflows": [
    {
      "name": "dynamic-workflow",
      "binding": "WORKFLOWS",
      "class_name": "DynamicWorkflow"
    }
  ]
}
```

And inside a tenant's dynamic worker:

```typescript
// This file is the tenant's code, loaded at runtime by the dispatcher.
import { WorkflowEntrypoint } from 'cloudflare:workers';

export class TenantWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const greeting = await step.do('say hello', async () => {
      return `Hello, ${event.payload?.name}!`;
    });
    return { greeting };
  }
}

export default {
  async fetch(request, env) {
    // `env.WORKFLOWS` is the wrapped binding — this call is automatically
    // tagged with the tenant id the dispatcher attached.
    const body = await request.json();
    const instance = await env.WORKFLOWS.create({ params: body });
    return Response.json({ id: instance.id });
  },
};
```

## API

### `wrapWorkflowBinding(binding, metadata)`

Wrap a `Workflow` binding so that every `create` / `createBatch` call
stashes `metadata` alongside the user's `params`.

| Argument   | Type                       | Description                                                                                              |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `binding`  | `Workflow` (or compatible) | The real Workflow binding from the dispatcher's `env`.                                                   |
| `metadata` | `Record<string, unknown>`  | Any JSON-serializable object. Typically `{ tenantId }`, but feel free to put routing hints, region, etc. |

Returns a binding with the same shape as the input (`create`, `createBatch`, `get`).

### `createDynamicWorkflowEntrypoint<Env, Params, Result>(loadRunner)`

Returns a `WorkflowEntrypoint` subclass. Register the returned class as the `class_name` of your `[[workflows]]` binding.

The `loadRunner` callback is invoked once per `run()` call. It receives:

| Field      | Type                      | Description                                                                   |
| ---------- | ------------------------- | ----------------------------------------------------------------------------- |
| `metadata` | `Record<string, unknown>` | Whatever was passed to `wrapWorkflowBinding` when this workflow was created.  |
| `env`      | `Env`                     | The dispatcher's own `env` (e.g. your `WorkerLoader` binding lives here).     |
| `ctx`      | `ExecutionContext`        | The dispatcher's `ExecutionContext`.                                          |

and must return an object with a `run(event, step)` method. The easiest way to satisfy that is to return `stub.getEntrypoint('SomeClass')` from a Worker Loader, pointing at a class that `extends WorkflowEntrypoint` inside the dynamic worker.

### `dispatchWorkflow(context, event, step, loadRunner)`

The underlying implementation used by `createDynamicWorkflowEntrypoint`. Useful if you want to subclass `WorkflowEntrypoint` yourself (e.g. to layer in extra logging or custom error handling):

```typescript
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { dispatchWorkflow } from 'dynamic-workflows';

export class MyDynamicWorkflow extends WorkflowEntrypoint<Env> {
  async run(event, step) {
    console.log('workflow started', event.instanceId);
    try {
      return await dispatchWorkflow(
        { env: this.env, ctx: this.ctx },
        event,
        step,
        async ({ metadata, env }) => loadRunnerForTenant(env, metadata)
      );
    } finally {
      console.log('workflow finished', event.instanceId);
    }
  }
}
```

### `MissingDispatcherMetadataError`

Thrown from `run()` if the `WorkflowEvent` payload is not a dispatcher envelope. This indicates the workflow was created against the raw binding instead of one wrapped with `wrapWorkflowBinding`.

## Caveats

- **Persisted payloads contain metadata**. Workflows persists `event.payload` so it can replay steps. The envelope — including your dispatcher metadata — is part of that persisted payload. Don't put secrets in metadata.
- **Metadata is user-visible to tenant code**. A workflow created through the wrapped binding has access to the envelope via `await instance.status()` (and similar) before the library ever sees it. Treat metadata as untrusted routing information, not authorization.
- **The envelope shape is an implementation detail**. The library only promises that `wrapWorkflowBinding` and `createDynamicWorkflowEntrypoint` are compatible with each other — don't parse the persisted payload by hand.

## License

MIT
