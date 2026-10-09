// The example plugin (SMD-2310): the template a plugin starts from. One read
// operation that reaches the brain's thoughts the only way a plugin may —
// through a core operation, as the caller (ctx.call).

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";

export default definePlugin({
  name: "example",
  title: "Example plugin",
  description: "The plugin template: one read operation over the core. Copy the directory to start a plugin.",
  operations: {
    recent: operation({
      title: "Recent thought ids",
      description: "The ids, types and capture times of the most recent thoughts, newest first — read through the core's list_thoughts as the caller, so a key that cannot read cannot call it.",
      scope: "read",
      method: "GET",
      path: "/recent",
      input: { limit: z.number().int().min(1).max(20).default(5).describe("How many thoughts, 1 to 20") },
      output: {
        thoughts: z.array(z.object({ id: z.string(), type: z.string().nullable(), created_at: z.string().nullable() })),
      },
      async handler(ctx, { limit }) {
        const listed = await ctx.call("list_thoughts", { limit });
        if (!listed.ok) return refuse(422, "CORE_REFUSED", { message: `list_thoughts refused: ${listed.refusal.code}` });
        return ok({
          thoughts: listed.value.thoughts.map((t) => ({
            id: t.id,
            type: typeof t.metadata.type === "string" ? t.metadata.type : null,
            created_at: t.created_at,
          })),
        });
      },
    }),
  },
});
