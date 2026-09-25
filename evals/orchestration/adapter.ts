/**
 * adapter.ts — what the verifier needs from each candidate (SMD-1863). The
 * verifier is one procedure; a candidate differs only in how it is provisioned,
 * how its ingestion workflow is run once on demand, and where its MCP endpoint is.
 */
export type Check = { id: string; pass: boolean; detail: string };

/** What `--up` chose for this project, read back by `--verify`: the `--with` overlays in force. */
export type Ctx = { with: string[] };

export type Adapter = {
  tool: string;
  /** The overlay's services to start, beyond the brain's. */
  services: string[];
  /** The candidate's image reference as the overlay pins it. */
  image: string;
  /** The compose profile the services sit under: n8n's is deploy/compose.yaml's `orchestration` (SMD-2210). */
  profile?: string;
  /** Overlays `--up <tool> --with <name>` adds on top of compose.<tool>.yaml, and the services each starts. */
  variants?: Record<string, { file: string; services: string[] }>;
  /**
   * The variant with no route off the compose network (n8n's `sealed`). Under
   * it the act tool and the schedule cannot reach Linear. The verifier
   * expects the act tool to FAIL there, and does not wait for the schedule.
   */
  sealedVariant?: string;
  /** Is the candidate answering on its loopback port? */
  ready(env: Record<string, string>): Promise<boolean>;
  /** Credentials and workflows in, headlessly; returns the steps it took, for C4. */
  provision(env: Record<string, string>, ctx: Ctx): Promise<string[]>;
  /**
   * Run the ingestion workflow once, return when it has finished, and return
   * how many capture_thought calls the TOOL's own run record says were
   * answered — the evidence a run executed that a row count cannot give when
   * the brain's dedup makes a repeat add nothing (review pass 2: a second run
   * skipped outright passed as "+0").
   */
  runIngestion(env: Record<string, string>, ctx: Ctx): Promise<number>;
  /**
   * Successful runs of the ingestion workflow that its SCHEDULE started since
   * `since` (ISO), from the tool's own run history — the on-demand path the
   * verifier drives says nothing about whether the schedule fires.
   */
  scheduledRuns(env: Record<string, string>, since: string): Promise<number>;
  /** The candidate's own MCP endpoint and the header an AI client presents. */
  mcpServer(env: Record<string, string>): Promise<{ url: string; headers: Record<string, string> }>;
  /** What carries the capture to the brain: the tool's own MCP-client step, or a script of ours where it has none. */
  mcpClient: string;
  /** Is that the tool's own MCP client? C2 as posted asks for it; a script of ours standing in does not pass. */
  nativeMcpClient: boolean;
  /** The two tool names that endpoint must list: the brain read, the vendor act. */
  tools: { search: string; act: string };
  version(): string;
  /** G2: the switches the overlay sets, and what the candidate fetches at run time. */
  switches: { telemetry: string[]; runtimeFetch: string };
  /** Checks of the tool's own after C1–C3 and C1s: n8n's keys, pruning and egress record (SMD-2210). */
  extraChecks?(env: Record<string, string>, ctx: Ctx): Promise<Check[]>;
  /** The store's size on disk, in words, for M1. */
  storeFootprint?(ctx: Ctx): string;
};
