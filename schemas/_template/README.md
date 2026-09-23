# Schema Name

> One-line description of what this schema adds to Open Brain.

## What It Does

1-2 sentences explaining the database extension — what tables, columns, or metadata structures it adds and why.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- List any additional requirements

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
SCHEMA NAME -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Apply the SQL migration below: `psql "$DATABASE_URL" -f schema.sql` (or paste it into your SQL console).
2. From `db/`, run `bun migrate.ts --url "$DATABASE_URL" --grant <role>` so the role your server connects as can use what the file creates. Grant nothing to Supabase's roles in the file itself, and enable no RLS: `scripts/check-fork-consistency.ts` check 12 refuses both, and `db/config.mjs` ROLE_GRANTS' `community` group is where a new table's grant goes (this fork, SMD-1796).

   ```sql
   -- Paste the SQL here or reference the file
   ```

3. Verify the table/columns were created
4. ...

## Expected Outcome

Describe what should exist in the database after running the migration. What tables, columns, or functions were created? How can the user verify it worked?

## Troubleshooting

**Issue: [Common problem]**
Solution: [How to fix it]

**Issue: [Another common problem]**
Solution: [How to fix it]

**Issue: [Third common problem]**
Solution: [How to fix it]
