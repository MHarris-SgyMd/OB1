# Meal Planning Plugin

Recipes, a week's planned meals, and the shopping list made from them, kept in the brain itself (SMD-2311). An agent can plan the week, say what is for dinner, and know what to buy. It is the learning path's [Extension 4](../../extensions/meal-planning/), which was a standalone MCP server with its own keys, beside a second "shared" server for a household, until it became this plugin.

## What it does

Four tables of its own, in the schema `plugin_meal_planning`, made by `migrations/001_meal_planning.sql`:

- `recipes`: each with its ingredients (`{ name, quantity, unit }`, the quantity and unit as written), its steps, its tags, its times and servings.
- `meal_plans`: a week's meals. Each is in a week (by its Monday), on a day, at a meal (breakfast, lunch, dinner or snack), and is a recipe or a custom meal ("leftovers").
- `shopping_lists` and `shopping_list_items`: one list a week, made from the week's recipes, each item with whether it is bought.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a recipe | `meal_planning_add_recipe` | `POST /v1/plugins/meal-planning/recipes` | `write` | `name`, `ingredients`, `instructions`; `cuisine`, `prep_time_minutes`, `cook_time_minutes`, `servings`, `tags`, `rating` (1 to 5), `notes` optional | `{ recipe }` |
| Search recipes | `meal_planning_search_recipes` | `GET /v1/plugins/meal-planning/recipes` | `read` | `query`, `cuisine`, `tag`, `ingredient` optional; `limit`, 1 to 200, default 50 | `{ recipes, truncated }` |
| Change a recipe | `meal_planning_update_recipe` | `PATCH /v1/plugins/meal-planning/recipes/{recipe_id}` | `write` | `recipe_id`; any of `add_recipe`'s fields | `{ recipe }` |
| Plan meals | `meal_planning_create_meal_plan` | `POST /v1/plugins/meal-planning/meal-plans` | `write` | `week_start`, `meals` (each `day_of_week`, `meal_type`, and `recipe_id` or `custom_meal`; `servings`, `notes` optional) | `{ week_start, meals, replaced }` |
| The week's meals | `meal_planning_get_meal_plan` | `GET /v1/plugins/meal-planning/meal-plans` | `read` | `week_start` | `{ week_start, meals }` |
| Make the week's shopping list | `meal_planning_generate_shopping_list` | `POST /v1/plugins/meal-planning/shopping-lists` | `write` | `week_start` | `{ shopping_list }` |
| The week's shopping list | `meal_planning_get_shopping_list` | `GET /v1/plugins/meal-planning/shopping-lists` | `read` | `week_start` | `{ shopping_list }` |
| Mark an item bought | `meal_planning_mark_item_purchased` | `PATCH /v1/plugins/meal-planning/shopping-list-items/{item_id}` | `write` | `item_id`; `purchased` (default true) | `{ item }` |

- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and timestamps are ISO text in UTC. A week is named by its Monday: a `week_start` on any other day is refused at 400, so two plans never hold the same days under two names. The tables hold the same rule. `day_of_week` is a lower-case day name, and `meal_type` is breakfast, lunch, dinner or snack. Text is trimmed and holds no NUL. Tags are kept lower-case, each once.
- **Searching recipes.** `query` matches word by word: every word must be in the name, cuisine, notes, tags or ingredients' names, in any case and any order. `cuisine` matches part of the cuisine, `tag` a whole tag, and `ingredient` part of any ingredient's name ("oil" finds olive oil), each in any case. The newest recipe comes first, and `truncated` says whether more matched than `limit`.
- **Changing a recipe.** Only the fields given change. One given as `null` is cleared (the cuisine, the times, servings, rating or notes). Ingredients, instructions and tags, when given, replace the whole list.
- **Planning meals.** Each day and meal type given is set to the meals given for it, replacing what was planned there; the answer's `replaced` lists what went. So the same plan sent twice is planned once (two plans of one week at once are made one after the other), and two meals for one slot (pasta and garlic bread for Monday's dinner) are both kept, in the order sent. To add to a slot, send what is already there too (`get_meal_plan` has it). Slots not given are left as they are. A shopping list already made is not changed by a plan: make it again.
- **The week's meals** come by day, Monday first, then by meal (breakfast, lunch, dinner, snack). Each carries `on_date`, the date it falls on in the week from `week_start`, and its recipe's name, cuisine, times and servings, or `null` for a custom meal.
- **The shopping list** is made from the week's planned recipes.
  - Each ingredient is listed once by its name (any case) and unit, in the order the week's meals first name it. A unit has one spelling: "lbs" and "pounds" are "lb", "cups" is "cup", "tablespoons" and "T" are "tbsp", and "t" is "tsp". A word after a number that is no unit ("2 large") stays in the quantity.
  - Quantities written as numbers ("2", "1/2", "1 1/2", "½", ".5", or "1 lb" with the unit in the quantity) are summed, and shown as a fraction where they make a half, third, quarter, sixth or eighth ("2/3"). Any others follow the sum, in one order whatever the meals', with how many times they came ("2 + a pinch ×2"). A recipe planned twice counts twice. Quantities are the recipes' as written, not scaled to a meal's servings.
  - Each item names the recipes it is for.
  - Made again, the same list follows the plan as it now is. An item marked bought keeps the quantity it was bought at (`bought_quantity`), and stays marked while its quantity is that, or a smaller number (bought 800 g, now 400 g, and 800 g again when the meal comes back). One that grew past it, or a quantity not a number that changed, is to buy again. Item ids change when the list is made again. A week with no planned recipe has an empty list.
  - `get_shopping_list` says the list is `stale` when the list made now would differ: the plan or a planned recipe's ingredients changed after it was made. A mark, a recipe's rating, or a slot planned again with the same meal leaves it as it was.
- **Refusals.**
  - A recipe that is not there: `404 NO_SUCH_RECIPE`, naming each id and saying where the ids are.
  - A change with no field: `422 NOTHING_TO_CHANGE`.
  - A week with no shopping list: `404 NO_SUCH_LIST`, saying `generate_shopping_list` makes one.
  - An item that is not there: `404 NO_SUCH_ITEM`.
  - A meal with neither a recipe nor a custom meal, or any input out of its form or range: `400`, before anything is stored.
- **MCP hints.** Every tool is closed-world, and a read is read-only. `update_recipe`, `create_meal_plan` and `generate_shopping_list` overwrite what was there (the list's items come back under new ids), so they are marked destructive; `add_recipe` and `mark_item_purchased` are not.

It reaches nothing of the core's: no thought is read or written.

**The household server is gone.** The standalone extension had a second server, `shared-server.ts`, on keys of its own (`MCP_HOUSEHOLD_ACCESS_KEYS`), with which a household member could view the plan and tick off the list. A plugin's operations take the brain's own scopes (`read`, `capture`, `write`), which cannot express "read, and mark bought", so it was not ported (SMD-2920). `get_shopping_list` and `mark_item_purchased` give the same reading and ticking to the brain's own read and write keys. A key for a household member is one of the brain's keys, with what its scope allows.

**`user_id`.** Each table keeps upstream's multi-user `user_id` column, nullable, and nothing writes or reads it. Daemonic Brain is one operator's brain (SMD-1716), so every key that may read sees every row (decided 2026-11-02).

## Prerequisites

- A working Daemonic Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add recipes, plan meals and make lists.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=meal-planning
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=family-calendar,meal-planning` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_meal_planning`, and applies `001_meal_planning.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the three reads for a read key, and all eight tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.recipes`, `public.meal_plans` and `public.shopping_lists`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`. It is one transaction, so a refused row copies nothing and the whole block can be run again:

   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   INSERT INTO plugin_meal_planning.recipes (id, user_id, name, cuisine, prep_time_minutes, cook_time_minutes, servings, ingredients, instructions, tags, rating, notes, created_at, updated_at)
     SELECT r.id, r.user_id, r.name, r.cuisine, r.prep_time_minutes, r.cook_time_minutes, r.servings,
            -- Each ingredient rebuilt as text, trimmed: a quantity stored as a number becomes "2", a blank unit none.
            CASE WHEN jsonb_typeof(r.ingredients) = 'array' THEN
              (SELECT coalesce(jsonb_agg(jsonb_build_object('name', btrim(e->>'name'), 'quantity', nullif(btrim(e->>'quantity'), ''), 'unit', nullif(btrim(e->>'unit'), '')) ORDER BY n), '[]')
                 FROM jsonb_array_elements(r.ingredients) WITH ORDINALITY AS x(e, n)) ELSE r.ingredients END,
            r.instructions,
            -- Tags lower-case, each once, in the order first given.
            (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM (SELECT DISTINCT ON (lower(btrim(t))) lower(btrim(t)) AS t, n
                FROM unnest(r.tags) WITH ORDINALITY AS u(t, n) WHERE btrim(t) <> '' ORDER BY lower(btrim(t)), n) d),
            r.rating, r.notes, coalesce(r.created_at, now()), coalesce(r.updated_at, now()) FROM public.recipes r;
   -- Each meal under the Monday of the date it falls on (the old week could start on any day), keeping its day.
   INSERT INTO plugin_meal_planning.meal_plans (id, user_id, week_start, day_of_week, meal_type, recipe_id, custom_meal, servings, notes, created_at)
     SELECT m.id, m.user_id, d.on_date - (extract(isodow FROM d.on_date)::int - 1), lower(m.day_of_week), m.meal_type, m.recipe_id, m.custom_meal, m.servings, m.notes,
            coalesce(m.created_at, now())
       FROM public.meal_plans m CROSS JOIN LATERAL (
              -- A day that is no day name falls back to the old week's start, and the day check names it.
              SELECT coalesce(m.week_start + ((array_position(ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], lower(m.day_of_week))
                                                - extract(isodow FROM m.week_start)::int + 7) % 7), m.week_start) AS on_date) d;
   -- Each list under the Monday of its week's first day, the latest of a week's lists kept.
   INSERT INTO plugin_meal_planning.shopping_lists (id, user_id, week_start, notes, created_at, updated_at)
     SELECT DISTINCT ON (monday) id, user_id, monday, notes, coalesce(created_at, now()), coalesce(updated_at, now())
       FROM (SELECT l.*, l.week_start - (extract(isodow FROM l.week_start)::int - 1) AS monday FROM public.shopping_lists l) d
      ORDER BY monday, updated_at DESC NULLS LAST, created_at DESC NULLS LAST;
   INSERT INTO plugin_meal_planning.shopping_list_items (list_id, name, quantity, unit, purchased, bought_quantity, recipe_ids, position)
     SELECT l.id, btrim(e->>'name'), nullif(btrim(e->>'quantity'), ''), nullif(btrim(e->>'unit'), ''), coalesce((e->>'purchased')::boolean, false),
            CASE WHEN coalesce((e->>'purchased')::boolean, false) THEN nullif(btrim(e->>'quantity'), '') END,
            CASE WHEN e->>'recipe_id' IS NULL THEN '{}'::uuid[] ELSE ARRAY[(e->>'recipe_id')::uuid] END, x.n
       FROM public.shopping_lists l CROSS JOIN LATERAL jsonb_array_elements(l.items) WITH ORDINALITY AS x(e, n)
      WHERE l.id IN (SELECT id FROM plugin_meal_planning.shopping_lists);
   COMMIT;
   ```

   - **`user_id`.** Each row keeps its `user_id`, in the column the plugin keeps and ignores.
   - **Weeks.** The old server's week could start on any day; the plugin's starts on a Monday. Each meal is copied under the Monday of the date it fell on, keeping its day, and each list under the Monday of its week's first day.
   - **The shopping lists.** The old list's `items` was a JSON array. Each item becomes a row of its own, in its order, keeping whether it was bought. Where a week had more than one list, the latest one is kept. A copied list reads `stale` until it is made again here.
   - **Tags and days** are copied lower-case, as the plugin keeps them, each tag once in the order first given.
   - **Ingredients** are rebuilt as `{ name, quantity, unit }` text, trimmed: a quantity stored as a number becomes its text, and a blank quantity or unit none. A list item's name is trimmed too. A recipe whose `created_at` was null takes the time of the copy.
   - **A refused copy.** The plugin's tables check what the old ones did not:
     - a meal with a recipe or a custom meal;
     - a lower-case day name (the copy lower-cases them) and a meal type of breakfast, lunch, dinner or snack;
     - each ingredient an object with a text name, and each step text;
     - a name of 1 to 200 characters;
     - times of 0 to 10,080 minutes;
     - servings of 1 to 1,000;
     - ingredients and instructions as JSON lists;
     - an item with a name.

     If a row breaks one of these, the copy names the check and nothing is copied. Fix that row in `public` and run the block again.
   - **Leftover tables.** Once the plugin's answers look right, the old tables can be dropped by hand.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_meal_planning".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add, change, plan or mark. Over MCP, a read key's tool list has no write tools at all.
- **A shopping list quantity reads "2 + a pinch".** Only quantities written as numbers are summed. Write "1/2" rather than "half", and the unit in `unit`, where it should add up.
- **A list is `stale`.** The plan or a planned recipe's ingredients changed after it was made, or it was copied from the standalone server: `generate_shopping_list` makes it again.
- **A meal planned twice.** Plan it again for its day and meal type: the slot holds what the last plan sent for it.
