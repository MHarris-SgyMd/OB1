// The brain's read deadlines (SMD-2041), apart from the read that keeps them
// (core/reads.ts), so a server that only asks — the MCP server as a client of
// the REST core (SMD-2287) — holds its keyed checks to the same bound without
// loading the store's modules. It imports nothing.

// Bounded (review pass 1: a keyed probe at an unreachable database waited out
// the driver's 30-second connect and got no reply). The health body answers
// within a probe's usual timeout — its statements capped to fit, so a few
// locked tables cost their lock waits and not the whole record (review pass
// 2); the tool, kept alive by its stream (SMD-1864), waits longer for a large
// brain's counts, at brain-info.ts's default ceilings. The keyed mirrors' key
// check is held to the health deadline too.
export const HEALTH_DEADLINE_MS = 2_500;
export const BRAIN_INFO_TOOL_DEADLINE_MS = 15_000;
