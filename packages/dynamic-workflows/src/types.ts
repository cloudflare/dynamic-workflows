/**
 * Public and internal types for dynamic-workflows.
 *
 * A handful of types in this file (`DispatcherEnvelope`, `WorkflowEventLike`,
 * `WorkflowStepLike`) are *not* re-exported from `index.ts` — they exist
 * purely so the library's own function signatures can reference the shape
 * of Workflows' `WorkflowEvent` / `WorkflowStep` without depending on a
 * specific version of `@cloudflare/workers-types` or `cloudflare:workers`.
 *
 * Consumers should use the real `WorkflowEvent` / `WorkflowStep` types from
 * `cloudflare:workers` in their own code — these structural types are
 * compatible with them by design.
 */

/**
 * Metadata that the dispatcher attaches to every workflow invocation.
 *
 * This is the only information the outer (dispatcher) worker knows about the
 * workflow. When the Workflows engine later dispatches the workflow back to
 * the dispatcher, this metadata is what allows the dispatcher to load the
 * correct dynamic worker.
 *
 * It is completely opaque to the library — consumers are free to put anything
 * serializable inside (tenant ids, routing keys, worker names, etc.).
 */
export type DispatcherMetadata = Record<string, unknown>;

/**
 * Envelope used to smuggle dispatcher metadata alongside the user's params.
 * Internal — not re-exported from the public API.
 */
export interface DispatcherEnvelope<T = unknown> {
  __dispatcherMetadata: DispatcherMetadata;
  params: T;
}

/**
 * Structural shape of a `WorkflowEvent`. Compatible with Cloudflare's real
 * `WorkflowEvent<T>`; internal only.
 */
export interface WorkflowEventLike<T = unknown> {
  payload: T;
  timestamp: Date;
  instanceId: string;
}

/**
 * Structural placeholder for `WorkflowStep`. The library never inspects the
 * step handle — it just forwards it through to the dynamic worker — so any
 * object will do. Internal only.
 */
export type WorkflowStepLike = object;

/**
 * A dynamic workflow runner — something with a `run(event, step)` method that
 * the wrapped `WorkflowEntrypoint` can delegate to.
 *
 * The easiest way to satisfy this is to return `stub.getEntrypoint('X')` from
 * a Worker Loader, pointing at a class in the dynamic worker that
 * `extends WorkflowEntrypoint`.
 */
export type WorkflowRunner<T = unknown, R = unknown> = {
  run(event: WorkflowEventLike<T>, step: WorkflowStepLike): Promise<R>;
};

/**
 * Context passed to a {@link LoadWorkflowRunner}.
 *
 * - `metadata` was attached by {@link wrapWorkflowBinding} at create-time.
 * - `env` is the dispatcher's own `env` (whatever bindings its wrangler
 *   config declares — typically at least a `WorkerLoader` binding).
 * - `ctx` is the standard `ExecutionContext`.
 */
export interface LoadWorkflowRunnerContext<Env = unknown> {
  metadata: DispatcherMetadata;
  env: Env;
  ctx: ExecutionContext;
}

/**
 * Callback the dispatcher provides for loading a tenant's dynamic workflow
 * runner.
 *
 * It receives the metadata that was attached at `create` time along with the
 * dispatcher's own `env` / `ctx`, so it can reach the `WorkerLoader` binding
 * (or any other binding) it needs.
 */
export type LoadWorkflowRunner<Env = unknown, T = unknown, R = unknown> = (
  context: LoadWorkflowRunnerContext<Env>
) => Promise<WorkflowRunner<T, R>> | WorkflowRunner<T, R>;
