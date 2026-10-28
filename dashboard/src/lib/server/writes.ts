// What the GUI's write pages share (SMD-3322).

import { base } from '$app/paths';

/**
 * The most text the edit page saves, in the bytes a browser posts it as —
 * its UTF-8, each line break sent as CRLF (postedBytes) — under serve.ts's
 * 1 MB body limit with room for the multipart form's boundaries and its other
 * field. The page says so of a thought past it, rather than offer a Save the
 * server would refuse unread.
 */
export const EDIT_MAX_BYTES = 1_000_000;

/** A text's size as a browser posts it from a field: its UTF-8 bytes, each LF sent as CRLF, one byte more (review pass 2: measured as stored, a text of many short lines passed the check and its Save failed). */
export const postedBytes = (text: string) => Buffer.byteLength(text, 'utf8') + (text.match(/\n/g)?.length ?? 0);

/** The body every request but an edit's is held to: serve.ts's limit is the edit's 1 MB, and a sign-in or any other form is far smaller (review pass 2). */
export const SMALL_BODY_BYTES = 64 * 1024;

/** The edit page's path, whose posts alone, from a live session, may carry the larger body. */
export const EDIT_PATH = new RegExp(`^${base}/thoughts/[^/]+/edit$`);

/** A thought id's shape, as the core names one (and as a client_key is), for a value the GUI says back. */
export const THOUGHT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The flash cookie the delete page sets for the list to say what it deleted:
 * read and cleared there, so the notice is the delete's own, and a link
 * cannot make the list say a thought was deleted. Named after the listener's
 * session cookie (listener.ts sessionCookieName), so the break-glass port's
 * and the origin's stay apart, as their sessions do. A minute is the
 * redirect's time and more.
 */
export const deletedCookie = (sessionCookie: string) => `${sessionCookie}_deleted`;
export const DELETED_MAX_AGE = 60;

/** What a session that may not write is told: by key or by the operator's sign-in, it is the session that may not. */
export const notYours = (verb: 'edit' | 'delete') =>
	`This session cannot ${verb} thoughts: ${verb === 'edit' ? 'editing' : 'deleting'} is a write key’s, or the operator’s through the authorization server.`;
