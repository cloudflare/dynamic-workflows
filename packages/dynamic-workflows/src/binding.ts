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
 * Calls that don't create a new workflow (`get`, `status`, `pause`, etc.) are
 * forwarded unchanged.
 */

import type {
  DispatcherEnvelope,
  DispatcherMetadata,
  WorkflowBindingLike,
  WorkflowInstanceCreateOptionsLike,
  WorkflowInstanceLike,
} from './types.js';

/**
 * Wrap a user's `params` payload in a dispatcher envelope.
 *
 * Exported for use by the wrapped `WorkflowEntrypoint`.
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
 * The returned object implements the same structural interface as the real
 * binding (`create`, `createBatch`, `get`), so the dynamic worker can use it
 * as a drop-in replacement.
 */
export function wrapWorkflowBinding(
  binding: WorkflowBindingLike,
  metadata: DispatcherMetadata
): WorkflowBindingLike {
  return {
    async create(options?: WorkflowInstanceCreateOptionsLike): Promise<WorkflowInstanceLike> {
      return binding.create({
        ...(options ?? {}),
        params: wrapParams(options?.params, metadata),
      });
    },

    async createBatch(batch: WorkflowInstanceCreateOptionsLike[]): Promise<WorkflowInstanceLike[]> {
      return binding.createBatch(
        batch.map((options) => ({
          ...options,
          params: wrapParams(options.params, metadata),
        }))
      );
    },

    async get(id: string): Promise<WorkflowInstanceLike> {
      return binding.get(id);
    },
  };
}
