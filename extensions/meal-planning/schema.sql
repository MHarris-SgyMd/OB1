-- Extension 4: Meal Planning
-- Complete meal planning system with a shared, read-mostly server for household access

-- Recipe collection
CREATE TABLE recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    cuisine TEXT,
    prep_time_minutes INTEGER,
    cook_time_minutes INTEGER,
    servings INTEGER,
    ingredients JSONB NOT NULL DEFAULT '[]', -- array of {name, quantity, unit}
    instructions JSONB NOT NULL DEFAULT '[]', -- array of step strings
    tags TEXT[] DEFAULT '{}',
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Weekly meal planning
CREATE TABLE meal_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    week_start DATE NOT NULL, -- should be a Monday
    day_of_week TEXT NOT NULL, -- 'monday', 'tuesday', etc.
    meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    recipe_id UUID REFERENCES recipes,
    custom_meal TEXT, -- for meals without a recipe
    servings INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Auto-generated or manual grocery lists
CREATE TABLE shopping_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    week_start DATE NOT NULL,
    items JSONB NOT NULL DEFAULT '[]', -- array of {name, quantity, unit, purchased: bool, recipe_id}
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_recipes_user_cuisine ON recipes(user_id, cuisine);
CREATE INDEX idx_recipes_user_tags ON recipes USING GIN (tags);
CREATE INDEX idx_meal_plans_user_week ON meal_plans(user_id, week_start);
CREATE INDEX idx_shopping_lists_user_week ON shopping_lists(user_id, week_start);

-- This fork (SMD-1810): upstream's file ENABLEd ROW LEVEL SECURITY on the
-- three tables here, with a policy `auth.uid() = user_id` FOR ALL on each,
-- and a SELECT (on shopping_lists also an UPDATE) policy for a
-- `household_member` role read from auth.jwt() — the shared server's scope.
-- auth.uid() is GoTrue's, which exists only on Supabase: on plain Postgres
-- the first policy stopped the file (`schema "auth" does not exist`),
-- and with a stub returning NULL to get past it the policy denied every row
-- to any role but the tables' owner. Removed. The server connects as one role
-- and scopes rows by DEFAULT_USER_ID itself.
-- Grant the role your server connects as instead — from db/:
--   bun migrate.ts --url postgres://… --grant <role>
-- issues db/config.mjs ROLE_GRANTS' `extensions` group, which covers this
-- file's three tables (SELECT, INSERT, UPDATE, DELETE); the shared server's
-- scope is the tool set it registers, not a row policy; a role that owns the
-- tables needs nothing. Row-level security on this fork: SMD-1716.
