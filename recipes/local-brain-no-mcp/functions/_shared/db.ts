// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: jsr:@supabase/supabase-js@2
// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>
import { createClient, type SupabaseClient } from "../../../../compat/supabase-sql/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set by the Edge Functions runtime",
  );
}

export const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
