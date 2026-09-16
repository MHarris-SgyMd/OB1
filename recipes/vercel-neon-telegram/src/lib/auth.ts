import { createHash, timingSafeEqual } from "crypto";

export function validateAccessKey(key: string): boolean {
  const expected = process.env.BRAIN_ACCESS_KEY;
  if (!expected) throw new Error("BRAIN_ACCESS_KEY is not configured");

  if (key.length !== expected.length) return false;

  return timingSafeEqual(
    Buffer.from(key),
    Buffer.from(expected),
  );
}

/**
 * Whether a secret the caller echoes — Telegram's `secret_token` header — is the
 * one configured. Both sides are hashed first, so the digests are one length and
 * `timingSafeEqual` leaks neither the secret's length nor its prefix; empty on
 * either side is a refusal (ob1-fork, SMD-1455).
 */
export function secretMatches(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export function extractKey(req: Request): string | null {
  // Header: x-brain-key
  const headerKey = req.headers.get("x-brain-key");
  if (headerKey) return headerKey;

  // Header: Authorization: Bearer <key>
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  // Query param: ?key=<key> (for clients that can't send headers, e.g. ChatGPT)
  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey) return queryKey;

  return null;
}

export function requireAuth(req: Request): { error?: Response } {
  const key = extractKey(req);
  if (!key || !validateAccessKey(key)) {
    return {
      error: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return {};
}
