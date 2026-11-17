// A plain JSON object, not null and not an array: the one guard for a value read off the wire or a jsonb column
// (SMD-3671 PR 2: it was written five times). A leaf that imports nothing, so any module may take it — brain-info.ts
// included, which the dashboard's image stage builds (server-portable/Dockerfile, held by test-server [36h]).

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
