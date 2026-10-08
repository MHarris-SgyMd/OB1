/**
 * target.ts — the path the authorization server routes a request by, and the
 * guards that keep one request from stopping it (SMD-2615, SMD-2665).
 *
 * Bun's node:http hands the listener the request target as sent: an
 * absolute-form `GET http://x:99999/healthz` arrives as `req.url` unchanged,
 * and so does `//x/healthz`. server.ts read its path as
 * `new URL(req.url, "http://auth")`, which threw on the first (the listener's
 * throw ended the process, exit 1, after an empty 200) and resolved the second
 * as host `x`, path `/healthz`. The proxy never sends either (Traefik v3.7.13
 * rewrites an absolute-form target to its path, refuses one it cannot parse
 * and merges `//`, measured), but anything on the mesh can.
 *
 * The path is read the way the library reads it, so the gates in server.ts
 * (the token path, the registration cap) see the same path the library
 * routes. Koa takes the path from `parseurl`, which cuts a target that starts
 * with `/` at its first `?`, unless the target holds one of a few characters,
 * when it hands it to Node's legacy `url.parse` instead, and that turns a `\`
 * before the query into `/`. So a target that does not start with `/`, or
 * holds one of those characters, is refused; any other is cut at its first
 * `?`, never decoded or resolved. No client sends either kind: a browser
 * keeps a fragment to itself, and a request target holds no whitespace.
 * Refusing absolute-form departs from RFC 9112 3.2.2, which has a server
 * accept it, on purpose: nothing but a proxy sends it, and the proxy in front
 * of this server sends the path.
 *
 * The server is made by `serve`, which wraps its listener in the guard;
 * server.ts imports node:http for its types alone, so going back to
 * `http.createServer` there fails the typecheck. That guard covers the
 * listener and the promises it returns. Bun 1.4.0 also ends the process on a
 * throw in a request's or a response's handler, a request's timeout or a
 * timer (measured; a throw in the provider's event handlers was Koa's 500), so
 * each function the server's own files hand on is made by `guard`, which logs
 * the throw and keeps the process, or is accounted for another way:
 * fetch-guard.ts's handlers reject their fetch instead (`settling`), an
 * array's callback runs at once, a promise's is returned or awaited, and the
 * functions the library calls inside its own request handling, and a few
 * more, are exempt by name with a reason. The self-check walks server.ts and every file it imports with the
 * TypeScript checker and fails on any other, in the spellings it reads
 * (`handedOut`, which names those it does not). The library's own handlers
 * and timers, inside oidc-provider and Koa, stay outside: a throw there still
 * ends the process, and compose restarts it.
 *
 * Dependency-free, but its self-check holds the path rule against `parseurl`
 * and Koa's own `ctx.path`, so a bump of either that reads a target another
 * way fails it, and walks the files with `typescript`; the install brings all
 * three (oidc-provider's, and the typecheck's).
 *
 *   bun deploy/auth/target.ts --self-check   # CI, after the install
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type * as TS from "typescript";

/** A request target's path, and its query with the `?` (empty when it has none). */
export type Target = { path: string; search: string };

/** A request listener; it returns its promise wherever it goes async. */
type Listener = (req: IncomingMessage, res: ServerResponse) => unknown;

/** The characters on which `parseurl` (1.3.3, fastparse) hands a target to Node's legacy `url.parse`, which reads it another way. */
const REPARSED = /[\t\n\f\r #\u00a0\ufeff]/;

/** The target's path and query as the library reads them, or undefined when it is not a path or the library would read it another way (server.ts answers 400). */
export function targetOf(raw: string | undefined): Target | undefined {
  if (!raw?.startsWith("/") || REPARSED.test(raw)) return undefined;
  const q = raw.indexOf("?");
  return q < 0 ? { path: raw, search: "" } : { path: raw.slice(0, q), search: raw.slice(q) };
}

/** Writes a line to the log, unless writing it throws (stderr gone): the guards' own log line must not be the throw nothing catches. */
export function say(line: () => string): void {
  try {
    console.error(line());
  } catch {
    // nowhere left to say it
  }
}

/**
 * What a thrown value says, for the log. Built in a try of its own: String()
 * throws on a value with no way to become a string (Object.create(null)), and
 * so does an Error whose `stack` getter throws.
 */
export function whyOf(e: unknown): string {
  try {
    return e instanceof Error ? (e.stack ?? e.message) : String(e);
  } catch {
    return "a value that cannot be printed";
  }
}

/** Whether a callback returned a promise to watch: any thenable, since one from another realm is no `instanceof Promise` here and its rejection escaped (review pass 1). Called inside a try: a `then` getter may throw. */
function thenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * The listener, with a throw or a rejection from it answered 500 (or, once an
 * answer has started, the connection closed) and logged. Bun's node:http ends
 * the process on either, exit 1, measured on 1.4.0: one request would stop the
 * server. The listener returns its promise wherever it goes async, so a
 * failure there reaches this too.
 */
function guarded(listener: Listener): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const failed = (e: unknown) => {
      say(() => `request failed: ${whyOf(e)}`);
      try {
        if (res.headersSent) return void res.destroy();
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("something went wrong on the server; see its log");
      } catch {
        try {
          res.destroy();
        } catch {
          // the connection is gone already
        }
      }
    };
    try {
      const pending = listener(req, res);
      if (thenable(pending)) Promise.resolve(pending).catch(failed);
    } catch (e) {
      failed(e);
    }
  };
}

/** The node:http server for `listener`, guarded: the one way server.ts makes its server. */
export function serve(listener: Listener): http.Server {
  return http.createServer(guarded(listener));
}

/**
 * `fn`, for a caller that keeps it for later (an emitter, a timer, a request's
 * timeout, a signal), with a throw from it, or a rejection of the promise it
 * returns, logged as `<what> failed: …` and the process kept (SMD-2665).
 *
 * Kept, the process must be in a state worth keeping. A callback that holds
 * something gives it back where a throw cannot skip it: server.ts's
 * registration `close` handler is the release alone, its `finish` handler gives
 * back before anything else, and its stall timeout destroys the request in a
 * `finally`. Where keeping the process is the wrong answer, a throw does not
 * reach this: the stop path catches its own and exits 1, since a process that
 * has stopped listening would serve no one and never be restarted.
 *
 * Not a process-level `uncaughtException` handler, which Bun 1.4.0 honours
 * (measured): that would keep the process after a throw inside the library
 * too, whose state nothing here can reason about, where a restart is the safe
 * answer. A throw at a site of ours is caught at the site, where what it
 * leaves behind is known.
 */
export function guard<A extends unknown[]>(what: string, fn: (...args: A) => unknown): (...args: A) => void {
  const failed = (e: unknown) => say(() => `${what} failed: ${whyOf(e)}`);
  return (...args) => {
    try {
      const pending = fn(...args);
      if (thenable(pending)) Promise.resolve(pending).catch(failed);
    } catch (e) {
      failed(e);
    }
  };
}

/** What became of one function a file hands out of its own control (handedOut); `by` is the exemption key that matched. */
export type Handed = { file: string; line: number; to: string; how: "wrapped" | "runs now" | "chained" | "exempt" | "bare" | "floating"; text: string; by?: string };

/** Methods that run a function argument before they return, on the receivers in SYNC_RECEIVERS only. */
const RUNS_NOW = new Set(["map", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "forEach", "reduce", "reduceRight", "flatMap", "sort", "toSorted", "replace", "replaceAll", "from"]);
/** The built-in types whose RUNS_NOW methods run their callback at once: an array's (or any array-like's), a string's, a map's, a set's, a header list's. */
const SYNC_RECEIVERS = new Set(["Array", "ReadonlyArray", "ArrayConstructor", "String", "Map", "ReadonlyMap", "Set", "ReadonlySet", "Headers"]);
/** TypeScript's own walks, which run their callback at once (the self-check's walk uses them). */
const TS_WALKS = new Set(["forEachChild", "findAncestor"]);
/** A promise's own calls: a callback passed to one is held when the chain is returned or awaited. */
const CHAINS = new Set(["then", "catch", "finally"]);

/**
 * The functions `file` hands out of its own control, and what became of each
 * (SMD-2665): a regression gate over the spellings below, not a proof. The
 * TypeScript checker says what is a function (anything with a call or a
 * construct signature, `undefined` aside) and what is a promise. A function
 * counts when it is passed as a call's or a `new`'s argument, in place or
 * inside an object literal (a property, a method, a getter, a setter) or an
 * array literal or a spread there, at any depth, or assigned to a property of
 * an object not written here. Each is:
 * - not counted when the call is a wrapper (a function written in `files`
 *   whose name is in `wrappers`: its input) or other code written in `files`
 *   with a body (a function, a method, a class with its own constructor),
 *   since that file is walked too and where it hands the function on is
 *   counted there;
 * - `wrapped` when a wrapper made it, in place or through the `const` it
 *   initialises;
 * - `runs now` when an array's, a string's, a map's, a set's or a header
 *   list's RUNS_NOW method, the global Promise's executor or TypeScript's
 *   own walks (TS_WALKS) run it, and it returns no promise (one that does is
 *   dropped by the caller, and is `bare`);
 * - `chained` when it is a promise's `then`, `catch` or `finally` callback
 *   whose chain is returned or awaited, so its rejection reaches a promise someone holds
 *   (not when the function returning it is typed to return void);
 * - `exempt` when the callee, `callee.property` or the function's own text is
 *   a key of `exempt` (the self-check pins how many sites each key covers);
 * - `bare` otherwise.
 * A statement whose value is a promise, or holds one behind `&&`, `||`, `??`,
 * `?:`, a comma or `void`, is `floating`, since its rejection reaches no one,
 * or `exempt` when its text is a key of `exempt`. A top-level function named
 * `selfCheck` is the file's test, never run by the server, and is skipped.
 *
 * What it does not see: a function typed `any` or `Function`, or cast to one;
 * a function inside an object or an array held in a variable before it is
 * passed; a promise held in a variable and never awaited; a local function
 * that shares a wrapper's name; an async function passed to our own code that
 * calls it as one typed to return void, dropping its promise; a function an
 * exempt function hands back to the library (a Provider setting's own
 * callbacks). An unresolved type is `any`, so the self-check
 * also holds the program to type-check clean.
 */
export function handedOut(ts: typeof TS, program: TS.Program, file: string, files: ReadonlySet<string>, wrappers: ReadonlySet<string>, exempt: Record<string, unknown>): Handed[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`${file} is not in the program`);
  const name = file.slice(file.lastIndexOf("/") + 1);
  const out: Handed[] = [];
  const lineOf = (n: TS.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const textOf = (n: TS.Node) => n.getText(source).replace(/\s+/g, " ");
  const unwrapped = (n: TS.Node) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n);
  const inner = (n: TS.Expression): TS.Expression => (unwrapped(n) ? inner((n as TS.ParenthesizedExpression).expression) : n);
  const calleeOf = (call: TS.CallExpression | TS.NewExpression) => {
    const e = inner(call.expression);
    return ts.isPropertyAccessExpression(e) ? e.name : e;
  };
  const nameOf = (call: TS.CallExpression | TS.NewExpression) => {
    const c = calleeOf(call);
    return ts.isIdentifier(c) || ts.isPrivateIdentifier(c) ? c.text : textOf(c);
  };
  // What a name resolves to, through an import.
  const declOf = (n: TS.Node) => {
    let s = checker.getSymbolAtLocation(n);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s?.valueDeclaration ?? s?.declarations?.[0];
  };
  const inFiles = (d: TS.Node | undefined) => !!d && files.has(d.getSourceFile().fileName);
  // Code written in `files` that the walk reads: a function or a method with a body, a class with its own
  // constructor (without one, the library's constructor gets the function), a const holding a function literal.
  // Not a parameter, an ambient declaration, or a variable holding someone else's function.
  const ownCode = (d: TS.Declaration | undefined) =>
    inFiles(d) &&
    (((ts.isFunctionDeclaration(d!) || ts.isMethodDeclaration(d!)) && !!d!.body) ||
      (ts.isClassDeclaration(d!) && d!.members.some((m) => ts.isConstructorDeclaration(m) && !!m.body)) ||
      (ts.isVariableDeclaration(d!) && !!(d!.parent.flags & ts.NodeFlags.Const) && !!d!.initializer && (ts.isArrowFunction(inner(d!.initializer)) || ts.isFunctionExpression(inner(d!.initializer)))));
  const isWrapperCall = (n: TS.Expression) => {
    const e = inner(n);
    return ts.isCallExpression(e) && wrappers.has(nameOf(e)) && inFiles(declOf(calleeOf(e)));
  };
  const madeByWrapper = (n: TS.Node) => {
    if (!ts.isExpression(n)) return false;
    const e = inner(n);
    if (isWrapperCall(e)) return true;
    const d = ts.isIdentifier(e) ? declOf(e) : undefined;
    return !!d && ts.isVariableDeclaration(d) && !!(d.parent.flags & ts.NodeFlags.Const) && !!d.initializer && isWrapperCall(d.initializer);
  };
  const callable = (t: TS.Type): boolean => t.getCallSignatures().length > 0 || t.getConstructSignatures().length > 0 || (t.isUnion() && t.types.some(callable));
  const isFunction = (n: TS.Node) =>
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isAccessor(n) || callable(checker.getNonNullableType(checker.getTypeAtLocation(n)));
  const thenable = (t: TS.Type, at: TS.Node): boolean => {
    if (t.isUnion()) return t.types.some((u) => thenable(u, at));
    const then = t.getProperty("then");
    return !!then && checker.getTypeOfSymbolAtLocation(then, at).getCallSignatures().length > 0;
  };
  const isPromise = (n: TS.Node) => thenable(checker.getTypeAtLocation(n), n);
  // Whether a function hands back a promise: what its signatures return.
  const returnsPromise = (n: TS.Node) => checker.getTypeAtLocation(n).getCallSignatures().some((s) => thenable(s.getReturnType(), n));
  // Whether a call runs its function argument before it returns.
  const runsNow = (call: TS.CallExpression | TS.NewExpression) => {
    const e = inner(call.expression);
    if (ts.isNewExpression(call)) {
      const d = ts.isIdentifier(e) && e.text === "Promise" ? declOf(e) : undefined;
      return !!d && program.isSourceFileDefaultLibrary(d.getSourceFile());
    }
    if (!ts.isPropertyAccessExpression(e)) return false;
    if (TS_WALKS.has(e.name.text)) return !!declOf(e.name)?.getSourceFile().fileName.endsWith("/typescript/lib/typescript.d.ts");
    if (!RUNS_NOW.has(e.name.text)) return false;
    const receiver = checker.getApparentType(checker.getNonNullableType(checker.getTypeAtLocation(e.expression)));
    if (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) return false;
    return SYNC_RECEIVERS.has(receiver.getSymbol()?.getName() ?? "") || checker.isArrayLikeType(receiver);
  };
  // Whether a call is on a promise: a chain's callback counts as chained only then.
  const promiseReceiver = (call: TS.CallExpression) => {
    const e = inner(call.expression);
    return ts.isPropertyAccessExpression(e) && isPromise(e.expression);
  };
  // Whether a function's returned value reaches its caller: not when it is typed to return void.
  const returnsHeld = (fn: TS.Node | undefined) => {
    if (!fn || !ts.isFunctionLike(fn)) return true;
    if (fn.type) return fn.type.kind !== ts.SyntaxKind.VoidKeyword;
    const context = ts.isExpression(fn) ? checker.getContextualType(fn) : undefined;
    const returns = context?.getCallSignatures().map((s) => s.getReturnType()) ?? [];
    return !returns.length || !returns.every((r) => r.flags & ts.TypeFlags.Void);
  };
  // Whether a promise chain's value is returned or awaited.
  const held = (call: TS.Node) => {
    let top = call;
    for (;;) {
      if (ts.isPropertyAccessExpression(top.parent) && CHAINS.has(top.parent.name.text) && ts.isCallExpression(top.parent.parent)) top = top.parent.parent;
      else if (unwrapped(top.parent)) top = top.parent;
      else break;
    }
    if (ts.isAwaitExpression(top.parent)) return true;
    if (ts.isArrowFunction(top.parent) && top.parent.body === top) return returnsHeld(top.parent);
    return ts.isReturnStatement(top.parent) && returnsHeld(ts.findAncestor(top.parent, ts.isFunctionLike));
  };
  const record = (value: TS.Node, to: string, how: Handed["how"], callee: string) => {
    const text = textOf(value);
    const by = how === "bare" || how === "floating" ? [callee, to, text].find((k) => Object.hasOwn(exempt, k)) : undefined;
    out.push({ file: name, line: lineOf(value), to, how: by ? "exempt" : how, text: text.slice(0, 60), ...(by ? { by } : {}) });
  };
  const account = (value: TS.Node, call: TS.CallExpression | TS.NewExpression | undefined, callee: string, property?: string): void => {
    if (ts.isObjectLiteralExpression(value)) {
      for (const p of value.properties) {
        const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        if (ts.isPropertyAssignment(p)) account(p.initializer, call, callee, key);
        else if (ts.isShorthandPropertyAssignment(p)) account(p.name, call, callee, key);
        else if (ts.isMethodDeclaration(p) || ts.isAccessor(p)) account(p, call, callee, key);
        else if (ts.isSpreadAssignment(p)) account(p.expression, call, callee, property);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(value)) return value.elements.forEach((v) => account(v, call, callee, property));
    if (ts.isSpreadElement(value)) return account(value.expression, call, callee, property);
    if (!isFunction(value)) return;
    const to = property === undefined ? callee : `${callee}.${property}`;
    if (madeByWrapper(value)) return record(value, to, "wrapped", callee);
    if (call && runsNow(call)) return record(value, to, returnsPromise(value) ? "bare" : "runs now", callee);
    if (call && ts.isCallExpression(call) && CHAINS.has(callee) && promiseReceiver(call) && held(call)) return record(value, to, "chained", callee);
    record(value, to, "bare", callee);
  };
  // The leaves of a statement's value that could be a promise: behind &&, ||, ??, ?:, a comma or void.
  const leaves = (e: TS.Expression): TS.Expression[] => {
    const x = inner(e);
    if (ts.isVoidExpression(x)) return leaves(x.expression);
    if (ts.isConditionalExpression(x)) return [...leaves(x.whenTrue), ...leaves(x.whenFalse)];
    if (ts.isBinaryExpression(x) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(x.operatorToken.kind)) {
      return [...leaves(x.left), ...leaves(x.right)];
    }
    return [x];
  };
  const walk = (n: TS.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "selfCheck" && ts.isSourceFile(n.parent)) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      if (!isWrapperCall(n as TS.Expression) && !ownCode(declOf(calleeOf(n)))) for (const a of n.arguments ?? []) account(a, n, nameOf(n));
    }
    // A function assigned to a property of an object not written here: `signal.onabort = …`.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) {
      const target = n.left.expression;
      const owner = checker.getTypeAtLocation(target).getSymbol()?.declarations?.[0];
      if (target.kind !== ts.SyntaxKind.ThisKeyword && !inFiles(owner)) account(n.right, undefined, textOf(target), ts.isPropertyAccessExpression(n.left) ? n.left.name.text : undefined);
    }
    if (ts.isExpressionStatement(n)) {
      for (const leaf of leaves(n.expression)) {
        if (isPromise(leaf)) record(leaf, "(no one)", "floating", textOf(leaf));
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(source);
  return out.sort((a, b) => a.line - b.line || a.how.localeCompare(b.how));
}

/** A TypeScript program over `roots` with this directory's tsconfig, and `extra` files held in memory. */
function programOf(ts: typeof TS, dir: string, roots: string[], extra: Record<string, string> = {}): TS.Program {
  const config = ts.readConfigFile(`${dir}tsconfig.json`, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, `${dir}tsconfig.json`);
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => dir;
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => Object.hasOwn(extra, f) || fileExists(f);
  host.readFile = (f) => (Object.hasOwn(extra, f) ? extra[f] : readFile(f));
  host.getSourceFile = (f, language, ...rest) => (Object.hasOwn(extra, f) ? ts.createSourceFile(f, extra[f], language) : getSourceFile(f, language, ...rest));
  return ts.createProgram(roots, options, host);
}

/**
 * What each file hands on that is neither wrapped, run at once nor chained:
 * [how many sites the key covers, why each is safe]. The count is pinned, so a
 * new site under an old key fails the self-check until it is read and counted.
 */
const EXEMPT: Record<string, Record<string, [number, string]>> = {
  "server.ts": {
    Provider: [11, "the provider's settings and its adapter: the library calls each inside its own request handling, where a throw is that request's error answer (measured: a throw in the client validator was that registration's 500)"],
    registerGrantType: [1, "the token exchange's handler: the library runs it inside its token endpoint, where a throw is that request's error answer, as each of its refusals is"],
    jwtVerify: [1, "the key set jose reads while the exchange awaits the verification"],
  },
  "store.ts": {
    transaction: [1, "bun:sqlite wraps the purge in a transaction, which the store runs in line"],
    assign: [4, "the adapter's factory and its methods: the provider calls them inside its request handling, and server.ts calls close, countClients and purge itself, in line"],
  },
  "fetch-guard.ts": {
    reject: [2, "a promise's reject, which cannot throw"],
    resolve: [1, "the resolver's callback in guardedLookup: it checks the answer and logs in a try of its own, and answers through done alone (eval-auth's probes hold an unreadable answer)"],
    "request.lookup": [1, "the socket's lookup, guardedLookup, whose one callback is the resolver's above"],
  },
  "target.ts": {
    "Promise.resolve(pending).catch(failed)": [2, "the guards' own watch on a callback's promise: its handler cannot throw"],
    failed: [2, "the guards' handler, which logs through say and cannot throw"],
    readConfigFile: [1, "the self-check's walk reading tsconfig.json at once"],
    host: [4, "the self-check's program host, which TypeScript calls while the walk builds its program"],
  },
};

async function selfCheck(): Promise<number> {
  let failed = 0;
  const expect = (what: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  const show = (t: Target | undefined) => (t ? `${t.path}|${t.search}` : "refused");

  // the path
  const read: [string, string][] = [
    ["/healthz", "/healthz|"],
    ["/auth/token?x=1", "/auth/token|?x=1"],
    ["/a?b?c", "/a|?b?c"],
    ["/auth", "/auth|"],
    ["/auth?", "/auth|?"],
    ["//x/healthz", "//x/healthz|"],
    ["/auth/../healthz", "/auth/../healthz|"],
    ["/auth/%74oken", "/auth/%74oken|"],
    ["/auth\\token", "/auth\\token|"],
  ];
  const wrong = read.filter(([t, want]) => show(targetOf(t)) !== want);
  expect("a target that starts with / is cut at its first ?, never resolved or decoded, so //x/healthz is not /healthz", !wrong.length, wrong.map(([t]) => `${t} → ${show(targetOf(t))}`).join(", "));
  const refused = [undefined, "", "*", "x", "?a=1", "http://x:99999/healthz", "http://[::1/x", "http://evil.test/healthz", "/a#b", "/a?b#c", "/a b", "/a\tb", "/a\nb", "/a\fb", "/a\rb", "/a\u00a0b", "/a\ufeffb", "/auth\\token#", "/auth\\token\f"];
  const let_ = refused.filter((t) => targetOf(t) !== undefined);
  expect("a target that is not a path, or holds a character the library reads another way, is refused", !let_.length, let_.map((t) => JSON.stringify(t)).join(", "));

  // the path is the library's
  const { default: parseurl } = (await import("parseurl" as string)) as { default: (req: { url: string }) => { pathname: string | null } };
  const libraryPath = (t: string) => parseurl({ url: t }).pathname;
  const alphabet = ["/", "/", "a", "A", "?", "#", "\\", ".", "%2e", "%2F", " ", "\t", "\n", "\f", "\r", "\u00a0", "\ufeff", ":", "@", "x:99999", "//"];
  // mulberry32: every bit of its output varies. An LCG reduced by % read its low bits alone, which
  // alternate, and gave 1,927 distinct targets in 20,000 (review pass 2).
  let seed = 2615;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const fuzzed = Array.from({ length: 20_000 }, () => "/" + Array.from({ length: next() % 10 }, () => alphabet[next() % alphabet.length]).join(""));
  const distinct = new Set(fuzzed).size;
  const accepted = [...read.map(([t]) => t), ...fuzzed].filter((t) => targetOf(t));
  const differ = accepted.filter((t) => targetOf(t)!.path !== libraryPath(t));
  expect(`every target it reads, the library reads as the same path (${accepted.length} accepted of ${read.length + fuzzed.length}, ${distinct} fuzzed targets distinct)`, accepted.length > 1000 && distinct > 12_000 && !differ.length, differ.slice(0, 5).map((t) => JSON.stringify(t)).join(", "));
  // What the library routes on is Koa's ctx.path, so it is held to that too:
  // every UTF-16 code unit inside a path before a `\` and at a path's end.
  // Exactly the eight characters above are refused; a koa or parseurl bump
  // that read another one differently, or a refusal that grew, fails here.
  const { default: Koa } = (await import("koa" as string)) as { default: new () => { createContext(req: object, res: object): { path: string } } };
  const koa = new Koa();
  const koaPath = (url: string) => koa.createContext({ url, headers: {}, socket: {} }, {}).path;
  let swept = 0;
  const koaDiffer: string[] = [];
  for (let c = 0; c < 0x10000; c++) {
    for (const t of [`/a${String.fromCharCode(c)}\\b?q`, `/auth/token${String.fromCharCode(c)}`]) {
      const got = targetOf(t);
      if (!got) continue;
      swept++;
      if (got.path !== koaPath(t)) koaDiffer.push(`U+${c.toString(16).padStart(4, "0")}`);
    }
  }
  expect(`every code unit but the eight it refuses, Koa routes as the same path (${swept} targets)`, swept === 2 * (0x10000 - 8) && !koaDiffer.length, `${swept} read; differ at ${koaDiffer.slice(0, 5).join(", ")}`);
  const reread = ["/auth\\token#", "/auth\\reg#x", "/auth\\token?a#"].map((t) => `${t} → ${libraryPath(t)}`);
  expect("the refusal is needed: with a # the library reads /auth\\token as /auth/token", reread.join() === "/auth\\token# → /auth/token,/auth\\reg#x → /auth/reg,/auth\\token?a# → /auth/token", reread.join(", "));

  // the guard
  const server = serve((req, res) => {
    if (req.url === "/throw") throw new Error("thrown in the listener (expected)");
    if (req.url === "/reject") return Promise.reject(new Error("rejected in the listener (expected)"));
    // A value String() cannot print: the guard's log line must not throw on it.
    if (req.url === "/unprintable") throw Object.create(null);
    if (req.url === "/unprintable-reject") return Promise.reject(Object.create(null));
    if (req.url === "/late") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part");
      return Promise.reject(new Error("rejected after the answer started (expected)"));
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fine");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // What came back. A connection the server leaves open is cut after 3 s and
  // marked, so no row reads its own timeout as the server's close.
  const ask = (target: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      const s = connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      s.on("data", (d) => (out += d.toString("latin1")));
      const timer = setTimeout(() => {
        out = `TIMED OUT ${out}`;
        s.destroy();
      }, 3000);
      s.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
      s.on("error", () => resolve(out));
    });
  const status = (answer: string) => answer.split("\r\n")[0];
  const logged = console.error;
  console.error = () => {};
  const thrown = await ask("/throw");
  const rejected = await ask("/reject");
  const late = await ask("/late");
  const unprintable = await ask("/unprintable");
  const unprintableRejected = await ask("/unprintable-reject");
  const after = await ask("/");
  console.error = logged;
  expect("a throw in the listener is a 500 that says nothing of it", status(thrown) === "HTTP/1.1 500 Internal Server Error" && !thrown.includes("expected"), status(thrown));
  expect("a rejection from the listener is a 500", status(rejected) === "HTTP/1.1 500 Internal Server Error", status(rejected));
  // Bun may not have flushed the started answer before the close: nothing, or the 200's start, and never a 500.
  // A connection left open reads "TIMED OUT …", which neither allows.
  expect("a failure after the answer started closes the connection with no 500", (late === "" || status(late) === "HTTP/1.1 200 OK") && !late.includes(" 500 ") && !late.includes("something went wrong"), JSON.stringify(late.slice(0, 80)));
  expect("a thrown or rejected value that cannot be printed is a 500 too", status(unprintable) === "HTTP/1.1 500 Internal Server Error" && status(unprintableRejected) === "HTTP/1.1 500 Internal Server Error", `${status(unprintable)} | ${status(unprintableRejected)}`);
  expect("and the server goes on answering", status(after) === "HTTP/1.1 200 OK" && after.includes("fine"), status(after));

  // the callbacks handed on (SMD-2665). A throw that escapes is counted here
  // rather than ending this check, so a row can say which one did.
  const { runInNewContext } = await import("node:vm");
  const escaped: string[] = [];
  const escape = (e: unknown) => void escaped.push(whyOf(e).split("\n")[0]);
  process.on("uncaughtException", escape);
  process.on("unhandledRejection", escape);
  const lines: string[] = [];
  // The log, with one name whose line throws, as a log whose stderr is gone would.
  console.error = (line: string) => {
    const first = String(line).split("\n")[0];
    lines.push(first);
    if (first.startsWith("a log that throws")) throw new Error("the log is gone (expected)");
  };
  setTimeout(() => {
    throw new Error("unguarded (expected)");
  }, 0);
  setTimeout(guard("a timer", () => {
    throw new Error("thrown in a timer (expected)");
  }), 0);
  setTimeout(guard("an async timer", async () => {
    throw new Error("rejected in a timer (expected)");
  }), 0);
  setTimeout(guard("an unprintable timer", () => {
    throw Object.create(null);
  }), 0);
  setTimeout(guard("a promise from another realm", () => runInNewContext("Promise.reject(new Error('rejected in another realm (expected)'))")), 0);
  setTimeout(guard("a log that throws", () => {
    throw new Error("thrown with no log (expected)");
  }), 0);
  setTimeout(guard("a log that throws, async", async () => {
    throw new Error("rejected with no log (expected)");
  }), 0);
  const closing = serve((_req, res) => {
    res.on("close", guard("a response's close", () => {
      throw new Error("thrown in a close (expected)");
    }));
    res.end("closing");
  });
  await new Promise<void>((resolve) => closing.listen(0, "127.0.0.1", resolve));
  const closed = await new Promise<string>((resolve) => {
    let out = "";
    const s = connect((closing.address() as AddressInfo).port, "127.0.0.1", () => s.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    s.on("data", (d) => (out += d.toString("latin1")));
    s.on("close", () => resolve(out));
  });
  await Bun.sleep(100);
  closing.close();
  console.error = logged;
  process.off("uncaughtException", escape);
  process.off("unhandledRejection", escape);
  expect("the check sees a throw that escapes: an unguarded timer's, which would end the process", escaped.length === 1 && escaped[0] === "Error: unguarded (expected)", JSON.stringify(escaped));
  const said = [
    "a timer failed: Error: thrown in a timer",
    "an async timer failed: Error: rejected in a timer",
    "an unprintable timer failed: a value that cannot be printed",
    "a promise from another realm failed: Error: rejected in another realm",
    "a log that throws failed: Error: thrown with no log",
    "a log that throws, async failed: Error: rejected with no log",
    "a response's close failed: Error: thrown in a close",
  ];
  const unsaid = said.filter((w) => !lines.some((l) => l.startsWith(w)));
  expect("a throw or a rejection in a guarded callback is logged under its name, a promise from another realm's too, and none escapes, even when the log line throws", !unsaid.length && status(closed) === "HTTP/1.1 200 OK", `missing: ${unsaid.join(" | ")}; logged: ${JSON.stringify(lines)}`);

  // Every function server.ts and the files it imports hand out of their own
  // control is accounted for (handedOut). The walk is held first, on a sample
  // where each line is a case: the spellings a scan of the text missed or
  // misread (a regex holding a backtick or a quote, a space before the
  // parenthesis, `void` of no promise, `close(true)`), the calls it did not
  // know (nextTick, addEventListener, a callback by position, an options
  // object), review pass 2's (a `let` that may be reassigned, an async
  // callback an array or a Promise drops, a library's own `find`, an ambient
  // function, an optional callback, an array, a property assignment, a
  // promise behind && or a comma, a chain in a function typed to return void,
  // a class with no constructor of its own, whose base gets the function),
  // review pass 3's (a `let` called as own code, a `catch` on no promise, an
  // `any` receiver), and the
  // ones that are fine (an array's, a returned chain's, a wrapper's const).
  const { default: ts } = (await import("typescript" as string)) as { default: typeof TS };
  const dir = new URL(".", import.meta.url).pathname;
  const samplePath = `${dir}handed-sample.ts`;
  const sample = [
    'import { lookup } from "node:dns";',
    'import type { Server, ServerResponse } from "node:http";',
    "declare const res: ServerResponse;",
    "declare const db: { close(throwOnError?: boolean): void };",
    "declare const signal: AbortSignal;",
    "declare function guard<A extends unknown[]>(what: string, fn: (...args: A) => unknown): (...args: A) => void;",
    "declare function work(): Promise<void>;",
    "const strip = (s: string) => s.replace(/\\/*$/, \"\").replace(/[`'\"]/g, \"\");",
    'res.on("close", () => work());',
    'res.on("finish", guard("x", () => 1));',
    'let g = guard("y", () => 2);',
    'res.once("close", g);',
    'setTimeout(guard ("z", () => 3), 5);',
    'setTimeout(() => strip("a"), 5);',
    "process.nextTick(() => 4);",
    'signal.addEventListener("abort", () => 5);',
    'lookup("x.test", {}, () => 6);',
    "db.close(true);",
    "[1, 2].map((n) => n + 1);",
    "const held = () => work().then(() => 7);",
    "async function f() { await work().catch(() => 8); return work().finally(() => 9); }",
    "work().then(() => 10);",
    "void work();",
    "function g2() { return void res.destroy(); }",
    'const p = new Promise<void>((resolve, reject) => { res.on("error", reject); resolve(); });',
    '// res.on("close", () => commented());',
    'const s = `res.on("close", () => ${"x"})`;',
    'Bun.serve({ port: 0, fetch: () => new Response("x") });',
    'const k = guard("k", () => 11);',
    'res.once("close", k);',
    "[1].forEach(async () => { await work(); });",
    "const q = new Promise<void>(async (ok) => { await work(); ok(); });",
    "declare class Lib { find(cb: () => void): void }",
    "declare const lib: Lib;",
    "lib.find(() => 13);",
    "declare function later(cb: () => void): void;",
    "later(() => 14);",
    "declare const maybe: (() => void) | undefined;",
    "declare const srv: Server;",
    "srv.close(maybe);",
    "declare function use(fns: (() => void)[]): void;",
    "use([() => 15]);",
    "signal.onabort = () => 16;",
    "declare const cond: boolean;",
    "cond && work();",
    "const tick: () => void = () => work().then(() => 17);",
    "work(), 1;",
    "declare class Base { constructor(f: () => void) }",
    "class Sub extends Base {}",
    "new Sub(() => 18);",
    "let run = (f: () => void) => { f(); };",
    "run(() => 19);",
    "declare const notPromise: { catch(cb: () => void): number };",
    "function h() { return notPromise.catch(() => 20); }",
    "declare const anyv: any;",
    "anyv.forEach(() => 21);",
    'function selfCheck() { res.on("close", () => 12); }',
  ].join("\n");
  const sampleProgram = programOf(ts, dir, [samplePath], { [samplePath]: sample });
  const sampleErrors = ts.getPreEmitDiagnostics(sampleProgram).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  const sampled = handedOut(ts, sampleProgram, samplePath, new Set([samplePath]), new Set(["guard", "serve"]), { reject: "a promise's reject, which cannot throw" })
    .map((h) => `${h.line} ${h.how}`)
    .join(", ");
  const wanted = [
    "9 bare, 10 wrapped, 12 bare, 13 wrapped, 14 bare, 15 bare, 16 bare, 17 bare, 19 runs now, 20 chained, 21 chained, 21 chained",
    "22 bare, 22 floating, 23 floating, 25 exempt, 25 runs now, 28 bare, 30 wrapped, 31 bare, 32 bare, 35 bare, 37 bare, 40 bare",
    "42 bare, 43 bare, 45 floating, 46 bare, 47 floating, 50 bare, 52 bare, 54 bare, 56 bare",
  ].join(", ");
  expect("the walk finds each bare function and floating promise in the spellings it reads, and nothing in a comment, a string or a selfCheck", !sampleErrors.length && sampled === wanted, sampleErrors.length ? sampleErrors.join("; ") : sampled);

  const program = programOf(ts, dir, [`${dir}server.ts`]);
  const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  expect("the program over server.ts and its imports type-checks clean, so no function hides behind an unresolved type (an explicit `any` still would)", !errors.length, errors.slice(0, 3).join("; "));
  const files = new Set(program.getSourceFiles().map((f) => f.fileName).filter((f) => f.startsWith(dir) && !f.includes("/node_modules/") && !f.endsWith(".d.ts")));
  const handed = [...files].flatMap((f) => handedOut(ts, program, f, files, new Set(["guard", "guarded", "serve", "settling"]), EXEMPT[f.slice(dir.length)] ?? {}));
  const loose = handed.filter((h) => h.how === "bare" || h.how === "floating");
  const tally = (how: Handed["how"]) => handed.filter((h) => h.how === how).length;
  // A key covering more sites than it is pinned to has taken in a new one unread; fewer, it is stale.
  const unpinned = Object.entries(EXEMPT).flatMap(([f, keys]) =>
    Object.entries(keys).flatMap(([k, [sites]]) => {
      const n = handed.filter((h) => h.file === f && h.by === k).length;
      return n === sites ? [] : [`${f}: "${k}" covers ${n} site(s), pinned at ${sites}`];
    }),
  );
  expect(
    `every function server.ts and the ${files.size - 1} files it imports hand out is wrapped (${tally("wrapped")}), run at once (${tally("runs now")}), chained (${tally("chained")}) or exempt by a pinned key with a reason (${tally("exempt")}), and no promise floats`,
    files.size >= 9 && tally("wrapped") >= 18 && !loose.length && !unpinned.length,
    [...loose.map((h) => `${h.file}:${h.line} ${h.how} → ${h.to}: ${h.text}`), ...unpinned].join("; ") || `${files.size} files, ${tally("wrapped")} wrapped`,
  );
  server.close();

  console.log(failed ? `\n${failed} probe(s) failed` : "\nall probes hold");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());
