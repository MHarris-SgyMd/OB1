// The suite's own, a preload: starts the entry as it will be once it holds listen streams (SMD-4347).
//
//   bun --preload ./test-listen-on.ts index.ts
//
// listen-streams.ts says `HOLD_LISTEN_STREAMS = false`, and nothing an operator sets turns it on. test-mcp.ts needs
// the real entry, in a process of its own with its signals and its stop, holding a stream; so it loads that one
// module with the one word changed. If the line is not there to change, this throws and the entry does not start:
// a suite that ran with the streams off would hold nothing.
import { plugin } from "bun";

const OFF = "export const HOLD_LISTEN_STREAMS = false;";

plugin({
  name: "hold-listen-streams",
  setup(build) {
    build.onLoad({ filter: /[\\/]mcp-server[\\/]listen-streams\.ts$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      if (!source.includes(OFF)) throw new Error(`test-listen-on.ts: ${args.path} has no line \`${OFF}\` to turn on`);
      return { contents: source.replace(OFF, "export const HOLD_LISTEN_STREAMS = true;"), loader: "ts" };
    });
  },
});
