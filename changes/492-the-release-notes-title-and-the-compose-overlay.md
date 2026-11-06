# 492. The release notes' title and the compose overlay's header say Daemonic Brain (SMD-4099)

**What changed.**
- **`scripts/release-artifacts.ts`** wrote "Open Brain" into what every release publishes. Both lines say Daemonic Brain now:
  - the notes' title, "# Daemonic Brain 2.0.0" ("— rehearsal" on a rehearsal);
  - the first line of `compose.release.yaml`, "# Daemonic Brain — release 2.0.0 (tag v2.0.0) …".
- **Its self-check** (the release job's first step) asserts the new title and header.
- **Check 54's entry for the file** is gone, with its reason: the file no longer names the product.

The GitHub release's own title is the version alone (`release-steps.yml`'s `gh release create --title "$VERSION"`), so it was never at issue.

**Why.** The product is Daemonic Brain since 2026-11-04 (SMD-1929). SMD-3769 renamed what the running brain shows, but not what a release publishes, so v2.0.0's notes would have opened "# Open Brain 2.0.0". SMD-3773's check found the four lines.

**Held.**
- `bun scripts/release-artifacts.ts --self-check` passes, asserting both lines.
- A rehearsal overlay rendered from `deploy/` opens "# Daemonic Brain — release 1.9.0+upstream.9543c29 (REHEARSAL: …)".
- The consistency checker passes with no check 54 entry for the file. One "Open Brain" line put back would fail it, naming the line.
