# basic-example — interactive playground

A browser playground for `dynamic-workflows`. Write a JavaScript worker that
defines a `TenantWorkflow`, hit **Run**, and watch the workflow execute:

- Pre-extracted step checklist (from `step.do(...)` / `step.sleep(...)` calls
  in your code) that lights up as the workflow progresses.
- Live `console.log` / exception stream over Server-Sent Events (via a
  [streaming Tail Worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)
  + a `LogSession` Durable Object).
- Live status and final return value.

## Run

```bash
pnpm install
pnpm run build            # builds the dynamic-workflows library
pnpm --filter=basic-example run dev
```

Then open <http://localhost:8787/>.

## Moving pieces

| File                       | Role                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`src/index.ts`](./src/index.ts)         | Dispatcher. Hosts the JSON API (`/api/run`, `/api/status`, `/api/stream`) and registers `DynamicWorkflow`. |
| [`src/logging.ts`](./src/logging.ts)     | `LogSession` Durable Object + `DynamicWorkerTail` Tail Worker + SSE response helper.                       |
| [`src/dashboard.ts`](./src/dashboard.ts) | The static HTML/JS dashboard served at `GET /`.                                                            |
| [`src/default-source.ts`](./src/default-source.ts) | Seed code shown in the editor on first load.                                                       |
| [`wrangler.jsonc`](./wrangler.jsonc)     | Bindings: `WORKFLOWS`, `LOADER`, `LOG_SESSION` (DO).                                                       |

## How a run flows

```
browser ─POST /api/run──▶ dispatcher
                             │
                             │ 1. Allocate runId (= workflow instance id
                             │    = LogSession DO name).
                             │ 2. Store source in LogSession DO.
                             │ 3. env.LOADER.get(runId, load cb) — attach
                             │    DynamicWorkerTail with props: { runId }.
                             │ 4. Call tenant's default.fetch, which calls
                             │    env.WORKFLOWS.create({ id: runId, params }).
                             ▼
                         Workflows engine ──▶ dispatcher.DynamicWorkflow.run()
                                                │
                                                │ loads the same tenant worker
                                                │ (cached, or re-bundled from
                                                │ the DO-stored source) and
                                                │ delegates to TenantWorkflow.run.
                                                ▼
                                        tenant worker ── console.log() ──▶ Tail
                                                                              │
                                                                              ▼
                                                                LogSession.push()
                                                                              │
                             ┌─ SSE stream ◀── subscriber.push() ─────────────┘
 browser ◀──────────────────┘
```

## Caveats

- **Experimental flag**: uses `streamingTails` on the Worker Loader, which
  requires the `experimental` compatibility flag and `allowExperimental: true`
  on the loader config.
- **No bundling**: the editor only accepts plain JavaScript. No TypeScript,
  no npm imports — the source is passed straight to Worker Loader.
- **No auth**: this is a demo. Don't put it on the public internet without
  putting something serious in front of it, because it will run any JS the
  caller POSTs.
