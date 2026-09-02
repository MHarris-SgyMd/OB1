// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: @supabase/supabase-js
// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>
import { createClient } from '../../../compat/supabase-sql/index.ts'

const requireEnv = (name: string) => {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export const APP_ENV = {
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openrouterEmbeddingModel:
    process.env.OPENROUTER_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small',
}

export const supabase = createClient(
  APP_ENV.supabaseUrl,
  APP_ENV.supabaseServiceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
)
