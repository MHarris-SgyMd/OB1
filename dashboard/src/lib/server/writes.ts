// What the GUI's write pages share (SMD-3322).

/**
 * The most text, in UTF-8 bytes, the edit page saves: under serve.ts's 1 MB
 * body limit with room for the multipart form's boundaries and its other
 * field. The page says so of a thought past it, rather than offer a Save the
 * server would refuse unread.
 */
export const EDIT_MAX_BYTES = 1_000_000;

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
