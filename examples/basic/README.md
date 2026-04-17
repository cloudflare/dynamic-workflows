# basic-example

A minimal dispatcher worker that shows `dynamic-workflows` in action.

Two hard-coded tenants (`acme` and `globex`) each have their own workflow implementation. The dispatcher itself knows nothing about workflow steps — it just loads a tenant's code via the Worker Loader binding and lets `dynamic-workflows` route the `run()` call back to the right tenant.

## Run

```bash
pnpm install
pnpm run build            # builds the dynamic-workflows library
pnpm --filter=basic-example run dev
```

Then:

```bash
# Start a workflow for tenant `acme`
curl -X POST 'http://localhost:8787/start?tenant=acme' \
  -H 'content-type: application/json' \
  -d '{"name":"world"}'
# → { "tenant": "acme", "id": "...", "status": { ... } }

# Start one for tenant `globex`
curl -X POST 'http://localhost:8787/start?tenant=globex' \
  -H 'content-type: application/json' \
  -d '{"name":"hello"}'

# Check status
curl 'http://localhost:8787/status/<instance-id>'
```

Both tenants' workflows are executed through the **same** `DynamicWorkflow` class registered with Cloudflare Workflows — but each actually runs inside its own tenant's dynamic worker.

## What to read

- [`src/index.ts`](./src/index.ts) — the dispatcher, including the wiring of `wrapWorkflowBinding` and `createDynamicWorkflowEntrypoint`.
- [`src/tenants.ts`](./src/tenants.ts) — the two demo tenant scripts.
- [`wrangler.jsonc`](./wrangler.jsonc) — binding configuration.
