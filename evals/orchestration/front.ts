/**
 * front.ts — the egress probe's front door (SMD-2210; compose.n8n-sealed.yaml).
 * A plain HTTP relay: the host's loopback port to n8n across the sealed
 * network, which publishes nothing itself. Bodies stream both ways, so the MCP
 * endpoint's event stream passes as it arrives. The request asks for no
 * compression, because a body fetch had decompressed must not go out still
 * labelled gzip.
 */
const UPSTREAM = process.env.UPSTREAM ?? "http://egress-watch:5678";
const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "accept-encoding", "host", "content-length"];

Bun.serve({
  hostname: "0.0.0.0",
  port: 5678,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    for (const h of HOP) headers.delete(h);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const r = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual",
      // @ts-expect-error Bun's fetch takes a streamed request body with duplex
      duplex: "half",
    }).catch((e: Error) => new Response(`front: upstream unreachable: ${e.message}`, { status: 502 }));
    const out = new Headers(r.headers);
    for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(h);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
  },
});
console.log(`front: 0.0.0.0:5678 → ${UPSTREAM}`);
