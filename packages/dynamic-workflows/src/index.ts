/**
 * dynamic-workflows
 *
 * Integrate Cloudflare Workflows with Cloudflare Dynamic Workers.
 *
 * Workflows are normally bound to a static class at deploy time, which means
 * there is no built-in way to have a single workflow dispatch to a different
 * piece of code per tenant / per request. This library closes that gap by:
 *
 *   1. Wrapping the dispatcher's `Workflow` binding so that every `create`
 *      call stashes some dispatcher metadata (e.g. a tenant id) alongside
 *      the user's params.
 *
 *   2. Providing a `WorkflowEntrypoint` subclass that the Workflows engine
 *      invokes. That subclass reads the stashed metadata, asks the dispatcher
 *      to load the matching dynamic worker, and forwards `run(event, step)`
 *      to it.
 *
 * See the package README for the full flow and a worked example.
 */

export { DynamicWorkflowBinding, wrapWorkflowBinding } from './binding.js';
// Advanced / internal. Exposed for consumers that want to build their own
// `Workflow`-shaped object (e.g. for unit tests, or wrapping via a different
// RPC mechanism). Not covered by semver guarantees.
export { dispatcherBindingImpl as _dispatcherBindingImpl } from './binding.js';
export {
  createDynamicWorkflowEntrypoint,
  dispatchWorkflow,
  MissingDispatcherMetadataError,
} from './entrypoint.js';
export type {
  DispatcherMetadata,
  LoadWorkflowRunner,
  LoadWorkflowRunnerContext,
  WorkflowRunner,
} from './types.js';
