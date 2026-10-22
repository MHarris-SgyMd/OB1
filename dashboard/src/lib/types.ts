// The REST core's answers the pages render, by the core's own types: the
// client types a success only as an object (rest-client/README.md), so each
// page holds its body to the value the core builds. Type-only imports, erased
// at build: the image carries none of server-portable for them.

export type { ThoughtStats } from '../../../server-portable/store.ts';
export type { BrainInfo } from '../../../server-portable/brain-info.ts';
export type { FetchedThought, ListThoughtsResult } from '../../../server-portable/core/reads.ts';
