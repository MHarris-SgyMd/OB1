-- SMD-1999 prototype — undo option 1 so test-support's reset (which issues
-- DROP TABLE on the name `thoughts`) can run again. NOT a migration.
DROP VIEW IF EXISTS thoughts;
ALTER TABLE thought_rows RENAME TO thoughts;
