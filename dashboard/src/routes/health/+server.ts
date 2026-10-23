import type { RequestHandler } from './$types';

// Liveness only, as the servers' keyless /health: the GUI answers. It asks the
// REST core nothing, so a probe neither needs a key nor writes a refusal into
// the core's request log. compose.yaml's healthcheck reads it.
export const GET: RequestHandler = () => new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
