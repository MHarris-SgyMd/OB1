/**
 * The repository a scoped subject key names (SMD-3887, migration 153), in a module of its own: subject.ts reads it for
 * the key shapes, and the set_subject_repo operation's schema for its input (PR 3b-2) without subject.ts's model calls.
 */

/** A repository as a scoped key names it, `<owner>/<repo>`, lowercase, as GitHub names them (153's ob1:subject-key-shapes). */
export const KEY_REPO = "[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9._-]{1,100}";
const REPO = new RegExp(`^${KEY_REPO}$`);

/**
 * 153's ob1_subject_repo_refusal, as a verdict: whether a repository, as set_subject_repo stores it (trimmed and
 * lowercased), is one the setting takes — `<owner>/<repo>` as GitHub names them, a repository of neither `.` nor `..`.
 * The operation's schema reads it, so the database's BAD_REPO is unreachable from there; test-schema holds the two to
 * the same verdicts.
 */
export function subjectRepoValid(repo: string): boolean {
  return REPO.test(repo) && !/\/\.\.?$/.test(repo);
}
