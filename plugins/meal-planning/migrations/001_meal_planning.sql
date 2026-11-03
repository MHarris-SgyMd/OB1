-- The meal planner's tables (SMD-2311): recipes, a week's planned meals, and
-- the shopping list made from them. Ported from extensions/meal-planning/
-- schema.sql, which applied them to the public schema by hand; the list's
-- items, a JSON array there, are rows of their own here, so one can be marked
-- bought by its id and a regenerated list keeps what was bought.
--
-- Runs as the plugin's role, ob1_plugin_meal_planning, with its schema,
-- plugin_meal_planning, first on the path: each table here is the plugin's
-- own, and nothing in the core is referenced.
--
-- user_id is upstream's multi-user column, kept nullable and ignored: the
-- fork is one operator's brain (SMD-1716), so no operation writes or reads it
-- (decided 2026-11-02).

CREATE TABLE IF NOT EXISTS recipes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  cuisine            text,
  prep_time_minutes  integer CHECK (prep_time_minutes BETWEEN 0 AND 10080),
  cook_time_minutes  integer CHECK (cook_time_minutes BETWEEN 0 AND 10080),
  servings           integer CHECK (servings BETWEEN 1 AND 1000),
  -- [{ name, quantity, unit }], quantity and unit as written ("1/2", "cup").
  ingredients        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(ingredients) = 'array'),
  -- The steps, in order, as strings.
  instructions       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(instructions) = 'array'),
  -- Lower-case, each once.
  tags               text[] NOT NULL DEFAULT '{}',
  rating             integer CHECK (rating BETWEEN 1 AND 5),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meal_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid,
  -- The week the meal is in, by its first day (a Monday, say).
  week_start   date NOT NULL,
  day_of_week  text NOT NULL CHECK (day_of_week IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  meal_type    text NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  recipe_id    uuid REFERENCES recipes (id),
  -- A meal with no recipe: "leftovers", "eat out".
  custom_meal  text,
  servings     integer CHECK (servings BETWEEN 1 AND 1000),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_plans_recipe_or_custom CHECK (recipe_id IS NOT NULL OR custom_meal IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS shopping_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  -- One list a week.
  week_start  date NOT NULL UNIQUE,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES shopping_lists (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- The recipes' quantities: those written as numbers summed, any others after ("2 + a pinch").
  quantity    text,
  unit        text,
  purchased   boolean NOT NULL DEFAULT false,
  -- The recipes it is for.
  recipe_ids  uuid[] NOT NULL DEFAULT '{}',
  -- Its place in the list: the order the week's meals first name it.
  position    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipes_by_tags ON recipes USING gin (tags);
CREATE INDEX IF NOT EXISTS meal_plans_by_week ON meal_plans (week_start, day_of_week, meal_type);
CREATE INDEX IF NOT EXISTS shopping_list_items_by_list ON shopping_list_items (list_id, position);

-- What the operations answer, one jsonb object a row (`answer`): dates as
-- YYYY-MM-DD text, timestamps as ISO text in UTC, user_id left out. Beside
-- it, the raw values the operations filter and order by. An operation selects
-- named columns, never `*`, so a column added here later changes no prepared
-- statement's result (check 41).
CREATE OR REPLACE VIEW recipe_rows AS
  SELECT r.id, r.cuisine, r.tags, r.created_at,
         -- What a query reads: the name, cuisine, notes, tags and ingredients' names.
         concat_ws(' ', r.name, r.cuisine, r.notes, array_to_string(r.tags, ' '),
                   (SELECT string_agg(e->>'name', ' ') FROM jsonb_array_elements(r.ingredients) e)) AS search_text,
         (SELECT coalesce(array_agg(e->>'name'), '{}') FROM jsonb_array_elements(r.ingredients) e) AS ingredient_names,
         jsonb_build_object(
           'id', r.id, 'name', r.name, 'cuisine', r.cuisine, 'prep_time_minutes', r.prep_time_minutes, 'cook_time_minutes', r.cook_time_minutes,
           'servings', r.servings, 'ingredients', r.ingredients, 'instructions', r.instructions, 'tags', to_jsonb(r.tags), 'rating', r.rating,
           'notes', r.notes,
           'created_at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM recipes r;

-- A planned meal: on_date is its day's date in the week from week_start, and
-- recipe its recipe's name, cuisine, times and servings, or null.
CREATE OR REPLACE VIEW meal_rows AS
  SELECT m.id, m.week_start, m.day_of_week, m.meal_type, m.recipe_id, m.created_at,
         array_position(ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], m.day_of_week) AS day_rank,
         array_position(ARRAY['breakfast', 'lunch', 'dinner', 'snack'], m.meal_type) AS meal_rank,
         jsonb_build_object(
           'id', m.id, 'week_start', m.week_start::text, 'day_of_week', m.day_of_week, 'meal_type', m.meal_type,
           'on_date', (m.week_start + ((array_position(ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], m.day_of_week)
                                        - extract(isodow FROM m.week_start)::int + 7) % 7))::text,
           'recipe_id', m.recipe_id, 'custom_meal', m.custom_meal, 'servings', m.servings, 'notes', m.notes,
           'created_at', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'recipe', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', r.id, 'name', r.name, 'cuisine', r.cuisine, 'prep_time_minutes', r.prep_time_minutes,
             'cook_time_minutes', r.cook_time_minutes, 'servings', r.servings) END
         ) AS answer
    FROM meal_plans m LEFT JOIN recipes r ON r.id = m.recipe_id;

CREATE OR REPLACE VIEW shopping_item_rows AS
  SELECT i.id, i.list_id, i.position,
         jsonb_build_object('id', i.id, 'name', i.name, 'quantity', i.quantity, 'unit', i.unit, 'purchased', i.purchased, 'recipe_ids', to_jsonb(i.recipe_ids)) AS answer
    FROM shopping_list_items i;
