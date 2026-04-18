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
 *
 * Because bindings that cross the Dynamic Worker boundary must be RPC
 * stubs — not plain JS objects, and not real `Workflow` bindings (which
 * aren't serialisable) — the wrapper is implemented as a
 * {@link WorkerEntrypoint} subclass. Consumers re-export the class from
 * their dispatcher's main module, then call {@link wrapWorkflowBinding} to
 * get a stub they can hand to a loaded Worker's `env`. The stub forwards
 * calls back into the dispatcher, where the real `Workflow` binding lives.
 */

import { RpcTarget, WorkerEntrypoint, exports as workersExports } from 'cloudflare:workers';
import type { DispatcherEnvelope, DispatcherMetadata } from './types.js';

/**
 * A `WorkflowInstance` returned from a wrapped binding needs to cross the
 * Dynamic Worker RPC boundary. The native `InstanceImpl` is not
 * serialisable, so we wrap it in a small `RpcTarget` that forwards each
 * method. The instance's `id` is copied onto the stub so callers can read
 * it synchronously, matching the real binding's behaviour.
 */
class InstanceStub extends RpcTarget {
  // Use `#instance` (private) + a getter for `id` so that `id` is a
  // *prototype* accessor rather than an own instance property. RpcTarget
  // exposes prototype members over RPC, but not own instance fields.
  #instance: WorkflowInstance;

  constructor(instance: WorkflowInstance) {
    super();
    this.#instance = instance;
  }

  get id(): string {
    return this.#instance.id;
  }

  status() {
    return this.#instance.status();
  }
  pause() {
    return this.#instance.pause();
  }
  resume() {
    return this.#instance.resume();
  }
  terminate() {
    return this.#instance.terminate();
  }
  restart() {
    return this.#instance.restart();
  }
  sendEvent(opts: { type: string; payload: unknown }) {
    return this.#instance.sendEvent(opts);
  }
}

function wrapInstance(instance: WorkflowInstance): WorkflowInstance {
  return new InstanceStub(instance) as unknown as WorkflowInstance;
}

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
 * Props used to specialise a {@link DynamicWorkflowBinding} instance for a
 * particular tenant. Internal — set by {@link wrapWorkflowBinding}.
 *
 * Note that the `Workflow` binding itself cannot be sent as a prop (the
 * runtime refuses to serialise it), so we pass its name and look it up on
 * `this.env` at call time.
 */
export interface DynamicWorkflowBindingProps {
  bindingName: string;
  metadata: DispatcherMetadata;
}

/**
 * Core implementation, factored out so it can be unit-tested without
 * needing to instantiate a `WorkerEntrypoint` (which the runtime doesn't
 * allow outside of a real RPC invocation).
 *
 * Internal.
 */
export function dispatcherBindingImpl(
  getBinding: () => Workflow,
  metadata: DispatcherMetadata
): Workflow {
  return {
    async create(options?: WorkflowInstanceCreateOptions<unknown>): Promise<WorkflowInstance> {
      const instance = await getBinding().create({
        ...(options ?? {}),
        params: wrapParams(options?.params, metadata),
      });
      return wrapInstance(instance);
    },
    async createBatch(
      batch: WorkflowInstanceCreateOptions<unknown>[]
    ): Promise<WorkflowInstance[]> {
      const instances = await getBinding().createBatch(
        batch.map((options) => ({
          ...options,
          params: wrapParams(options.params, metadata),
        }))
      );
      return instances.map(wrapInstance);
    },
    async get(id: string): Promise<WorkflowInstance> {
      return wrapInstance(await getBinding().get(id));
    },
  } as Workflow;
}

function resolveBinding(env: Record<string, unknown>, bindingName: string): Workflow {
  const binding = env[bindingName];
  if (!binding) {
    throw new Error(
      `dynamic-workflows: no Workflow binding named "${bindingName}" found on env. ` +
        'Make sure the dispatcher declares it in wrangler.'
    );
  }
  return binding as Workflow;
}

/**
 * A `WorkerEntrypoint`-based implementation of the `Workflow` binding
 * interface. The dispatcher **must** re-export this class from its main
 * module:
 *
 * ```ts
 * // dispatcher's index.ts
 * export { DynamicWorkflowBinding } from 'dynamic-workflows';
 * ```
 *
 * Cloudflare then automatically registers it on `ctx.exports` /
 * `cloudflare:workers` `exports`, which is what {@link wrapWorkflowBinding}
 * uses to create a specialised RPC stub per tenant.
 */
export class DynamicWorkflowBinding extends WorkerEntrypoint<
  Record<string, unknown>,
  DynamicWorkflowBindingProps
> {
  private impl(): Workflow {
    const { bindingName, metadata } = this.ctx.props;
    return dispatcherBindingImpl(() => resolveBinding(this.env, bindingName), metadata);
  }

  create(options?: WorkflowInstanceCreateOptions<unknown>): Promise<WorkflowInstance> {
    return this.impl().create(options);
  }

  createBatch(batch: WorkflowInstanceCreateOptions<unknown>[]): Promise<WorkflowInstance[]> {
    return this.impl().createBatch(batch);
  }

  get(id: string): Promise<WorkflowInstance> {
    return this.impl().get(id);
  }
}

/**
 * Shape of `ctx.exports` / `cloudflare:workers` `exports` once the consumer
 * has re-exported {@link DynamicWorkflowBinding}. Cloudflare looks up the
 * export by name — it must match exactly.
 */
interface ExportsWithBinding {
  DynamicWorkflowBinding: (init: { props: DynamicWorkflowBindingProps }) => Workflow;
}

/**
 * Options accepted by {@link wrapWorkflowBinding}.
 */
export interface WrapWorkflowBindingOptions {
  /**
   * Name of the `Workflow` binding declared in the dispatcher's
   * `wrangler.jsonc`. The `DynamicWorkflowBinding` class will look it up on
   * `this.env[bindingName]` to create workflow instances.
   *
   * Defaults to `'WORKFLOWS'`.
   */
  bindingName?: string;
}

/**
 * Produce a `Workflow`-shaped RPC stub that, when `.create()` / `.createBatch()`
 * is called on it, tags each new instance's params with the given dispatcher
 * metadata.
 *
 * The returned stub is serialisable and can be passed as a binding to a
 * Dynamic Worker loaded via the Worker Loader:
 *
 * ```ts
 * // dispatcher's index.ts
 * import { DynamicWorkflowBinding, wrapWorkflowBinding } from 'dynamic-workflows';
 * export { DynamicWorkflowBinding }; // required — makes the class available on exports
 *
 * export default {
 *   async fetch(request, env) {
 *     const stub = env.LOADER.get(tenantId, async () => ({
 *       mainModule: 'index.js',
 *       modules: { 'index.js': tenantCode },
 *       compatibilityDate: '2026-01-01',
 *       env: {
 *         WORKFLOWS: wrapWorkflowBinding({ tenantId }),
 *       },
 *     }));
 *     // ...
 *   },
 * };
 * ```
 *
 * Throws if the consumer forgot to re-export `DynamicWorkflowBinding` from
 * their main module.
 */
export function wrapWorkflowBinding(
  metadata: DispatcherMetadata,
  options: WrapWorkflowBindingOptions = {}
): Workflow {
  const exports = workersExports as unknown as Partial<ExportsWithBinding>;
  const factory = exports.DynamicWorkflowBinding;
  if (typeof factory !== 'function') {
    throw new Error(
      'dynamic-workflows: `DynamicWorkflowBinding` is not registered on ' +
        "`cloudflare:workers` exports. Add `export { DynamicWorkflowBinding } from 'dynamic-workflows';` " +
        "to your dispatcher's main module."
    );
  }
  const bindingName = options.bindingName ?? 'WORKFLOWS';
  return factory({ props: { bindingName, metadata } });
}
