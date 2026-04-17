/**
 * Wrapped `Workflow` binding.
 *
 * The dispatcher passes this wrapped binding through to each tenant's dynamic
 * worker instead of the real `env.WORKFLOWS` binding. Whenever the dynamic
 * worker calls `.create()` / `.createBatch()`, the wrapper injects the
 * dispatcher's metadata (tenant id, routing keys, etc.) into the workflow's
 * `params` so the dispatcher can route the workflow back to the correct
 * dynamic worker when it later runs.
 *
 * Calls that don't create a new workflow (`get`) are forwarded unchanged.
 */

import type { DispatcherEnvelope, DispatcherMetadata } from './types.js';

/**
 * Wrap a user's `params` payload in a dispatcher envelope.
 * Internal — callers go through {@link wrapWorkflowBinding}.
 */
export function wrapParams<T>(params: T, metadata: DispatcherMetadata): DispatcherEnvelope<T> {
  return {
    __dispatcherMetadata: metadata,
    params,
  };
}

/**
 * Unwrap a dispatcher envelope back into `{ metadata, params }`.
 *
 * Returns `null` if the payload is not an envelope (e.g. the workflow was
 * created directly against the real binding without going through a wrapped
 * binding). Callers should treat that as a misconfiguration.
 *
 * Internal — callers go through the wrapped `WorkflowEntrypoint`.
 */
export function unwrapParams<T>(
  payload: unknown
): { metadata: DispatcherMetadata; params: T } | null {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    '__dispatcherMetadata' in payload &&
    'params' in payload
  ) {
    const envelope = payload as DispatcherEnvelope<T>;
    return {
      metadata: envelope.__dispatcherMetadata,
      params: envelope.params,
    };
  }
  return null;
}

/**
 * Wraps a `Workflow` binding so that every `create` / `createBatch` call
 * smuggles the given dispatcher metadata alongside the user's params.
 *
 * ```ts
 * const wrapped = wrapWorkflowBinding(env.WORKFLOWS, { tenantId });
 * // Pass `wrapped` to the dynamic worker's env in place of env.WORKFLOWS.
 * ```
 *
 * The returned object has the same shape as a `Workflow`, so the dynamic
 * worker can use it as a drop-in replacement.
 */
export function wrapWorkflowBinding<T = unknown>(
  binding: Workflow<T>,
  metadata: DispatcherMetadata
): Workflow<T> {
  return {
    async create(options?: WorkflowInstanceCreateOptions<T>): Promise<WorkflowInstance> {
      return binding.create({
        ...(options ?? {}),
        // `params` is typed as `T` on the real binding but the Workflows
        // engine treats it as opaque JSON, so pushing an envelope through is
        // safe at runtime even though we lie to TypeScript here.
        params: wrapParams(options?.params, metadata) as unknown as T,
      });
    },

    async createBatch(batch: WorkflowInstanceCreateOptions<T>[]): Promise<WorkflowInstance[]> {
      return binding.createBatch(
        batch.map((options) => ({
          ...options,
          params: wrapParams(options.params, metadata) as unknown as T,
        }))
      );
    },

    async get(id: string): Promise<WorkflowInstance> {
      return binding.get(id);
    },
  };
}
