// What the GUI's write pages share (SMD-3322).

import { base } from '$app/paths';

/**
 * The most text the edit and capture pages save, in the bytes a browser posts
 * it as — its UTF-8, each line break sent as CRLF (postedBytes) — under
 * serve.ts's 1 MB body limit with room for the multipart form's boundaries and
 * its other field. The edit page says so of a thought past it, rather than
 * offer a Save the server would refuse unread.
 */
export const TEXT_MAX_BYTES = 1_000_000;

/** What a text past TEXT_MAX_BYTES is told, on the page that would save it, and where it can go instead. */
export const tooLarge = (bytes: number, operation: 'update_thought' | 'capture_thought', verb: 'Edit' | 'Capture') =>
	`This text posts as ${bytes.toLocaleString('en-US')} bytes, past the ${TEXT_MAX_BYTES.toLocaleString('en-US')} this page saves. ${verb} it through ${operation} over the MCP server or the REST core instead.`;

/** A field's text as it was typed: a browser sends a textarea's line breaks as CRLF, each saved as one break (the plugin pin's rule). */
export const typed = (value: FormDataEntryValue | null) => String(value ?? '').replace(/\r\n?/g, '\n');

/**
 * A text's size as a browser posts it from a field: its UTF-8 bytes, each line break — LF, CRLF or a lone CR,
 * which the page's field reads as LF — sent as CRLF (review pass 2: measured as stored, a text of many short lines
 * passed the check and its Save failed; review pass 3: a lone CR counted as one byte, not two).
 */
export const postedBytes = (text: string) => Buffer.byteLength(text.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8');

/**
 * The body every request but an edit's or a capture's is held to, by its
 * declared length, a body declaring none refused: serve.ts's limit is theirs,
 * 1 MB, and a sign-in or any other form is far smaller (review passes 2 and 3).
 */
export const SMALL_BODY_BYTES = 64 * 1024;

/** The edit and capture pages' paths, whose posts alone, from a live session, may carry the larger body. */
export const LARGE_BODY_PATH = new RegExp(`^${base}/(?:capture|thoughts/[^/]+/edit)$`);

/**
 * The source a capture from the GUI names (SMD-3322, SMD-3208): a direct REST capture that names none is labelled
 * `mcp`, the conversational label egress `source:` terms key on (and per-source weights will, SMD-1297).
 */
export const CAPTURE_SOURCE = 'dashboard';

/** A thought id's shape, as the core names one (and as a client_key is), for a value the GUI says back. */
export const THOUGHT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a flash cookie lives: the redirect's time and more. */
export const FLASH_MAX_AGE = 60;

/**
 * The flash cookie the delete page sets for the list to say what it deleted:
 * read and cleared there, so the notice is the delete's own, and a link
 * cannot make the list say a thought was deleted. Named after the listener's
 * session cookie (listener.ts sessionCookieName), so the break-glass port's
 * and the origin's stay apart, as their sessions do.
 */
export const deletedCookie = (sessionCookie: string) => `${sessionCookie}_deleted`;

/**
 * The flash cookie the capture page sets for the thought's page to say what the capture did: `<id>.new`, or
 * `<id>.existed` for a text already a thought; `.novector` after either when no embedding was written with it. Read
 * and cleared by that thought's page alone, as the delete's is by the list.
 */
export const capturedCookie = (sessionCookie: string) => `${sessionCookie}_captured`;

/** Each write's words for one that may have been made, and for one that was not (notAnswered). */
const UNANSWERED = {
	edit: { maybe: 'the edit may still have been saved. Open the thought to see before editing again', not: 'the edit was not saved' },
	delete: { maybe: 'the thought may already be deleted. Look for it under Browse before trying again', not: 'the thought was not deleted' },
	capture: { maybe: 'the thought may still have been captured. Look for it under Browse before capturing it again', not: 'the thought was not captured' },
	retry: { maybe: 'the failed rows may already be requeued. The pool’s counts below say', not: 'nothing was requeued' },
	release: { maybe: 'the stale leases may already be released. The pool’s counts below say', not: 'nothing was released' },
} as const;

/**
 * What a write the REST core did not answer is said as (rest.ts write): one that may have been made — past
 * WRITE_TIMEOUT_MS, or its connection lost after sending — sends the visitor to look first, since a retry would edit
 * or capture again; only one never sent is said not to have been made (review pass 2).
 */
export function notAnswered(code: string | undefined, verb: keyof typeof UNANSWERED): string | undefined {
	const w = UNANSWERED[verb];
	if (code === 'GUI_TIMEOUT') return `The brain did not answer within 90 seconds, so ${w.maybe}.`;
	if (code === 'GUI_LOST') return `The connection to the brain was lost before it answered, so ${w.maybe}.`;
	if (code === 'GUI_UNREACHABLE') return `The brain could not be reached, so ${w.not}. The dashboard log has the reason; try again in a moment.`;
	return undefined;
}

/** What each write is, for a session that may not make it. */
const VERBS = {
	edit: 'edit thoughts: editing',
	delete: 'delete thoughts: deleting',
	capture: 'capture thoughts: capturing',
	retry: 'retry a pool’s failed work: retrying',
	release: 'release a pool’s stale leases: releasing them',
} as const;

/** What a session that may not write is told: by key or by the operator's sign-in, it is the session that may not. */
export const notYours = (verb: keyof typeof VERBS) => `This session cannot ${VERBS[verb]} is a write key’s, or the operator’s through the authorization server.`;
