// Minimal worker for tests.
//
// We re-export DynamicWorkflowBinding so that `wrapWorkflowBinding` can
// find it on `cloudflare:workers` `exports` during the tests.
export { DynamicWorkflowBinding } from 'dynamic-workflows';

export default {
  fetch: () => new Response('Test worker'),
};
