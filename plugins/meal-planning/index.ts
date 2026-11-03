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
/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");
const minutes = () => z.number().int().min(0).max(10080);
const servings = () => z.number().int().min(1).max(1000);

const IngredientIn = z.object({
  name: text(200).min(1).describe("What it is: 'spaghetti', 'olive oil'"),
  quantity: text(50).min(1).nullish().describe("How much, as written: '400', '1/2', '1 1/2', 'a pinch'"),
  unit: text(50).min(1).nullish().describe("Its unit, if any: 'g', 'cup', 'tbsp'"),
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
const Item = z.object({ id: z.string(), name: z.string(), quantity: z.string().nullable(), unit: z.string().nullable(), purchased: z.boolean(), recipe_ids: z.array(z.string()) });
const ShoppingList = z.object({ id: z.string(), week_start: z.string(), items: z.array(Item), created_at: z.string(), updated_at: z.string() });

/** MCP hints: every operation reaches the plugin's own tables alone. An add destroys nothing; a change overwrites what was there. A read is read-only already. */
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

/**
 * A quantity as a number, where it is written as one: "2", "0.5", "1/2",
 * "1 1/2". Anything else ("a pinch", "2-3") is no number, and is kept as
 * written.
 */
function amount(q: string | null | undefined): number | null {
  const s = (q ?? "").trim();
  let m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m && Number(m[3]) > 0) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  return null;
}
/** A summed quantity as text: to two decimal places at most, no trailing zeros ("1.5", "3"). */
const quantityText = (n: number) => String(Math.round(n * 100) / 100);

type IngredientRow = { name: string; quantity?: string | null; unit?: string | null };
type ListItem = { name: string; quantity: string | null; unit: string | null; recipe_ids: string[] };
/**
 * The week's ingredients as one list: each ingredient once by its name and
 * unit (any case, trimmed), in the order the week's meals first name it. Its
 * quantities written as numbers are summed, and any others ("a pinch") are
 * added after the sum, each once: "2 + a pinch". A recipe planned twice
 * counts twice. Quantities are the recipes' as written, not scaled to a
 * meal's servings.
 */
export function shoppingItems(meals: { recipe_id: string; ingredients: IngredientRow[] }[]): ListItem[] {
  const byKey = new Map<string, { name: string; unit: string | null; quantities: (string | null)[]; recipe_ids: string[] }>();
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      const unit = ing.unit?.trim() || null;
      const key = JSON.stringify([ing.name.trim().toLowerCase(), (unit ?? "").toLowerCase()]);
      const held = byKey.get(key) ?? byKey.set(key, { name: ing.name.trim(), unit, quantities: [], recipe_ids: [] }).get(key)!;
      held.quantities.push(ing.quantity?.trim() || null);
      if (!held.recipe_ids.includes(meal.recipe_id)) held.recipe_ids.push(meal.recipe_id);
    }
  }
  return [...byKey.values()].map((h) => {
    const given = h.quantities.filter((q): q is string => q !== null);
    const numbers = given.map(amount).filter((n): n is number => n !== null);
    const words = [...new Set(given.filter((q) => amount(q) === null))];
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

/** A week's shopping list as the operations answer it, its items in their order; none, if the week has no list. */
async function listOf(sql: PluginSql, week: string): Promise<z.input<typeof ShoppingList> | null> {
  const [row] = await sql<Answer<z.input<typeof ShoppingList>>>`
    SELECT jsonb_build_object(
             'id', l.id, 'week_start', l.week_start::text,
             'items', (SELECT coalesce(jsonb_agg(i.answer ORDER BY i.position, i.id), '[]'::jsonb) FROM shopping_item_rows i WHERE i.list_id = l.id),
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
      description: "Adds a recipe and answers it with its id, which a planned meal names it by. ingredients is a list of { name, quantity, unit }, quantity and unit as written (quantities written as numbers, '2' or '1/2', are summed on a shopping list). instructions is the steps in order. tags are kept lower-case, each once.",
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
      description: "Plans meals in the week from week_start (a Monday, say): each meal names its day_of_week and meal_type, and a recipe_id (from search_recipes) or a custom_meal ('leftovers'). Each day and meal type given is set to the meals given for it, replacing what was planned there, so the same plan sent twice is planned once; two meals given for one slot are both kept. Slots not given are left as they are. Refused: a recipe that is not there (NO_SUCH_RECIPE, naming each).",
      scope: "write",
      annotations: CHANGES,
      method: "POST",
      path: "/meal-plans",
      input: {
        week_start: Day.describe("The week's first day, YYYY-MM-DD"),
        meals: z.array(z.object({
          day_of_week: z.enum(DAYS).describe("Its day, lower-case"),
          meal_type: z.enum(MEALS).describe("breakfast, lunch, dinner or snack"),
          recipe_id: z.string().uuid().nullish().describe("Its recipe's id"),
          custom_meal: text(200).min(1).nullish().describe("A meal with no recipe: 'leftovers', 'eat out'"),
          servings: servings().nullish().describe("How many it is for"),
          notes: text(2000).nullish().describe("Anything else worth keeping"),
        }).refine((m) => Boolean(m.recipe_id) || Boolean(m.custom_meal), "a meal needs a recipe_id or a custom_meal")).min(1).max(50).describe("The meals: [{ day_of_week, meal_type, recipe_id or custom_meal, servings, notes }]"),
      },
      output: { week_start: z.string(), meals: z.array(Meal) },
      async handler(ctx, { week_start, meals }) {
        const ids = [...new Set(meals.map((m) => m.recipe_id).filter((id): id is string => Boolean(id)))];
        const done = await ctx.db.tx(async (sql) => {
          const missing = await missingRecipes(sql, ids);
          if (missing.length > 0) return { missing };
          // Each slot given, emptied once, then filled with the meals given for it.
          const slots = [...new Set(meals.map((m) => `${m.day_of_week} ${m.meal_type}`))];
          for (const slot of slots) {
            const [day, type] = slot.split(" ");
            await sql`DELETE FROM meal_plans WHERE week_start = ${week_start}::date AND day_of_week = ${day} AND meal_type = ${type}`;
          }
          const made: string[] = [];
          for (const m of meals) {
            const [{ id }] = await sql<{ id: string }>`
              INSERT INTO meal_plans (week_start, day_of_week, meal_type, recipe_id, custom_meal, servings, notes)
              VALUES (${week_start}::date, ${m.day_of_week}, ${m.meal_type}, ${m.recipe_id ?? null}::uuid, ${m.custom_meal ?? null}, ${m.servings ?? null}::int, ${m.notes ?? null})
              RETURNING id`;
            made.push(id);
          }
          const rows = await sql<Answer<z.input<typeof Meal>>>`
            SELECT answer FROM meal_rows WHERE id IN (SELECT x::uuid FROM jsonb_array_elements_text((${JSON.stringify(made)}::text)::jsonb) x)
             ORDER BY day_rank, meal_rank, created_at, id`;
          return { meals: rows.map((r) => r.answer) };
        });
        if (done.missing) return noSuchRecipe(done.missing);
        return ok({ week_start, meals: done.meals });
      },
    }),
    get_meal_plan: operation({
      title: "The week's meals",
      description: "The meals planned for the week from week_start, by day (Monday first) and then by meal (breakfast, lunch, dinner, snack). Each has on_date, the date it falls on, and its recipe's name, cuisine, times and servings, or null for a custom meal.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/meal-plans",
      input: { week_start: Day.describe("The week's first day, YYYY-MM-DD") },
      output: { week_start: z.string(), meals: z.array(Meal) },
      async handler(ctx, { week_start }) {
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Meal>>>`
          SELECT answer FROM meal_rows WHERE week_start = ${week_start}::date ORDER BY day_rank, meal_rank, created_at, id`);
        return ok({ week_start, meals: rows.map((r) => r.answer) });
      },
    }),
    generate_shopping_list: operation({
      title: "Make the week's shopping list",
      description: "Makes the shopping list for the week from week_start out of its planned recipes' ingredients, and answers it. Each ingredient is listed once by name and unit (any case); its quantities written as numbers ('2', '1/2', '1 1/2') are summed, and any others added after the sum ('2 + a pinch'); a recipe planned twice counts twice; quantities are the recipes' as written, not scaled to a meal's servings. Made again, the list follows the plan as it now is, and an item marked purchased stays marked. A week with no planned recipe has an empty list.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/shopping-lists",
      input: { week_start: Day.describe("The week's first day, YYYY-MM-DD") },
      output: { shopping_list: ShoppingList },
      async handler(ctx, { week_start }) {
        const list = await ctx.db.tx(async (sql) => {
          const meals = await sql<{ recipe_id: string; ingredients: IngredientRow[] }>`
            SELECT m.recipe_id::text AS recipe_id, r.ingredients
              FROM meal_rows m JOIN recipes r ON r.id = m.recipe_id
             WHERE m.week_start = ${week_start}::date
             ORDER BY m.day_rank, m.meal_rank, m.created_at, m.id`;
          const items = shoppingItems(meals);
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO shopping_lists (week_start) VALUES (${week_start}::date)
            ON CONFLICT (week_start) DO UPDATE SET updated_at = now()
            RETURNING id`;
          // What was marked purchased, by name and unit, kept for the items the new list still has.
          const bought = new Set((await sql<{ k: string }>`
            SELECT lower(name) || '|' || lower(coalesce(unit, '')) AS k FROM shopping_list_items WHERE list_id = ${id} AND purchased`).map((b) => b.k));
          await sql`DELETE FROM shopping_list_items WHERE list_id = ${id}`;
          for (const [position, item] of items.entries()) {
            await sql`
              INSERT INTO shopping_list_items (list_id, name, quantity, unit, purchased, recipe_ids, position)
              VALUES (${id}, ${item.name}, ${item.quantity}, ${item.unit}, ${bought.has(`${item.name.toLowerCase()}|${(item.unit ?? "").toLowerCase()}`)},
                      (SELECT coalesce(array_agg(x::uuid), '{}') FROM jsonb_array_elements_text((${JSON.stringify(item.recipe_ids)}::text)::jsonb) x), ${position})`;
          }
          return listOf(sql, week_start);
        });
        return ok({ shopping_list: list! });
      },
    }),
    get_shopping_list: operation({
      title: "The week's shopping list",
      description: "The shopping list for the week from week_start as generate_shopping_list last made it, each item with its id (which mark_item_purchased takes) and whether it is purchased. A week with no list is refused (NO_SUCH_LIST): generate_shopping_list makes one.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/shopping-lists",
      input: { week_start: Day.describe("The week's first day, YYYY-MM-DD") },
      output: { shopping_list: ShoppingList },
      async handler(ctx, { week_start }) {
        const list = await ctx.db.tx((sql) => listOf(sql, week_start));
        if (!list) return refuse(404, "NO_SUCH_LIST", { week_start, message: "the week has no shopping list: generate_shopping_list makes one from its planned meals" });
        return ok({ shopping_list: list });
      },
    }),
    mark_item_purchased: operation({
      title: "Mark an item bought",
      description: "Marks a shopping list item (item_id, from get_shopping_list or generate_shopping_list) as purchased, or not with purchased false. A list made again keeps the mark. An item that is not there is refused (NO_SUCH_ITEM).",
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
          const marked = await sql<{ list_id: string }>`UPDATE shopping_list_items SET purchased = ${purchased} WHERE id = ${item_id} RETURNING list_id`;
          if (marked.length === 0) return null;
          await sql`UPDATE shopping_lists SET updated_at = now() WHERE id = ${marked[0].list_id}`;
          const [full] = await sql<Answer<z.input<typeof Item>>>`SELECT answer FROM shopping_item_rows WHERE id = ${item_id}`;
          return full;
        });
        if (!row) return refuse(404, "NO_SUCH_ITEM", { item_id, message: "no shopping list item has this id: get_shopping_list gives each item's id" });
        return ok({ item: row.answer });
      },
    }),
  },
});
