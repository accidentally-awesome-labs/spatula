export { HostGate } from './host-gate';
export { RefreshWorkflow } from './workflow';

// Task 18 replaces this with the API.
export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
