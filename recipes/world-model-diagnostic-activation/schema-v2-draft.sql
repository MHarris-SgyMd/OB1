-- Draft only.
-- This is the schema-ready Option B path for the World Model Diagnostic.
-- V1 ships without new tables and persists into core Open Brain thoughts instead.

create table if not exists public.world_model_assessments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null, -- this fork: a plain uuid (the note at the end of the file)
    company_name text,
    company_size_band text,
    industry text,
    business_model text,
    company_case text not null,
    paradigm text not null check (
        paradigm in ('vector_database', 'structured_ontology', 'signal_fidelity')
    ),
    boundary_layer_status text not null check (
        boundary_layer_status in ('missing', 'emerging', 'explicit', 'architectural')
    ),
    highest_fidelity_signal text,
    signal_fidelity_summary text,
    recommended_sequence jsonb not null default '[]'::jsonb,
    simulated_judgment_exposures jsonb not null default '[]'::jsonb,
    principle_readout jsonb not null default '{}'::jsonb,
    confidence_summary jsonb not null default '{}'::jsonb,
    open_questions jsonb not null default '[]'::jsonb,
    captured_thought_ids jsonb not null default '[]'::jsonb,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_world_model_assessments_user_created
    on public.world_model_assessments (user_id, created_at desc);

create index if not exists idx_world_model_assessments_user_paradigm
    on public.world_model_assessments (user_id, paradigm);

create table if not exists public.world_model_boundary_flows (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null, -- this fork: a plain uuid (the note at the end of the file)
    assessment_id uuid references public.world_model_assessments(id) on delete cascade not null,
    flow_name text not null,
    source text,
    consumer text,
    current_human_editor text,
    boundary_label text not null check (
        boundary_label in ('act_on_this', 'interpret_this_first')
    ),
    exposure_level text not null check (
        exposure_level in ('low', 'medium', 'high')
    ),
    failure_mode text,
    notes text,
    created_at timestamptz not null default now()
);

create index if not exists idx_world_model_boundary_flows_assessment_created
    on public.world_model_boundary_flows (assessment_id, created_at desc);

create index if not exists idx_world_model_boundary_flows_user_exposure
    on public.world_model_boundary_flows (user_id, exposure_level);

create or replace function public.world_model_set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_world_model_assessments_updated_at on public.world_model_assessments;

create trigger trg_world_model_assessments_updated_at
before update on public.world_model_assessments
for each row
execute function public.world_model_set_updated_at();

-- This fork (SMD-1810): upstream's draft ended here by enabling row level
-- security on both tables, with a policy `auth.uid() = user_id` for all on
-- each (created inside a DO block when absent) and grants on both to
-- service_role; the two user_id columns above referenced auth.users(id) on
-- delete cascade. Those are Supabase's: on plain Postgres the first
-- REFERENCES stopped the file (`relation "auth.users" does not exist`), as
-- the grants would have (`role "service_role" does not exist`), and with a
-- stub auth.uid() returning NULL the policies denied every row to any role
-- but the tables' owner. Removed; user_id stays a NOT NULL uuid the recipe
-- fills.
-- Grant the role your server connects as instead — from db/:
--   bun migrate.ts --url postgres://… --grant <role>
-- issues db/config.mjs ROLE_GRANTS' `recipes` group, which covers both tables
-- (SELECT, INSERT, UPDATE, DELETE); a role that owns the tables needs
-- nothing. Row-level security on this fork: SMD-1716.
