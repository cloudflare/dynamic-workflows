/**
 * Wrapped `WorkflowEntrypoint`.
 *
 * The workflow instance that the dispatcher registers with Cloudflare is a
 * thin shell: its only job is to receive the `WorkflowEvent`, pull the
 * dispatcher metadata off the payload, use the consumer-supplied loader to
 * obtain the tenant's dynamic worker, and delegate `run(event, step)` to
 * that dynamic worker.
 *
 * The dynamic worker is where the real workflow lives — it sees the
 * user-facing `params` and a normal `WorkflowStep` handle.
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { unwrapParams } from './binding.js';
import type {
  LoadWorkflowRunner,
  LoadWorkflowRunnerContext,
  WorkflowEventLike,
  WorkflowStepLike,
} from './types.js';

/**
 * Error thrown when the `WorkflowEvent` does not contain a dispatcher
 * envelope. This usually means the workflow was created against the raw
 * binding instead of one wrapped with {@link wrapWorkflowBinding}.
 */
export class MissingDispatcherMetadataError extends Error {
  constructor() {
    super(
      'dynamic-workflows: workflow event is missing dispatcher metadata. ' +
        'Did you forget to wrap the Workflow binding with wrapWorkflowBinding()?'
    );
    this.name = 'MissingDispatcherMetadataError';
  }
}

/**
 * Shared implementation of `run()` for both the generated `WorkflowEntrypoint`
 * subclass and any custom subclass built with {@link withDynamicRun}.
 *
 * Exported so that consumers who need a bit more control (e.g. to wire up
 * their own logging or to compose with other mixins) can reuse the core
 * unwrap-and-delegate logic.
 */
export async function dispatchWorkflow<Env, Params, Result>(
  context: { env: Env; ctx: ExecutionContext },
  event: WorkflowEventLike<unknown>,
  step: WorkflowStepLike,
  loadRunner: LoadWorkflowRunner<Env, Params, Result>
): Promise<Result> {
  const unwrapped = unwrapParams<Params>(event.payload);
  if (unwrapped === null) {
    throw new MissingDispatcherMetadataError();
  }

  const { metadata, params } = unwrapped;

  const innerEvent: WorkflowEventLike<Params> = {
    payload: params,
    timestamp: event.timestamp,
    instanceId: event.instanceId,
  };

  const runnerCtx: LoadWorkflowRunnerContext<Env> = {
    metadata,
    env: context.env,
    ctx: context.ctx,
  };

  const runner = await loadRunner(runnerCtx);
  return runner.run(innerEvent, step);
}

/**
 * Create a `WorkflowEntrypoint` subclass that delegates `run` to a
 * dynamically-loaded worker.
 *
 * Register the returned class as the `class_name` of a `[[workflows]]`
 * binding in your dispatcher's wrangler config:
 *
 * ```ts
 * export const DynamicWorkflow = createDynamicWorkflowEntrypoint(async ({ env, metadata }) => {
 *   const tenantId = metadata.tenantId as string;
 *   const worker = env.LOADER.get(tenantId, () => loadTenantWorker(tenantId));
 *   return worker.getEntrypoint('TenantWorkflow') as unknown as WorkflowRunner;
 * });
 * ```
 *
 * ```jsonc
 * // wrangler.jsonc
 * "workflows": [
 *   { "name": "dynamic", "binding": "WORKFLOWS", "class_name": "DynamicWorkflow" }
 * ]
 * ```
 */
export function createDynamicWorkflowEntrypoint<Env = unknown, Params = unknown, Result = unknown>(
  loadRunner: LoadWorkflowRunner<Env, Params, Result>
): typeof WorkflowEntrypoint<Env, Params> {
  // `WorkflowEntrypoint` is generic but its runtime shape is a normal class,
  // so we can safely `extends` it.
  class DynamicWorkflowEntrypoint extends (WorkflowEntrypoint as unknown as new (
    ...args: any[]
  ) => WorkflowEntrypoint<Env, Params>) {
    override async run(event: WorkflowEventLike<unknown>, step: WorkflowStepLike): Promise<Result> {
      // `this.env` / `this.ctx` are provided by the base WorkflowEntrypoint.
      return dispatchWorkflow(
        { env: this.env as Env, ctx: this.ctx as ExecutionContext },
        event,
        step,
        loadRunner
      );
    }
  }

  return DynamicWorkflowEntrypoint as unknown as typeof WorkflowEntrypoint<Env, Params>;
}
