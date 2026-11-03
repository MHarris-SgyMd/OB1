// The meal planner (SMD-2311): recipes, a week's planned meals, and the
// shopping list made from them, in tables of the plugin's own
// (migrations/001_meal_planning.sql). Ported from the standalone server
// extensions/meal-planning/index.ts, its six tools kept as six operations
// under the same names; get_shopping_list and mark_item_purchased bring back,
// behind the brain's own keys, what its retired household server
// (shared-server.ts, SMD-2920) let a household see and tick off. It reaches
// nothing of the core's.

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";
import type { PluginSql } from "../../server-portable/plugin-sdk.ts";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
/** A calendar date as the tables hold it, YYYY-MM-DD, from the year 0001: Postgres has no year 0000, which zod's ISO date accepts. */
const Day = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001");
/** A week, named by its Monday: one name a week, so two plans never hold the same days under two starts. Its Sunday is in the year 9999 at the latest, so every day of it is a YYYY-MM-DD. */
const Week = Day.refine((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1, "a Monday, YYYY-MM-DD: a week is named by its Monday")
  .refine((d) => d <= "9999-12-20", "a week ending in the year 9999 at the latest");
/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");
const minutes = () => z.number().int().min(0).max(10080);
const servings = () => z.number().int().min(1).max(1000);

const IngredientIn = z.object({
  name: text(200).min(1).describe("What it is: 'spaghetti', 'olive oil'"),
  quantity: text(50).min(1).nullish().describe("How much, a number where it is one: '400', '1/2', '1 1/2'; or as written: 'a pinch', 'to taste'"),
  unit: text(50).min(1).nullish().describe("Its unit, if any, apart from the number: 'g', 'cup', 'tbsp'"),
});
const Ingredient = z.object({ name: z.string(), quantity: z.string().nullable().optional(), unit: z.string().nullable().optional() });
const Recipe = z.object({
  id: z.string(), name: z.string(), cuisine: z.string().nullable(), prep_time_minutes: z.number().int().nullable(), cook_time_minutes: z.number().int().nullable(),
  servings: z.number().int().nullable(), ingredients: z.array(Ingredient), instructions: z.array(z.string()), tags: z.array(z.string()),
  rating: z.number().int().nullable(), notes: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
const Meal = z.object({
  id: z.string(), week_start: z.string(), day_of_week: z.enum(DAYS), meal_type: z.enum(MEALS), on_date: z.string(), recipe_id: z.string().nullable(),
  custom_meal: z.string().nullable(), servings: z.number().int().nullable(), notes: z.string().nullable(), created_at: z.string(),
  recipe: z.object({ id: z.string(), name: z.string(), cuisine: z.string().nullable(), prep_time_minutes: z.number().int().nullable(), cook_time_minutes: z.number().int().nullable(), servings: z.number().int().nullable() }).nullable(),
});
/** A list's item; bought_quantity is the quantity it was marked bought at, null while it is not. */
const Item = z.object({ id: z.string(), name: z.string(), quantity: z.string().nullable(), unit: z.string().nullable(), purchased: z.boolean(), bought_quantity: z.string().nullable(), recipe_ids: z.array(z.string()) });
/** A week's list; stale says generate_shopping_list would now make it otherwise: the plan or a planned recipe's ingredients changed after it was made. */
const ShoppingList = z.object({ id: z.string(), week_start: z.string(), items: z.array(Item), stale: z.boolean(), created_at: z.string(), updated_at: z.string() });

/** MCP hints: every operation reaches the plugin's own tables alone. An add destroys nothing; a change overwrites what was there (a recipe's fields, a slot's meals, a list's items, each under a new id). A read is read-only already. */
const CLOSED = { openWorldHint: false } as const;
const ADDS = { destructiveHint: false, openWorldHint: false } as const;
const CHANGES = { destructiveHint: true, openWorldHint: false } as const;

/** A row's answer as the migration's views build it: one jsonb object, the shape the output declares. */
type Answer<T> = { answer: T };

/** A person's search text with `%`, `_` and the backslash escaped for ILIKE. */
const likeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** A person's search text as an ILIKE pattern: `%`, `_` and the backslash match themselves. */
const likePattern = (s: string) => `%${likeText(s)}%`;
/** A query's words: split on any whitespace (a no-break space included), joined by one space, each escaped for ILIKE. */
const wordsOf = (q: string) => likeText(q.split(/\s+/).filter(Boolean).join(" "));
/** Tags as stored: trimmed, lower-case, each once, in the order given. */
const tagsOf = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

/** Unicode's vulgar fractions, by the value each stands for: "½" is a half. */
const VULGAR: Record<string, number> = Object.fromEntries(
  ([[0xbd, 1 / 2], [0x2153, 1 / 3], [0x2154, 2 / 3], [0xbc, 1 / 4], [0xbe, 3 / 4], [0x2155, 1 / 5], [0x2156, 2 / 5], [0x2157, 3 / 5], [0x2158, 4 / 5],
    [0x2159, 1 / 6], [0x215a, 5 / 6], [0x2150, 1 / 7], [0x215b, 1 / 8], [0x215c, 3 / 8], [0x215d, 5 / 8], [0x215e, 7 / 8], [0x2151, 1 / 9], [0x2152, 1 / 10]] as const)
    .map(([c, v]) => [String.fromCodePoint(c), v]),
);
/** The largest amount read as a number: past it, a sum would print as "1e+21". */
const MOST = 1e9;
/**
 * A quantity as a number, where it is written as one: "2", "0.5", ".5",
 * "1/2", "1 1/2", "½", "1½", "1 ½". Anything else ("a pinch", "2-3", a number
 * past a billion) is no number, and is kept as written.
 */
function amount(q: string | null | undefined): number | null {
  const n = written(q);
  return n !== null && n <= MOST ? n : null;
}
/** amount()'s reading, before its bound. */
function written(q: string | null | undefined): number | null {
  let s = (q ?? "").trim();
  const last = s.slice(-1);
  if (last in VULGAR) {
    const part = VULGAR[last];
    s = s.slice(0, -1).trim();
    if (s === "") return part;
    return /^\d+$/.test(s) ? Number(s) + part : null;
  }
  let m = /^(\d+(?:\.\d+)?|\.\d+)$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m && Number(m[3]) > 0) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  return null;
}
/** Units by their spellings, so "lbs" and "pounds" are "lb" and "cups" is "cup": the same ingredient in two spellings is one item. */
const UNITS: Record<string, string> = Object.fromEntries(Object.entries({
  lb: ["lb", "lbs", "pound", "pounds"], oz: ["oz", "ozs", "ounce", "ounces"], g: ["g", "gram", "grams"], kg: ["kg", "kgs", "kilogram", "kilograms"],
  ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"], l: ["l", "liter", "liters", "litre", "litres"],
  tsp: ["tsp", "tsps", "teaspoon", "teaspoons"], tbsp: ["tbsp", "tbsps", "tbs", "tbl", "tablespoon", "tablespoons"], cup: ["cup", "cups"],
  clove: ["clove", "cloves"], slice: ["slice", "slices"], can: ["can", "cans"], jar: ["jar", "jars"], head: ["head", "heads"],
  pint: ["pint", "pints"], quart: ["quart", "quarts"], piece: ["piece", "pieces"], bunch: ["bunch", "bunches"],
}).flatMap(([unit, spellings]) => spellings.map((sp) => [sp, unit])));
/** The cooks' one-letter units, whose case is the unit: "T" a tablespoon and "t" a teaspoon, so they are read before any lower-casing. */
const LETTER_UNITS: Record<string, string> = { T: "tbsp", t: "tsp", c: "cup", C: "cup" };
/** A unit's one spelling where it has one ("Lbs." is "lb", "T" is "tbsp"); undefined for a word that is no unit this knows. */
const knownUnit = (u: string) => {
  const w = u.trim().replace(/\.$/, "");
  return LETTER_UNITS[w] ?? UNITS[w.toLowerCase()];
};
/** A unit in its one spelling where it has one, else as written. */
const unitOf = (u: string) => knownUnit(u) ?? u.trim();
/**
 * A quantity and a unit as a list reads them: a number written with its
 * unit in the quantity ("1 lb", unit left out) is the number and the unit.
 */
function measure(quantity: string | null | undefined, unit: string | null | undefined): { quantity: string | null; unit: string | null } {
  const q = quantity?.trim() || null;
  const u = unit?.trim() || null;
  if (q && !u) {
    const m = /^(\S+(?:\s+\S+)?)\s+([A-Za-z][A-Za-z.]*)$/.exec(q);
    // Only a word that is a unit: "2 large" is two of something large, not two larges.
    const known = m ? knownUnit(m[2]) : undefined;
    if (m && known !== undefined && amount(m[1]) !== null) return { quantity: m[1], unit: known };
  }
  return { quantity: q, unit: u ? unitOf(u) : null };
}
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** A summed quantity as text: a whole number, a half, third, quarter, sixth or eighth as a fraction ("1 1/2", "2/3"), else to two decimal places, or two figures below one ("0.004"). */
function quantityText(n: number): string {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  if (n < 1e-9 || (whole > 0 && frac < 0.005)) return String(whole);
  for (const d of [2, 3, 4, 6, 8]) {
    const k = Math.round(frac * d);
    if (k > 0 && k < d && Math.abs(frac - k / d) < 0.005) {
      const g = gcd(k, d);
      return `${whole > 0 ? `${whole} ` : ""}${k / g}/${d / g}`;
    }
  }
  return String(n >= 1 ? Math.round(n * 100) / 100 : Number(n.toPrecision(2)));
}

type IngredientRow = { name: string; quantity?: string | null; unit?: string | null };
type ListItem = { name: string; quantity: string | null; unit: string | null; recipe_ids: string[] };
/** An item's name and unit as one key: the name in any case (JavaScript's lower-casing, here alone), the unit as measure() spelled it, in any case. */
const itemKey = (name: string, unit: string | null) => JSON.stringify([name.trim().toLowerCase(), (unit ?? "").toLowerCase()]);
/**
 * Whether a mark made at quantity `was` (what was bought) still holds at
 * `now`: the same quantity, or a number no bigger (bought 800, now 400).
 * Anything more, or a quantity not a number that changed, is to buy again.
 */
export function keepsMark(was: string | null, now: string | null): boolean {
  if (was === now) return true;
  const [a, b] = [amount(was), amount(now)];
  return a !== null && b !== null && b <= a + 1e-9;
}
/** A list's items as what they say, apart from their order and the case a meal first named them in: equal for two lists that say the same. */
export const listSource = (items: ListItem[]) =>
  JSON.stringify(items.map((i) => JSON.stringify([itemKey(i.name, i.unit), i.quantity, [...i.recipe_ids].sort()])).sort());
/**
 * The week's ingredients as one list: each ingredient once by its name and
 * unit (the name in any case, the unit in its one spelling: "lbs" is "lb"),
 * in the order the week's meals first name it. Its quantities written as
 * numbers are summed; any others ("a pinch", "2-3") follow the sum, each with
 * how many times it came ("2 + a pinch ×2"), in one order whatever the meals'.
 * A recipe planned twice counts twice. Quantities are the recipes' as
 * written, not scaled to a meal's servings.
 */
export function shoppingItems(meals: { recipe_id: string; ingredients: IngredientRow[] }[]): ListItem[] {
  const byKey = new Map<string, { name: string; unit: string | null; quantities: (string | null)[]; recipe_ids: string[] }>();
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      const { quantity, unit } = measure(ing.quantity, ing.unit);
      // Any case: the one-letter units whose case is their meaning ("T", "t") are already spelled out by measure().
      const key = itemKey(ing.name, unit);
      const held = byKey.get(key) ?? byKey.set(key, { name: ing.name.trim(), unit, quantities: [], recipe_ids: [] }).get(key)!;
      held.quantities.push(quantity);
      if (!held.recipe_ids.includes(meal.recipe_id)) held.recipe_ids.push(meal.recipe_id);
    }
  }
  return [...byKey.values()].map((h) => {
    const numbers: number[] = [];
    const counts = new Map<string, number>();
    for (const q of h.quantities) {
      if (q === null) continue;
      const n = amount(q);
      if (n !== null) numbers.push(n);
      else counts.set(q, (counts.get(q) ?? 0) + 1);
    }
    // Sorted, so the same meals in another order say the same quantity, and a mark made at it holds.
    const words = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([q, k]) => (k > 1 ? `${q} ×${k}` : q));
    const parts = [...(numbers.length > 0 ? [quantityText(numbers.reduce((a, b) => a + b, 0))] : []), ...words];
    const quantity = parts.length === 0 ? null : parts.join(" + ");
    return { name: h.name, quantity, unit: h.unit, recipe_ids: h.recipe_ids };
  });
}

/** The ids among `ids` that name no recipe. */
async function missingRecipes(sql: PluginSql, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await sql<{ id: string }>`
    SELECT r.id::text AS id FROM recipes r WHERE r.id IN (SELECT x::uuid FROM jsonb_array_elements_text((${JSON.stringify(ids)}::text)::jsonb) x)`;
  const there = new Set(found.map((f) => f.id));
  return ids.filter((id) => !there.has(id));
}
const noSuchRecipe = (recipe_ids: string[]) =>
  refuse(404, "NO_SUCH_RECIPE", { recipe_ids, message: "no recipe has this id: search_recipes gives each recipe's id, and add_recipe adds one" });

/** The week's planned recipes' ingredients, a row a meal, in the order the week has its meals. */
const plannedIngredients = (sql: PluginSql, week: string) => sql<{ recipe_id: string; ingredients: IngredientRow[] }>`
  SELECT m.recipe_id::text AS recipe_id, r.ingredients
    FROM meal_rows m JOIN recipes r ON r.id = m.recipe_id
   WHERE m.week_start = ${week}::date
   ORDER BY m.day_rank, m.meal_rank, m.created_at, m.id`;

/** A week's shopping list as the operations answer it, its items in their order; none, if the week has no list. */
async function listOf(sql: PluginSql, week: string): Promise<z.input<typeof ShoppingList> | null> {
  // Stale by what the list says, not by when things changed: a list made now would say otherwise. A clock cannot order
  // a plan that commits while a list is being made, and a mark or a rating changes nothing a list says.
  const now = listSource(shoppingItems(await plannedIngredients(sql, week)));
  const [row] = await sql<Answer<z.input<typeof ShoppingList>>>`
    SELECT jsonb_build_object(
             'id', l.id, 'week_start', l.week_start::text,
             'items', (SELECT coalesce(jsonb_agg(i.answer ORDER BY i.position, i.id), '[]'::jsonb) FROM shopping_item_rows i WHERE i.list_id = l.id),
             'stale', l.made_from IS DISTINCT FROM md5(${now}),
             'created_at', to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'updated_at', to_char(l.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS answer
      FROM shopping_lists l WHERE l.week_start = ${week}::date`;
  return row?.answer ?? null;
}

export default definePlugin({
  name: "meal-planning",
  title: "Meal planning",
  description: "Recipes, a week's planned meals and the shopping list made from them, so an agent can plan the week, say what is for dinner, and know what to buy.",
  operations: {
    add_recipe: operation({
      title: "Add a recipe",
      description: "Adds a recipe and answers it with its id, which a planned meal names it by. ingredients is a list of { name, quantity, unit }: the amount in quantity, as a number where it is one ('2', '1/2', '1 1/2'), and the unit in unit ('lb', 'cup'), so a shopping list can add them up. instructions is the steps in order. tags are kept lower-case, each once.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/recipes",
      input: {
        name: text(200).min(1).describe("The recipe's name"),
        cuisine: text(100).min(1).nullish().describe("Its cuisine: 'italian', 'thai', …"),
        prep_time_minutes: minutes().nullish().describe("Preparation, in minutes"),
        cook_time_minutes: minutes().nullish().describe("Cooking, in minutes"),
        servings: servings().nullish().describe("How many it serves"),
        ingredients: z.array(IngredientIn).max(200).describe("Its ingredients: [{ name, quantity, unit }]"),
        instructions: z.array(text(2000).min(1)).max(100).describe("Its steps, in order"),
        tags: z.array(text(50).min(1)).max(30).default([]).describe("Tags: 'quick', 'vegetarian', …"),
        rating: z.number().int().min(1).max(5).nullish().describe("How good it is, 1 to 5"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
      },
      output: { recipe: Recipe },
      async handler(ctx, r) {
        const [row] = await ctx.db.tx(async (sql) => {
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO recipes (name, cuisine, prep_time_minutes, cook_time_minutes, servings, ingredients, instructions, tags, rating, notes)
            VALUES (${r.name}, ${r.cuisine ?? null}, ${r.prep_time_minutes ?? null}::int, ${r.cook_time_minutes ?? null}::int, ${r.servings ?? null}::int,
                    (${JSON.stringify(r.ingredients)}::text)::jsonb, (${JSON.stringify(r.instructions)}::text)::jsonb,
                    (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(tagsOf(r.tags))}::text)::jsonb) WITH ORDINALITY AS x(t, n)),
                    ${r.rating ?? null}::int, ${r.notes ?? null})
            RETURNING id`;
          return sql<Answer<z.input<typeof Recipe>>>`SELECT answer FROM recipe_rows WHERE id = ${id}`;
        });
        return ok({ recipe: row.answer });
      },
    }),
    search_recipes: operation({
      title: "Search recipes",
      description: "The recipes holding every word of the query in their name, cuisine, notes, tags or ingredients' names (any case, any order), of a cuisine (part of it, any case), with a tag, or with an ingredient whose name holds the text given (any case): each filter optional, those given all applying. Newest first, with their ids; truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/recipes",
      input: {
        query: text(200).min(1).optional().describe("Words anywhere in the recipe, each matched apart"),
        cuisine: text(100).min(1).optional().describe("Text in the cuisine, any case"),
        tag: text(50).min(1).optional().describe("One tag, any case"),
        ingredient: text(200).min(1).optional().describe("Text in an ingredient's name, any case: 'oil' finds olive oil"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { recipes: z.array(Recipe), truncated: z.boolean() },
      async handler(ctx, { query, cuisine, tag, ingredient, limit }) {
        const words = query === undefined ? null : wordsOf(query);
        const kind = cuisine === undefined ? null : likePattern(cuisine);
        const oneTag = tag === undefined ? null : tag.toLowerCase();
        const has = ingredient === undefined ? null : likePattern(ingredient);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Recipe>>>`
          SELECT answer FROM recipe_rows
           WHERE (${words}::text IS NULL OR (SELECT bool_and(search_text ILIKE '%' || w || '%') FROM unnest(regexp_split_to_array(${words}::text, ' ')) w))
             AND (${kind}::text IS NULL OR cuisine ILIKE ${kind}::text)
             AND (${oneTag}::text IS NULL OR ${oneTag}::text = ANY (tags))
             AND (${has}::text IS NULL OR EXISTS (SELECT 1 FROM unnest(ingredient_names) n WHERE n ILIKE ${has}::text))
           ORDER BY created_at DESC, id
           LIMIT ${limit + 1}`);
        return ok({ recipes: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    update_recipe: operation({
      title: "Change a recipe",
      description: "Changes the fields given of a recipe (recipe_id, from search_recipes), leaving the rest as they are. A field given as null is cleared (cuisine, the times, servings, rating, notes). ingredients, instructions and tags, when given, replace the whole list. Refused: a recipe that is not there (NO_SUCH_RECIPE), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/recipes/{recipe_id}",
      input: {
        recipe_id: z.string().uuid().describe("The recipe's id"),
        name: text(200).min(1).optional().describe("Its new name"),
        cuisine: text(100).min(1).nullish().describe("Its cuisine; null clears it"),
        prep_time_minutes: minutes().nullish().describe("Preparation, in minutes; null clears it"),
        cook_time_minutes: minutes().nullish().describe("Cooking, in minutes; null clears it"),
        servings: servings().nullish().describe("How many it serves; null clears it"),
        ingredients: z.array(IngredientIn).max(200).optional().describe("Its ingredients, replacing the list"),
        instructions: z.array(text(2000).min(1)).max(100).optional().describe("Its steps, replacing the list"),
        tags: z.array(text(50).min(1)).max(30).optional().describe("Its tags, replacing the list"),
        rating: z.number().int().min(1).max(5).nullish().describe("How good it is, 1 to 5; null clears it"),
        notes: text(5000).nullish().describe("Its notes; null clears them"),
      },
      output: { recipe: Recipe },
      async handler(ctx, u) {
        const given = (k: keyof typeof u) => u[k] !== undefined;
        const fields = ["name", "cuisine", "prep_time_minutes", "cook_time_minutes", "servings", "ingredients", "instructions", "tags", "rating", "notes"] as const;
        if (!fields.some(given)) return refuse(422, "NOTHING_TO_CHANGE", { recipe_id: u.recipe_id, message: "give at least one field to change" });
        const row = await ctx.db.tx(async (sql) => {
          const changed = await sql<{ id: string }>`
            UPDATE recipes SET
              name = CASE WHEN ${given("name")} THEN ${u.name ?? null} ELSE name END,
              cuisine = CASE WHEN ${given("cuisine")} THEN ${u.cuisine ?? null} ELSE cuisine END,
              prep_time_minutes = CASE WHEN ${given("prep_time_minutes")} THEN ${u.prep_time_minutes ?? null}::int ELSE prep_time_minutes END,
              cook_time_minutes = CASE WHEN ${given("cook_time_minutes")} THEN ${u.cook_time_minutes ?? null}::int ELSE cook_time_minutes END,
              servings = CASE WHEN ${given("servings")} THEN ${u.servings ?? null}::int ELSE servings END,
              ingredients = CASE WHEN ${given("ingredients")} THEN (${JSON.stringify(u.ingredients ?? [])}::text)::jsonb ELSE ingredients END,
              instructions = CASE WHEN ${given("instructions")} THEN (${JSON.stringify(u.instructions ?? [])}::text)::jsonb ELSE instructions END,
              tags = CASE WHEN ${given("tags")}
                          THEN (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(tagsOf(u.tags ?? []))}::text)::jsonb) WITH ORDINALITY AS x(t, n))
                          ELSE tags END,
              rating = CASE WHEN ${given("rating")} THEN ${u.rating ?? null}::int ELSE rating END,
              notes = CASE WHEN ${given("notes")} THEN ${u.notes ?? null} ELSE notes END,
              updated_at = now()
            WHERE id = ${u.recipe_id}
            RETURNING id`;
          if (changed.length === 0) return null;
          const [full] = await sql<Answer<z.input<typeof Recipe>>>`SELECT answer FROM recipe_rows WHERE id = ${u.recipe_id}`;
          return full;
        });
        if (!row) return noSuchRecipe([u.recipe_id]);
        return ok({ recipe: row.answer });
      },
    }),
    create_meal_plan: operation({
      title: "Plan meals",
      description: "Plans meals in the week whose Monday is week_start: each meal names its day_of_week and meal_type, and a recipe_id (from search_recipes) or a custom_meal ('leftovers'). Each day and meal type given is set to the meals given for it, replacing what was planned there (the answer's replaced lists what went), so the same plan sent twice is planned once; two meals given for one slot are both kept, in the order sent. To add to a slot, send what is already there too (get_meal_plan has it). Slots not given are left as they are. A shopping list already made is not changed: generate_shopping_list makes it again. Refused: a recipe that is not there (NO_SUCH_RECIPE, naming each).",
      scope: "write",
      annotations: CHANGES,
      method: "POST",
      path: "/meal-plans",
      input: {
        week_start: Week.describe("The week's Monday, YYYY-MM-DD"),
        meals: z.array(z.object({
          day_of_week: z.enum(DAYS).describe("Its day, lower-case"),
          meal_type: z.enum(MEALS).describe("breakfast, lunch, dinner or snack"),
          recipe_id: z.string().uuid().nullish().describe("Its recipe's id"),
          custom_meal: text(200).min(1).nullish().describe("A meal with no recipe: 'leftovers', 'eat out'"),
          servings: servings().nullish().describe("How many it is for"),
          notes: text(2000).nullish().describe("Anything else worth keeping"),
        }).refine((m) => Boolean(m.recipe_id) || Boolean(m.custom_meal), "a meal needs a recipe_id or a custom_meal")).min(1).max(50).describe("The meals: [{ day_of_week, meal_type, recipe_id or custom_meal, servings, notes }]"),
      },
      output: { week_start: z.string(), meals: z.array(Meal), replaced: z.array(Meal) },
      async handler(ctx, { week_start, meals }) {
        const ids = [...new Set(meals.map((m) => m.recipe_id).filter((id): id is string => Boolean(id)))];
        const done = await ctx.db.tx(async (sql) => {
          // One plan of a week at a time: two at once (a client's retry) would each empty the slot before the other's
          // meals are in, and keep both. A lock of the plugin's own, in the two-key space the core's locks are not in.
          await sql`SELECT pg_advisory_xact_lock(hashtext('plugin_meal_planning:week'), hashtext(${week_start}))`;
          const missing = await missingRecipes(sql, ids);
          if (missing.length > 0) return { missing };
          // Each slot given, emptied once (what was there answered as replaced), then filled with the meals given for it.
          const slots = [...new Set(meals.map((m) => `${m.day_of_week} ${m.meal_type}`))];
          const replaced: z.input<typeof Meal>[] = [];
          for (const slot of slots) {
            const [day, type] = slot.split(" ");
            const was = await sql<Answer<z.input<typeof Meal>>>`
              SELECT answer FROM meal_rows WHERE week_start = ${week_start}::date AND day_of_week = ${day} AND meal_type = ${type} ORDER BY created_at, id`;
            replaced.push(...was.map((w) => w.answer));
            await sql`DELETE FROM meal_plans WHERE week_start = ${week_start}::date AND day_of_week = ${day} AND meal_type = ${type}`;
          }
          const made: string[] = [];
          for (const m of meals) {
            const [{ id }] = await sql<{ id: string }>`
              INSERT INTO meal_plans (week_start, day_of_week, meal_type, recipe_id, custom_meal, servings, notes, created_at)
              VALUES (${week_start}::date, ${m.day_of_week}, ${m.meal_type}, ${m.recipe_id ?? null}::uuid, ${m.custom_meal ?? null}, ${m.servings ?? null}::int, ${m.notes ?? null},
                      clock_timestamp())
              RETURNING id`;
            made.push(id);
          }
          const rows = await sql<Answer<z.input<typeof Meal>>>`
            SELECT answer FROM meal_rows WHERE id IN (SELECT x::uuid FROM jsonb_array_elements_text((${JSON.stringify(made)}::text)::jsonb) x)
             ORDER BY day_rank, meal_rank, created_at, id`;
          return { meals: rows.map((r) => r.answer), replaced };
        });
        if (done.missing) return noSuchRecipe(done.missing);
        return ok({ week_start, meals: done.meals, replaced: done.replaced });
      },
    }),
    get_meal_plan: operation({
      title: "The week's meals",
      description: "The meals planned for the week whose Monday is week_start, by day (Monday first) and then by meal (breakfast, lunch, dinner, snack), two in one slot in the order planned. Each has on_date, the date it falls on, and its recipe's name, cuisine, times and servings, or null for a custom meal.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/meal-plans",
      input: { week_start: Week.describe("The week's Monday, YYYY-MM-DD") },
      output: { week_start: z.string(), meals: z.array(Meal) },
      async handler(ctx, { week_start }) {
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Meal>>>`
          SELECT answer FROM meal_rows WHERE week_start = ${week_start}::date ORDER BY day_rank, meal_rank, created_at, id`);
        return ok({ week_start, meals: rows.map((r) => r.answer) });
      },
    }),
    generate_shopping_list: operation({
      title: "Make the week's shopping list",
      description: "Makes the shopping list for the week whose Monday is week_start out of its planned recipes' ingredients, and answers it. Each ingredient is listed once by name (any case) and unit (one spelling: 'lbs' and 'pounds' are 'lb'); its quantities written as numbers ('2', '1/2', '½', or '1 lb' with the unit in the quantity) are summed, and any others follow the sum with how many times they came ('2 + a pinch ×2'); a recipe planned twice counts twice; quantities are the recipes' as written, not scaled to a meal's servings. Made again, the list follows the plan as it now is, and an item marked purchased stays marked while its quantity is what was bought or a smaller number (one that grew past it, or a quantity not a number that changed, is to buy again); bought_quantity says what was bought. A week with no planned recipe has an empty list.",
      scope: "write",
      annotations: CHANGES,
      method: "POST",
      path: "/shopping-lists",
      input: { week_start: Week.describe("The week's Monday, YYYY-MM-DD") },
      output: { shopping_list: ShoppingList },
      async handler(ctx, { week_start }) {
        const list = await ctx.db.tx(async (sql) => {
          const items = shoppingItems(await plannedIngredients(sql, week_start));
          // The list's row locked first, as mark_item_purchased locks it: a mark either commits before the marks are read
          // below, or waits for the new items and finds its old one gone.
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO shopping_lists (week_start, made_from) VALUES (${week_start}::date, md5(${listSource(items)}))
            ON CONFLICT (week_start) DO UPDATE SET made_from = excluded.made_from, updated_at = now()
            RETURNING id`;
          // What was marked purchased, at the quantity bought, by name and unit, keyed here rather than by Postgres's
          // lower(), which differs from JavaScript's on some letters: kept for an item the new list has at a quantity the
          // mark covers (keepsMark), still at the quantity bought, so a meal dropped and planned again keeps it.
          const bought = new Map((await sql<{ name: string; unit: string | null; bought: string | null }>`
            SELECT name, unit, coalesce(bought_quantity, quantity) AS bought FROM shopping_list_items WHERE list_id = ${id} AND purchased`)
            .map((b) => [itemKey(b.name, b.unit), b.bought]));
          await sql`DELETE FROM shopping_list_items WHERE list_id = ${id}`;
          for (const [position, item] of items.entries()) {
            const was = bought.get(itemKey(item.name, item.unit));
            const kept = was !== undefined && keepsMark(was, item.quantity);
            await sql`
              INSERT INTO shopping_list_items (list_id, name, quantity, unit, purchased, bought_quantity, recipe_ids, position)
              VALUES (${id}, ${item.name}, ${item.quantity}, ${item.unit}, ${kept}, ${kept ? was : null},
                      (SELECT coalesce(array_agg(x::uuid), '{}') FROM jsonb_array_elements_text((${JSON.stringify(item.recipe_ids)}::text)::jsonb) x), ${position})`;
          }
          return listOf(sql, week_start);
        });
        return ok({ shopping_list: list! });
      },
    }),
    get_shopping_list: operation({
      title: "The week's shopping list",
      description: "The shopping list for the week whose Monday is week_start as generate_shopping_list last made it, each item with its id (which mark_item_purchased takes) and whether it is purchased. stale says the list made now would differ (the plan or a planned recipe's ingredients changed since): generate_shopping_list makes it again. A week with no list is refused (NO_SUCH_LIST): generate_shopping_list makes one.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/shopping-lists",
      input: { week_start: Week.describe("The week's Monday, YYYY-MM-DD") },
      output: { shopping_list: ShoppingList },
      async handler(ctx, { week_start }) {
        const list = await ctx.db.tx((sql) => listOf(sql, week_start));
        if (!list) return refuse(404, "NO_SUCH_LIST", { week_start, message: "the week has no shopping list: generate_shopping_list makes one from its planned meals" });
        return ok({ shopping_list: list });
      },
    }),
    mark_item_purchased: operation({
      title: "Mark an item bought",
      description: "Marks a shopping list item (item_id, from get_shopping_list or generate_shopping_list) as purchased at its quantity (bought_quantity), or not with purchased false. A list made again keeps the mark, under a new id, while the item's quantity is no more than was bought. An item that is not there (an id from before the list was made again) is refused (NO_SUCH_ITEM).",
      scope: "write",
      annotations: ADDS,
      method: "PATCH",
      path: "/shopping-list-items/{item_id}",
      input: {
        item_id: z.string().uuid().describe("The item's id"),
        purchased: z.boolean().default(true).describe("Whether it is bought: true unless given"),
      },
      output: { item: Item },
      async handler(ctx, { item_id, purchased }) {
        const row = await ctx.db.tx(async (sql) => {
          // The list first, then the item, the order generate_shopping_list takes them in: the other order deadlocks with it.
          const list = await sql<{ id: string }>`
            SELECT id FROM shopping_lists WHERE id = (SELECT list_id FROM shopping_list_items WHERE id = ${item_id}) FOR UPDATE`;
          if (list.length === 0) return null;
          // Bought at its quantity; marked again, still at what was first bought.
          const marked = await sql<{ id: string }>`
            UPDATE shopping_list_items SET purchased = ${purchased}, bought_quantity = CASE WHEN ${purchased} THEN coalesce(bought_quantity, quantity) END
             WHERE id = ${item_id} RETURNING id`;
          // None, when a list made again while this waited took the item away: nothing is written.
          if (marked.length === 0) return null;
          await sql`UPDATE shopping_lists SET updated_at = now() WHERE id = ${list[0].id}`;
          const [full] = await sql<Answer<z.input<typeof Item>>>`SELECT answer FROM shopping_item_rows WHERE id = ${item_id}`;
          return full;
        });
        if (!row) return refuse(404, "NO_SUCH_ITEM", { item_id, message: "no shopping list item has this id: get_shopping_list gives each item's id" });
        return ok({ item: row.answer });
      },
    }),
  },
});
