/**
 * Public types for dynamic-workflows.
 *
 * Because these types must remain compatible with Cloudflare's Workflows API
 * regardless of which `@cloudflare/workers-types` version the consumer has
 * installed, they are deliberately kept minimal and structural.
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
 * A workflow instance as returned by `Workflow.create` / `Workflow.get`.
 * Kept as a structural type so we don't depend on a specific version of
 * `@cloudflare/workers-types`.
 */
export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<unknown>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  sendEvent?(options: { type: string; payload: unknown }): Promise<void>;
}

/**
 * Options accepted by `Workflow.create` / `Workflow.createBatch`.
 */
export interface WorkflowInstanceCreateOptionsLike {
  id?: string;
  params?: unknown;
}

/**
 * Minimal shape of a Cloudflare `Workflow` binding.
 *
 * See https://developers.cloudflare.com/workflows/build/workers-api/#workflow
 */
export interface WorkflowBindingLike {
  create(options?: WorkflowInstanceCreateOptionsLike): Promise<WorkflowInstanceLike>;
  createBatch(batch: WorkflowInstanceCreateOptionsLike[]): Promise<WorkflowInstanceLike[]>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

/**
 * Envelope used to smuggle dispatcher metadata alongside the user's params.
 *
 * The wrapped binding wraps the user's `params` in this envelope before
 * calling the real binding, and the wrapped `WorkflowEntrypoint` unwraps it
 * before handing the event to the dynamic worker.
 *
 * The leading `__` and the specific key names are an implementation detail;
 * consumers should never need to construct or read this envelope directly.
 */
export interface DispatcherEnvelope<T = unknown> {
  __dispatcherMetadata: DispatcherMetadata;
  params: T;
}

/**
 * A `WorkflowEvent` as delivered to a workflow's `run` method.
 */
export interface WorkflowEventLike<T = unknown> {
  payload: T;
  timestamp: Date;
  instanceId: string;
}

/**
 * A `WorkflowStep` as delivered to a workflow's `run` method.
 *
 * Structural only — the library forwards this object straight through to the
 * dynamic worker without inspecting it.
 */
export type WorkflowStepLike = object;

/**
 * A loader that returns the dynamic worker entrypoint responsible for
 * executing a workflow on behalf of a given tenant / metadata bucket.
 *
 * The returned object must expose a `run(event, step)` method with the same
 * shape as a regular `WorkflowEntrypoint`. The easiest way to satisfy this is
 * to return `worker.getEntrypoint()` from a Worker Loader binding and point
 * the dynamic worker at a class that `extends WorkflowEntrypoint`.
 */
export type WorkflowRunner<T = unknown, R = unknown> = {
  run(event: WorkflowEventLike<T>, step: WorkflowStepLike): Promise<R>;
};

/**
 * Context passed to a {@link LoadWorkflowRunner}.
 *
 * This is what the wrapped `WorkflowEntrypoint` has access to at runtime:
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
