/**
 * adapter.ts — what the verifier needs from each candidate (SMD-1863). The
 * verifier is one procedure; a candidate differs only in how it is provisioned,
 * how its ingestion workflow is run once on demand, and where its MCP endpoint is.
 */
export type Adapter = {
  tool: string;
  /** The overlay's services to start, beyond the brain's. */
  services: string[];
  /** The candidate's image reference as the overlay pins it. */
  image: string;
  /** Is the candidate answering on its loopback port? */
  ready(env: Record<string, string>): Promise<boolean>;
  /** Credentials and workflows in, headlessly; returns the steps it took, for C4. */
  provision(env: Record<string, string>): Promise<string[]>;
  /** Run the ingestion workflow once and return when it has finished. */
  runIngestion(env: Record<string, string>): Promise<void>;
  /** The candidate's own MCP endpoint and the header an AI client presents. */
  mcpServer(env: Record<string, string>): Promise<{ url: string; headers: Record<string, string> }>;
  /** The two tool names that endpoint must list: the brain read, the vendor act. */
  tools: { search: string; act: string };
  version(): string;
  /** G2: the switches the overlay sets, and what the candidate fetches at run time. */
  switches: { telemetry: string[]; runtimeFetch: string };
};
