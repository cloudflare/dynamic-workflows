# Developer Documentation

## Overview

`dynamic-workflows` is the glue between Cloudflare Workflows and Cloudflare Dynamic Workers. It lets a single dispatcher-owned workflow route `run()` calls to the correct tenant's dynamic worker, based on metadata the dispatcher attaches at `create()` time.

## Commands

```bash
pnpm install        # Install dependencies
pnpm run build      # Build the library
pnpm run test       # Run tests
pnpm run check      # Lint/format check
```

## Repository Structure

```
packages/
├── dynamic-workflows/        # Main library
│   └── src/
│       ├── index.ts          # Public entrypoint — re-exports 4 functions/values + 4 types
│       ├── binding.ts        # wrapWorkflowBinding (+ internal wrapParams/unwrapParams helpers)
│       ├── entrypoint.ts     # createDynamicWorkflowEntrypoint, dispatchWorkflow
│       └── types.ts          # Public + internal TypeScript interfaces
├── tests/                    # Vitest + workerd tests
examples/
└── basic/                    # Minimal dispatcher demo with two hardcoded tenants
```

## Public API surface

Only these are re-exported from `index.ts`:

- **Runtime:** `wrapWorkflowBinding`, `createDynamicWorkflowEntrypoint`, `dispatchWorkflow`, `MissingDispatcherMetadataError`
- **Types:** `DispatcherMetadata`, `LoadWorkflowRunner`, `LoadWorkflowRunnerContext`, `WorkflowRunner`

Everything else in `binding.ts` / `types.ts` (`wrapParams`, `unwrapParams`, `DispatcherEnvelope`, `WorkflowEventLike`, `WorkflowStepLike`) is internal — kept purely so the library can type its own signatures without depending on a specific `@cloudflare/workers-types` version.

## Architecture

```
wrapWorkflowBinding(binding, metadata)
│
├─ .create({ params })      → binding.create({ params: { __dispatcherMetadata: metadata, params } })
├─ .createBatch(batch)      → same, applied to every item
└─ .get(id)                 → forwarded unchanged

Workflows engine → dispatcher.run(event, step)
│
└─ createDynamicWorkflowEntrypoint(loader)
    │
    └─ dispatchWorkflow({ env, ctx }, event, step, loader)
        │
        ├─ unwrapParams(event.payload)      — pulls metadata + params back out
        ├─ loader({ metadata, env, ctx })   — dispatcher picks the right runner
        └─ runner.run({ ...event, payload: params }, step)
```

## Source Files

| File            | Purpose                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `index.ts`      | Public entrypoint — re-exports from the other files.                              |
| `binding.ts`    | `wrapWorkflowBinding` and the envelope helpers (`wrapParams`, `unwrapParams`).    |
| `entrypoint.ts` | `dispatchWorkflow` (the core logic) and `createDynamicWorkflowEntrypoint`.        |
| `types.ts`      | Public TypeScript interfaces (`DispatcherMetadata`, `WorkflowRunner`, etc.).      |

## Key Implementation Details

**Envelope encoding**: `wrapWorkflowBinding` never merges metadata into the user's params directly — it always wraps them in `{ __dispatcherMetadata, params }`. This keeps tenant and dispatcher namespaces cleanly separated.

**`WorkflowEntrypoint` subclassing**: `createDynamicWorkflowEntrypoint` builds a real subclass of `WorkflowEntrypoint` from `cloudflare:workers`. The constructor cast is needed because TypeScript doesn't let us `extends` a generic class type directly; the runtime shape is a normal class.

**Testable core**: All real logic lives in `dispatchWorkflow`, which takes its `env`/`ctx` as plain arguments. The `WorkflowEntrypoint` subclass is a thin adapter over it. This is what lets tests cover the library without needing to trick workerd into instantiating a `WorkflowEntrypoint` in non-workflow contexts.

## Testing

Tests run in workerd via `@cloudflare/vitest-pool-workers`:

- `binding.test.ts` — Unit tests for `wrapWorkflowBinding`, `wrapParams`, `unwrapParams`.
- `entrypoint.test.ts` — Unit tests for `dispatchWorkflow` + smoke tests for `createDynamicWorkflowEntrypoint`.
