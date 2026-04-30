# dynamic-workflows

## 0.1.1

### Patch Changes

- [#1](https://github.com/cloudflare/dynamic-workflows/pull/1) [`ca0f1e9`](https://github.com/cloudflare/dynamic-workflows/commit/ca0f1e9ea88218490f9e000ee43afe660f8434ae) Thanks [@mia303](https://github.com/mia303)! - Release to npm

## 0.1.0

### Minor Changes

- Initial release of `dynamic-workflows`.

  Features:

  - `wrapWorkflowBinding(binding, metadata)` — wraps a Cloudflare `Workflow` binding so that every `create` / `createBatch` call stashes dispatcher metadata (tenant id, routing keys, etc.) alongside the user's `params`.
  - `createDynamicWorkflowEntrypoint(loadRunner)` — returns a `WorkflowEntrypoint` subclass that reads dispatcher metadata back off incoming events, loads the matching tenant runner, and forwards `run(event, step)` to it.
  - `dispatchWorkflow(context, event, step, loadRunner)` — the underlying core, exposed for custom `WorkflowEntrypoint` subclasses.
  - `MissingDispatcherMetadataError` — thrown when a workflow was created against the raw binding instead of the wrapped one.
  - Public types: `DispatcherMetadata`, `LoadWorkflowRunner`, `LoadWorkflowRunnerContext`, `WorkflowRunner`.
