# 277. A peer's odd status can no longer stop the authorization server, and a throw in a function its own code hands on is logged, not the process's end (SMD-2665)

**What changed.**
- **`deploy/auth/fetch-guard.ts`:**
  - The answer is read by a new `answerOf(req, href, log)`:
    - a status a Response cannot carry (outside 200–599) is refused before the body is read;
    - a 101 is refused when the request emits `upgrade`;
    - each of its handlers is made by `settling`, which turns a throw into the fetch's rejection.
  - The resolver's callback in `guardedLookup` refuses an answer it cannot check, where it would have thrown.
- **`deploy/auth/target.ts`:**
  - **`guard(what, fn)`** wraps a function that is kept for later.
    - A throw from it is logged as `<what> failed: …`, and the process keeps serving. So is a rejection of any thenable it returns, including a promise from another realm, which escaped `instanceof Promise`.
    - The log line cannot throw either. The listener's guard shares both.
  - **`handedOut`** walks a file with the TypeScript checker, as a regression gate rather than a proof. It reads every function passed to a call or a `new`, in place or inside an object or array literal there, and every one assigned to a property of an object not written here. Each must be:
    - made by a wrapper (one written in a walked file, in place or through a `const`);
    - run at once (an array's, a string's, a map's, a set's or a header list's callback, the global Promise's executor, or TypeScript's own walks), and returning no promise;
    - part of a returned or awaited chain on a promise;
    - passed to code with a body in a walked file;
    - or exempt by a key pinned to the number of sites it covers, with its reason.

    A promise left floating fails too, including one behind `&&`, `?:` or a comma. The walk does not see a function typed `any` or `Function`, an object or an array held in a variable before it is passed, a promise held in a variable and never awaited, a local function that shares a wrapper's name, an async function our own code calls as one returning void, or what an exempt function hands back to the library.
- **`server.ts`** hands on 13 functions made by `guard`. That is 12 `guard` calls, since one is handed to two of the provider's events:
  - the provider's four event handlers;
  - the registration's `finish`, `close` and stall timeout;
  - the start;
  - the stop, its bound and both signals;
  - the hourly purge.

  Two changes beyond that:
  - The stall timeout destroys its request in a `finally`, so a throw cannot leave the gate's place held.
  - On the stop path a throw ends the process, exit 1. Kept, a process that has stopped listening would serve no one, and the restart policy would never replace it. A store that fails to close is logged under the server's own line, with exit 1.
- **`limits.ts`:** the trusted proxy's re-resolution runs through `guard`, where it was `void resolve()` and a bare interval.
- **`evals/eval-auth.ts --self-check`** is async, so it can run the fetch guard's answer probes. `package.json`'s comment names `typescript` as the walk's.

**Why.** Measured on Bun 1.4.0, with a scratch copy of `server.ts` that injects a throw at each site:

| Site | Before | After |
|---|---|---|
| the registration's `finish`, `close`, stall timeout | exit 1 | logged; process up; `/healthz` 200 |
| a timer (the purge's interval, the start) | exit 1 | logged; process up |
| the provider's `server_error`, `grant.error` ×2, `revocation.error` | Koa's 500 | logged; the library's own answer (401 stays 401) |
| the stop path, on SIGTERM | exit 1 | exit 1, in 0.13 s |
| `new Response` in the fetch's `end` handler, peer status 999 or 600 | exit 1 | the fetch refused; the library answers 400 |
| a 101 from the peer | fetch unsettled past the 2.5 s abort | refused |

The status case was reachable from the internet. `GET /auth/authorize?client_id=https://<host>/client.json` makes the library fetch that document before anyone signs in, and any public https host passes the guard's address rules. One such request, naming a host that answered `HTTP/1.1 999`, ended the process:
- it was measured end to end against a self-signed peer on loopback, with only the scratch copy's address rules turned off;
- it can be repeated at will, and each restart forgets the in-memory abuse limits.

**The shape: a guard at each site, not a process-level net.** Bun 1.4.0 does honour `process.on("uncaughtException")` and `("unhandledRejection")`; measured, a throw in a timer, in a response's `close` handler and an unhandled rejection were all logged and the server kept serving. It is not used: such a net would also keep the process after a throw inside oidc-provider or Koa, whose state nothing here can reason about, where a restart is the safe answer. At a site of ours, what a throw leaves behind is known:
- the registration's `close` handler is the release alone;
- its `finish` handler gives back before anything else;
- its stall timeout destroys the request in a `finally`;
- the stop path, where keeping the process would be wrong, exits instead.

**Not here.** The library's own handlers and timers, inside oidc-provider and Koa, are outside every guard. So are the functions the server hands the library to call inside its request handling: its settings, the token exchange's handler, the store's adapter. Each is exempt by name with that reason, and a throw in the client validator was measured as that registration's 500. A throw placed before `registrations.release()` in the `close` handler leaks that place by construction, because the release is the handler's only statement: `underWay` read 1 after such an injection, and 0 after every other one.

**Held by**
- **`bun target.ts --self-check`** (15 probes, 5 new):
  - the teeth row: an unguarded timer's throw escapes. The check counts escapes rather than dying;
  - each of these is logged under its name, and none escapes:
    - a guarded timer's throw;
    - an async rejection;
    - an unprintable value;
    - a promise from another realm;
    - a throw and a rejection whose log line itself throws;
    - a real response's `close` handler;
  - the walk on a 57-line sample, where each line is a case:
    - the spellings the first version's text scan missed or misread: a regex holding a backtick or a quote, a space before the parenthesis, `void` of no promise, `close(true)`;
    - the calls it did not know: `nextTick`, `addEventListener`, a callback by position, an options object;
    - review pass 2's cases: a `let` that may be reassigned, an async callback that an array or a Promise drops, a library's own `find`, an ambient function, an optional callback, an array, a property assignment, a promise behind `&&` or a comma, a chain in a function typed to return void, a class whose base constructor gets the function, and `Bun.serve`, which only shares a wrapper's name; and review pass 3's: a `let` called as own code, a `catch` on no promise, an `any` receiver;
    - the ones that are fine: an array's callback, a returned chain's, an awaited chain's, a wrapper's `const`;
    - and nothing found in a comment, a string or a `selfCheck`;
  - the program over `server.ts` and its imports type-checks clean, so no function hides behind an unresolved type (an explicit `any` still would);
  - each function `server.ts` and its 8 imports hand on is accounted for: 19 wrapped, 60 run at once, 6 chained, 31 exempt. No promise floats, and each exemption covers exactly its pinned number of sites.
- **`bun eval-auth.ts --self-check`** (117 probes, 6 new). `answerOf` runs against a raw peer on loopback:
  - 200 and 204 are read;
  - 999 and 600 are refused, each by name;
  - a 101 is refused;
  - an oversized body is cut, and a hang-up refuses the fetch;
  - no throw escapes;
  - a lookup answer that cannot be read is refused.
- **Mutants:**

  | Mutant | Caught by |
  |---|---|
  | `guard` without its try/catch, or watching only this realm's `Promise` | the escape row; the logged row |
  | the guards' log line outside its try | the escape row |
  | a parameter taken for the file's own function | the sample row |
  | every promise chain taken as held | the sample row; the walk row |
  | floating promises not looked for | the sample row; the walk row |
  | functions known by their syntax only | the sample row; the walk row |
  | a wrapper known by its name alone; a `let` taken as a wrapper's | the sample row |
  | a runs-now method known by its name alone; an async callback taken as run | the sample row |
  | an ambient function, or a class with no constructor of its own, taken as own code | the sample row |
  | a callback typed with `undefined` not a function; arrays or property assignments not read | the sample row |
  | a promise behind `&&` or a comma not looked for; a chain in a void-typed function taken as held | the sample row |
  | a `let` taken as own code; a chain on anything with a `then` or `catch`; an `any` receiver taken as array-like | the sample row |
  | a new site under an old exemption key (`Object.assign` in `store.ts`) | the walk row (the pin); passes once the pin check is dropped |
  | a registration's `close` or the stop's bound unwrapped; the re-resolution interval bare; a bare timer added to `store.ts` | the walk row |
  | the token chain `void`ed, or no longer returned | the walk row (bare; floating) |
  | the fetch's `end` handler not settling | the walk row |
  | no status range check; no `upgrade` listener; neither the range check nor settling on `end` | `eval-auth`'s 999/600, 101 and no-escape rows |
  | the lookup's throw rethrown | `eval-auth` exits 1 |

- **The Verify, run outside compose** against the guarded copy, with a throw at each site at its start and after its give-back:
  - the process stayed up, logged the throw under its name, and answered `/healthz`;
  - `underWay` read 0 after each, except in the `close` case above;
  - a throw at the stall timeout's start no longer leaves the stalled request open;
  - a throw on the stop path ends the process on SIGTERM, exit 1, in 0.13 s, and so does a store that fails to close, logged.

  End to end, an authorization request naming peers that answered 999 or 101 was answered 400 within 21 ms, and the server stayed up.
- **The `answerOf` run over https.** Review pass 1 sent 55 hostile peer answers through `answerOf` over both `node:http` and `node:https`, with the library's 2.5 s abort. Every one settled, none escaped, and none ended the process: llhttp refuses every header `Headers.set` would, and 1xx then nothing, or a stall after the headers, aborts at 2.5 s.
- `store.ts`, `provision.ts` and `limits.ts --self-check` pass (42, 113, 40), as do `tsc` for `deploy/auth` and `evals`, and `check-fork-consistency.ts`.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | MEDIUM: the text scan hid real code after a regex holding `/*`, a quote or a backtick; it flagged code meaning the same (`return void res.destroy()`, `let`, `close(true)`); it missed `nextTick`, `addEventListener`, a callback by position and a floating `.then`, so the resolver's callback in the fetch guard went unseen; and the fragment said it found "every callback" | cold read, run-it | a walk with the TypeScript checker, each exemption named with its reason |
| 1 | LOW: a throw on the stop path was swallowed, leaving a process that had stopped listening and would never be restarted; a throw in `done`'s log line skipped the exit | cold read | the stop path catches its own and exits 1; `done` exits in a `finally` |
| 1 | LOW: a throw in the stall timeout before `req.destroy()` left the stalled request holding its place | cold read | the destroy in a `finally` |
| 1 | LOW: a promise from another realm escaped the guard (exit 1); a throw from the guard's own log line escaped too | run-it | any thenable watched; the log line in a try, in both guards |
| 1 | LOW: "any callback" and "a signal" overclaimed in the header and the Changelog; "on main every one reads bare" was wrong for `fetch-guard.ts` | cold read | narrowed |
| 2 | MEDIUM: the walk took names for declarations, so a new bare site could pass: a wrapper by name (`Bun.serve`), a runs-now method by name (a library's `find`, a stream's `map`) or with an async callback (`forEach(async …)`), an exemption key by name or text (a new `Object.assign` in `store.ts`, a second resolver); it took an ambient function or a class with no constructor for own code, and missed an optional callback, an array, a property assignment, a promise behind `&&` or a comma, and a chain in a void-typed function; the docs said it covered every function and failed closed | cold read, run-it | wrappers, runs-now calls and own code resolved by declaration; an async callback to an array is bare; exemptions pinned to their site counts; those spellings read; the walk named a regression gate, with what it does not see |
| 2 | LOW: a store that failed to close on a stop exited 0 with nothing logged; the stop's catch called any non-Error unprintable | cold read, run-it | logged through the guards' own line, exit 1 |
| 2 | NIT: the resolver's log line sat outside its try; "13 functions" were 12 handed on 13 times; the Changelog took in the exempt functions; `store.ts`'s exemption gave the wrong reason; `package.json`'s comment was garbled; any nested `selfCheck` was skipped | cold read | fixed; only a top-level `selfCheck` skipped |
| 3 | LOW: the fragment said a store that failed to close had exited 0 unlogged (on main it exited 1 with a stack); own code took a `let`, which may be rebound to a library function; `catch` counted as chained on anything with that method; an `any` receiver read as an array; the walk's notes left out an async function our code calls as one returning void, and what an exempt function hands back; the Changelog counted a signal's handler as one that keeps the process | cold read | a `const` required; the chain's receiver a promise; `any` and `never` receivers run nothing; the notes and claims corrected |
