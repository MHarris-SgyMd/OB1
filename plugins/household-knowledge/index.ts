// The household knowledge base (SMD-2311): facts about the things in the home
// (a paint colour, an appliance's model, a measurement) and the vendors who
// work on it, in tables of the plugin's own
// (migrations/001_household_knowledge.sql). Ported from the standalone server
// extensions/household-knowledge/index.ts, its five tools kept as five
// operations under the same names. It reaches nothing of the core's.

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";

/** A calendar date as the tables hold it, YYYY-MM-DD, from the year 0001: Postgres has no year 0000, which zod's ISO date accepts. */
const Day = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001");
/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");
/**
 * An item's particulars: an object of whatever keys suit it, at most 10,000
 * characters as JSON, and no NUL anywhere in it, which Postgres's jsonb will
 * not store.
 */
const Details = z.record(z.string(), z.unknown())
  .refine((d) => JSON.stringify(d).length <= 10_000, "at most 10,000 characters as JSON")
  .refine((d) => !JSON.stringify(d).includes("\\u0000"), "no NUL character");

const Item = z.object({
  id: z.string(), name: z.string(), category: z.string().nullable(), location: z.string().nullable(),
  details: z.record(z.string(), z.unknown()), notes: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
const Vendor = z.object({
  id: z.string(), name: z.string(), service_type: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable(),
  website: z.string().nullable(), notes: z.string().nullable(), rating: z.number().int().nullable(), last_used: z.string().nullable(), created_at: z.string(),
});

/** MCP hints: every operation reaches the plugin's own tables alone, and an add adds a row, destroying nothing. A read is read-only already. */
const CLOSED = { openWorldHint: false } as const;
const ADDS = { destructiveHint: false, openWorldHint: false } as const;

/** A row's answer as the migration's views build it (item_rows, vendor_rows): one jsonb object, the shape the output declares. */
type Answer<T> = { answer: T };

/** A person's search text as an ILIKE pattern: `%`, `_` and the backslash match themselves, so "50%" finds "50%". */
const likePattern = (s: string) => `%${likeText(s)}%`;
/**
 * A person's search text with `%`, `_` and the backslash escaped for ILIKE,
 * for a query matched word by word: the SQL splits it on spaces and asks each
 * word apart ("Bosch dishwasher" finds the dishwasher whose details say
 * Bosch), so a phrase an agent types never misses for its word order.
 */
const likeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export default definePlugin({
  name: "household-knowledge",
  title: "Household knowledge",
  description: "Facts about the things in the home (paint colors, appliances and their models, measurements, documents) and the vendors who work on it, so an agent can answer \"what color is the living room?\" or \"who was our plumber?\".",
  operations: {
    add_household_item: operation({
      title: "Add a household item",
      description: "Adds a fact about something in the home and answers it with its id. details holds its particulars as an object of whatever keys suit it, {\"brand\": \"Sherwin Williams\", \"color\": \"Sea Salt\"} say; search_household_items searches them too.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/items",
      input: {
        name: text(200).min(1).describe("What the item is: 'Living Room Paint', 'Dishwasher'"),
        category: text(100).min(1).nullish().describe("Its kind: 'paint', 'appliance', 'measurement', 'document', …"),
        location: text(200).min(1).nullish().describe("Where in the home it is: 'Living Room', 'Kitchen'"),
        details: Details.nullish().describe("Its particulars, as an object: a brand, a model, a colour code, a serial number, a size"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
      },
      output: { item: Item },
      async handler(ctx, i) {
        const [row] = await ctx.db.tx(async (sql) => {
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO household_items (name, category, location, details, notes)
            VALUES (${i.name}, ${i.category ?? null}, ${i.location ?? null}, (${JSON.stringify(i.details ?? {})}::text)::jsonb, ${i.notes ?? null})
            RETURNING id`;
          return sql<Answer<z.input<typeof Item>>>`SELECT answer FROM item_rows WHERE id = ${id}`;
        });
        return ok({ item: row.answer });
      },
    }),
    search_household_items: operation({
      title: "Search household items",
      description: "The household items holding every word of the query in their name, category, location, notes or details (any case, any order; a short word finds more), in a category, or in a location, each filter optional and those given all applying. Newest first, with their ids; truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/items",
      input: {
        query: text(200).min(1).optional().describe("Words anywhere in the item: its name, category, location, notes or details (a brand, a color), each matched apart"),
        category: text(100).min(1).optional().describe("Text in the category, any case"),
        location: text(200).min(1).optional().describe("Text in the location, any case"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { items: z.array(Item), truncated: z.boolean() },
      async handler(ctx, { query, category, location, limit }) {
        const words = query === undefined ? null : likeText(query);
        const kind = category === undefined ? null : likePattern(category);
        const place = location === undefined ? null : likePattern(location);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Item>>>`
          SELECT answer FROM item_rows
           WHERE (${words}::text IS NULL OR (SELECT bool_and(concat_ws(' ', name, category, location, notes, details_text) ILIKE '%' || w || '%')
                                             FROM unnest(regexp_split_to_array(${words}::text, '[[:space:]]+')) w))
             AND (${kind}::text IS NULL OR category ILIKE ${kind}::text)
             AND (${place}::text IS NULL OR location ILIKE ${place}::text)
           ORDER BY created_at DESC, id
           LIMIT ${limit + 1}`);
        return ok({ items: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    get_item_details: operation({
      title: "A household item",
      description: "One household item in full, by the id add_household_item or search_household_items gives. An id that names no item is refused (NO_SUCH_ITEM).",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/items/{item_id}",
      input: { item_id: z.string().uuid().describe("The item's id") },
      output: { item: Item },
      async handler(ctx, { item_id }) {
        const [row] = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Item>>>`SELECT answer FROM item_rows WHERE id = ${item_id}`);
        if (!row) return refuse(404, "NO_SUCH_ITEM", { item_id, message: "no household item has this id: search_household_items gives each item's id" });
        return ok({ item: row.answer });
      },
    }),
    add_vendor: operation({
      title: "Add a vendor",
      description: "Adds a service provider (a plumber, an electrician, a landscaper) and answers it with its id. list_vendors lists them, so check it first rather than adding one twice (a short stem, 'plumb', finds 'plumber' and 'plumbing'). No operation changes a vendor, so last_used is the day known when it is added. An email or a website that is not in its form is refused; keep it in notes instead.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/vendors",
      input: {
        name: text(200).min(1).describe("The vendor's name"),
        service_type: text(100).min(1).nullish().describe("What they do: 'plumber', 'electrician', 'landscaper', …"),
        phone: text(50).min(1).nullish().describe("Their phone number, as written"),
        email: z.email("an email address, name@example.com; keep anything else in notes").max(320).nullish().describe("Their email address, name@example.com"),
        website: z.url({ protocol: /^https?$/, error: "a website as a URL starting http:// or https://; keep anything else in notes" }).max(2000).nullish().describe("Their website, a URL starting http:// or https://"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
        rating: z.number().int().min(1).max(5).nullish().describe("How good they were, 1 to 5"),
        last_used: Day.nullish().describe("The day they last worked on the house, YYYY-MM-DD: a day that has come, in the user's own calendar"),
      },
      output: { vendor: Vendor },
      async handler(ctx, v) {
        const row = await ctx.db.tx(async (sql) => {
          if (v.last_used) {
            const [{ future }] = await sql<{ future: boolean }>`SELECT ${v.last_used}::date > (now() AT TIME ZONE 'UTC')::date + 1 AS future`;
            if (future) return null;
          }
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO household_vendors (name, service_type, phone, email, website, notes, rating, last_used)
            VALUES (${v.name}, ${v.service_type ?? null}, ${v.phone ?? null}, ${v.email ?? null}, ${v.website ?? null}, ${v.notes ?? null},
                    ${v.rating ?? null}::int, ${v.last_used ?? null}::date)
            RETURNING id`;
          const [full] = await sql<Answer<z.input<typeof Vendor>>>`SELECT answer FROM vendor_rows WHERE id = ${id}`;
          return full;
        });
        if (!row) return refuse(422, "FUTURE_DATE", { last_used: v.last_used, message: `last_used ${v.last_used} is more than a day past today in UTC: give a day they have worked on the house` });
        return ok({ vendor: row.answer });
      },
    }),
    list_vendors: operation({
      title: "The vendors",
      description: "The service providers, by name: those whose service type holds service_type (any case; 'plumb' finds the plumbers) and holding every word of the query in their name, service type, notes, phone, email or website, each filter optional and those given both applying. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/vendors",
      input: {
        service_type: text(100).min(1).optional().describe("Text in the service type: 'plumb' finds the plumbers"),
        query: text(200).min(1).optional().describe("Words in the name, service type, notes, phone, email or website, each matched apart"),
        limit: z.number().int().min(1).max(500).default(100).describe("How many at most, 1 to 500"),
      },
      output: { vendors: z.array(Vendor), truncated: z.boolean() },
      async handler(ctx, { service_type, query, limit }) {
        const kind = service_type === undefined ? null : likePattern(service_type);
        const words = query === undefined ? null : likeText(query);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Vendor>>>`
          SELECT answer FROM vendor_rows
           WHERE (${kind}::text IS NULL OR service_type ILIKE ${kind}::text)
             AND (${words}::text IS NULL OR (SELECT bool_and(concat_ws(' ', name, service_type, notes, phone, email, website) ILIKE '%' || w || '%')
                                             FROM unnest(regexp_split_to_array(${words}::text, '[[:space:]]+')) w))
           ORDER BY name, created_at, id
           LIMIT ${limit + 1}`);
        return ok({ vendors: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
  },
});
