import datetime, json, os, re, subprocess, sys
mode, args = sys.argv[1], sys.argv[2:]
dropped = re.compile("(?:%s)" % os.environ["DROPPED"], re.I)
set_by_canary = re.compile("(?:%s)" % os.environ["SET_BY_CANARY"])
runtime_var = re.compile(r"(?:DOCKER|PODMAN|CONTAINERS?)_[A-Za-z0-9_]*|PATH|HOME|USER|LOGNAME|TMPDIR|SSH_AUTH_SOCK|XDG_[A-Z_]+")
bare = {k: v for k, v in os.environ.items() if runtime_var.fullmatch(k)}
UNSET = "OB1-CANARY-UNSET-7f3a9c"
STRONG = 12
# The canary's own values of what canary_compose sets in the shell (CANARY_SET,
# but OB1_GIT_SHA, a build's), which env_file write puts in its file.
OWN = {"SERVER_PORT": os.environ.get("CANARY_PORT", ""), "SERVER_BIND": "127.0.0.1", "OB1_TIER": "canary", "COMPOSE_PROFILES": ""}
if mode in ("write", "made", "own-fix") and not OWN["SERVER_PORT"].isdigit():
    sys.exit("no CANARY_PORT, the canary's port, for %s" % mode)
def compose(env_file, text, *cmd, env=bare):
    # On the shell's environment, a variable of the shell's that is not
    # UTF-8 is not the file's fault: read past it (review pass 4).
    try:
        r = subprocess.run([os.environ["RT"], "compose", "-p", os.environ["PROJ"], "--env-file", env_file, "-f", "-", *cmd], input=text, capture_output=True, text=True, env=env, errors="strict" if env is bare else "surrogateescape", timeout=120)
    except UnicodeError:
        sys.exit("%s, or a container runtime variable in the environment, holds bytes that are not UTF-8" % env_file)
    except subprocess.TimeoutExpired:
        sys.exit("compose did not answer in 120 s reading %s" % env_file)
    if r.returncode:
        sys.exit("compose could not read %s" % env_file)
    return r.stdout
def names(env_file, env=bare):
    return set(re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=", compose(env_file, "services: {}\n", "config", "--environment", env=env), re.M))
def values(env_file, cand, env=bare):
    # Unset renders as UNSET and reads as None: a name read off a value's
    # second line is no setting, and is neither written nor compared as one.
    body = "".join("      \"%s\": \"${%s-%s}\"\n" % (n, n, UNSET) for n in cand)
    doc = json.loads(compose(env_file, "services:\n  probe:\n    image: probe\n" + ("    environment:\n" + body if cand else ""), "config", "--format", "json", env=env))
    got = doc["services"]["probe"].get("environment") or {}
    # compose writes a value's $ as $$ in its output, on both sides alike.
    raw = {n: got.get(n) or "" for n in cand}
    return {n: None if raw[n] == UNSET else raw[n].replace("$$", "$") for n in cand}
def file_names(env_file):
    return sorted(names(env_file) - names(os.devnull))
UNNAMED = "ob1-canary-unnamed-7f3a9c"
def project_of(env_file, env=bare):
    # The project the file names: compose renders a stub carrying a name of its
    # own, under no -p (a -p is what every other read here reports as the name).
    try:
        r = subprocess.run([os.environ["RT"], "compose", "--env-file", env_file, "-f", "-", "config"], input="name: %s\nservices: {}\n" % UNNAMED, capture_output=True, text=True, env=env, timeout=120)
    except (UnicodeError, subprocess.TimeoutExpired):
        sys.exit("compose could not read %s for its project" % env_file)
    m = re.search(r"^name: (.*)$", r.stdout, re.M) if r.returncode == 0 else None
    if not m:
        sys.exit("compose could not read %s for its project" % env_file)
    name = m.group(1).strip().strip("\"'")
    return None if name == UNNAMED else name
def guard(stable, out):
    # Stable's password as compose reads it on its own and with the shell
    # (one stable builds from a shell variable; review pass 4).
    pws = {v for v in (values(stable, ["POSTGRES_PASSWORD"], env)["POSTGRES_PASSWORD"] for env in (bare, os.environ)) if v}
    cand = file_names(out)
    c = values(out, cand)
    mine = c.get("POSTGRES_PASSWORD") or ""
    mine_with_shell = values(out, ["POSTGRES_PASSWORD"], os.environ)["POSTGRES_PASSWORD"] or ""
    problems = []
    if not mine and mine_with_shell:
        problems.append("its POSTGRES_PASSWORD reads otherwise with the shell's variables")
    elif not mine:
        problems.append("it sets no POSTGRES_PASSWORD")
    elif mine in pws:
        problems.append("its POSTGRES_PASSWORD is stable's")
    elif any(len(pw) >= STRONG and pw in mine for pw in pws):
        problems.append("its POSTGRES_PASSWORD holds stable's")
    # The password ALTER ROLE sets is the one compose hands the servers: not
    # built from the shell (compose reads it otherwise there), and with no
    # newline, which the shell's $(…) would cut from its end (review pass 4).
    if mine and mine_with_shell != mine:
        problems.append("its POSTGRES_PASSWORD reads otherwise with the shell's variables")
    if "\n" in mine:
        problems.append("its POSTGRES_PASSWORD spans lines")
    for n in cand:
        v = c[n] or ""
        if n != "POSTGRES_PASSWORD" and any(len(pw) >= STRONG and pw in v for pw in pws):
            problems.append("%s holds stable's database password" % n)
        if "\nPOSTGRES_PASSWORD=" in v:
            problems.append("%s holds a line setting POSTGRES_PASSWORD" % n)
    named = project_of(out)
    if named is not None and named != os.environ["OWN_PROJECT"]:
        problems.append("COMPOSE_PROJECT_NAME names %s, not the canary's project, %s" % (named, os.environ["OWN_PROJECT"]))
    # Compose run by hand with the file reads it under the shell's variables:
    # a name built from them (${X}) names another brain there (review pass 2).
    shell_env = {k: v for k, v in os.environ.items() if k != "COMPOSE_PROJECT_NAME"}
    if project_of(out, shell_env) != named:
        problems.append("its COMPOSE_PROJECT_NAME reads otherwise with the shell's variables")
    return problems
if mode == "value":
    sys.stdout.write(values(args[0], [args[1]])[args[1]] or "")
    sys.exit(0)
if mode == "values":
    got = values(args[0], args[1:])
    print("\n".join((got[n] or "").replace("\\", "\\\\").replace("\n", "\\n") for n in args[1:]))
    sys.exit(0)
if mode == "project":
    sys.stdout.write(project_of(args[0]) or "")
    sys.exit(0)
quote = lambda v: "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$").replace("\n", "\\n") + "\""
stable, out = args
if mode == "own-fix":
    import hashlib, secrets
    sha = lambda raw: hashlib.sha256(raw.encode()).hexdigest()
    def entries(spec):
        # MCP_ACCESS_KEYS as server-portable/auth.ts parseKeyRecords reads it:
        # name:scope:sha256, by commas or newlines, blanks and comments skipped.
        got = []
        for e in re.split(r"[,\n]", spec or ""):
            e = e.strip()
            if not e or e.startswith("#"):
                continue
            parts = [x.strip() for x in e.split(":")]
            got.append((e, parts[0] if len(parts) == 3 else "", parts[1] if len(parts) == 3 else "", parts[2].lower() if len(parts) == 3 else ""))
        return got
    s = values(stable, ["MCP_ACCESS_KEYS", "MCP_ACCESS_KEY", "OB1_HOOK_SECRETS", "OB1_PLUGIN_DB_PASSWORD", "OB1_WORKER_KEY", "OB1_FORWARDER_KEY"])
    c = values(out, list(OWN) + ["MCP_ACCESS_KEYS", "MCP_ACCESS_KEY", "OB1_CANARY_KEY", "OB1_HOOK_SECRETS", "OB1_PLUGIN_DB_PASSWORD", "OB1_WORKER_KEY", "OB1_FORWARDER_KEY"])
    # deploy/env-file.ts replaces a setting by its line: one whose quote opens
    # on its line and closes on a later one would leave its continuation
    # behind (review pass 1). Read off the file's own lines, not its value: a
    # value holding \n written on one line (canary.sh's own `write` escapes a
    # line break so) is replaced whole (review pass 2).
    file_lines = open(out, encoding="utf-8", errors="replace").read().split("\n")
    def spans_lines(name):
        for line in file_lines:
            m = re.match(r"\s*(?:export\s+)?%s\s*=\s*(.*)$" % name, line)
            if not m or m.group(1)[:1] not in ("\"", "'"):
                continue
            q, rest, i = m.group(1)[0], m.group(1)[1:], 0
            while i < len(rest):
                if q == "\"" and rest[i] == "\\":
                    i += 2
                    continue
                if rest[i] == q:
                    break
                i += 1
            else:
                return True
        return False
    # The Linear names the canary's file sets, in any letter case (SMD-3312).
    linear = [n for n in file_names(out) if re.fullmatch(r"LINEAR_[A-Z0-9_]*", n, re.I)]
    spans = [n for n in list(OWN) + ["MCP_ACCESS_KEYS", "MCP_ACCESS_KEY", "OB1_CANARY_KEY", "OB1_HOOK_SECRETS", "OB1_PLUGIN_DB_PASSWORD", "OB1_WORKER_KEY", "OB1_FORWARDER_KEY"] + linear if spans_lines(n)]
    # Stable's keys: its MCP_ACCESS_KEYS entries, its legacy key, and its
    # MCP server's forward key, listed there or not (SMD-2287 review pass 3).
    stable_fwd = (s["OB1_FORWARDER_KEY"] or "").strip()
    stable_digests = {d for _, _, _, d in entries(s["MCP_ACCESS_KEYS"]) if d} | ({sha(s["MCP_ACCESS_KEY"])} if s["MCP_ACCESS_KEY"] else set()) | ({sha(stable_fwd)} if stable_fwd else set())
    fix, said = {}, []
    # The canary's port, address, tier and profiles (SMD-2874 PR 1).
    for n, v in OWN.items():
        if c[n] != v:
            fix[n] = v
            said.append("%s=%s%s" % (n, quote(v), " (it said %s)" % c[n] if n == "SERVER_PORT" and c[n] else ""))
    # Its access keys (SMD-2874 PR 2): none of stable's, and one of its own,
    # minted here, its raw key in OB1_CANARY_KEY for the smoke and the
    # connector. Acceptance is MCP_ACCESS_KEYS alone, so a key stable accepts
    # opens the canary only through it.
    have = entries(c["MCP_ACCESS_KEYS"])
    kept = [x for x in have if x[3] not in stable_digests]
    raw = c["OB1_CANARY_KEY"] or ""
    own_ok = bool(raw) and sha(raw) not in stable_digests and any(d == sha(raw) and scope == "write" for _, _, scope, d in kept)
    if len(kept) < len(have):
        said.append("removed %d of stable's access keys from MCP_ACCESS_KEYS" % (len(have) - len(kept)))
    def unused(base):
        # A name no kept entry holds (parseKeyRecords refuses one twice): an
        # operator's own entry under the canary's name stays (code review).
        taken = {x[1] for x in kept}
        name, n = base, 2
        while name in taken:
            name = "%s-%d" % (base, n)
            n += 1
        return name
    if not own_ok:
        raw = secrets.token_hex(32)
        name = unused(os.environ["OWN_PROJECT"])
        kept = kept + [("%s:write:%s" % (name, sha(raw)), name, "write", sha(raw))]
        fix["OB1_CANARY_KEY"] = raw
        said.append("minted the canary's own write key, %s (its hash in MCP_ACCESS_KEYS, the raw key in OB1_CANARY_KEY)" % name)
    # Its forward key (SMD-2287): the MCP server calls the REST core with it
    # beside each client's key, and refuses to start without one. Minted as
    # the write key is, in place of stable's (whose entries went with
    # stable's keys above), or of one no forward entry here holds. Trimmed,
    # as the MCP server reads it (review pass 1). Named for the MCP server,
    # since the REST core records the name as who carried each request, and
    # `forwarder` alone is the stack's port forwarder (review pass 3).
    fwd = (c["OB1_FORWARDER_KEY"] or "").strip()
    fwd_stable = bool(fwd) and sha(fwd) in stable_digests
    fwd_ok = bool(fwd) and not fwd_stable and any(d == sha(fwd) and scope == "forward" for _, _, scope, d in kept)
    if not fwd_ok:
        # The forward entries an earlier mint here made, whose raw key this
        # file no longer holds, go with the one it replaces (review pass 1).
        # Another name's forward entry is the operator's, and stays; so does
        # any other scope's under any name (review pass 2).
        base = os.environ["OWN_PROJECT"] + "-mcp-forwarder"
        minted_here = re.compile(re.escape(base) + r"(?:-(?:[2-9]|[1-9][0-9]+))?")
        before = len(kept)
        kept = [x for x in kept if not (x[2] == "forward" and minted_here.fullmatch(x[1]))]
        if len(kept) < before:
            said.append("removed %d forward entr%s an earlier up minted (%s, %s-2 and on) from MCP_ACCESS_KEYS: the file no longer holds %s" % (before - len(kept), "y" if before - len(kept) == 1 else "ies", base, base, "its raw key" if before - len(kept) == 1 else "their raw keys"))
        was = ", in place of stable's" if fwd_stable else ", in place of one MCP_ACCESS_KEYS does not hold as a forward key" if fwd else ""
        fwd = secrets.token_hex(32)
        name = unused(base)
        kept = kept + [("%s:forward:%s" % (name, sha(fwd)), name, "forward", sha(fwd))]
        fix["OB1_FORWARDER_KEY"] = fwd
        said.append("minted the canary's own forward key, %s (its hash in MCP_ACCESS_KEYS, the raw key in OB1_FORWARDER_KEY%s)" % (name, was))
    if len(kept) < len(have) or not own_ok or not fwd_ok:
        fix["MCP_ACCESS_KEYS"] = ",".join(e for e, _, _, _ in kept)
    # Raw keys and secrets of stable's the canary never needs.
    for n in ("MCP_ACCESS_KEY", "OB1_WORKER_KEY"):
        if c[n] and (sha(c[n]) in stable_digests or c[n] == s.get(n)):
            fix[n] = ""
            said.append("cleared %s (a key of stable's)%s" % (n, "; a canary worker needs one of its own: bun server-portable/keygen.ts --name canary-workers --scope capture, its line in MCP_ACCESS_KEYS and its key here" if n == "OB1_WORKER_KEY" else ""))
    # Linear (SMD-3312): the canary's board-sync reads the board with a
    # LINEAR_API_KEY of its own, never stable's, which may be able to write
    # and which the canary's unreleased db/ code would hold; and it never
    # comments, so any other Linear key (the comment key, pasted in) goes too,
    # beside canary_compose holding it empty, so a board-sync started by hand
    # from this file cannot post either. The exact name alone is a read key:
    # compose reads ${LINEAR_API_KEY} by its case. Stable's is any of stable's
    # Linear keys, its comment key among them, by value, spaces aside (review
    # pass 2: its comment key pasted as the canary's read key passed).
    if linear:
        # Compose reads a name set on two lines from the last, so a value on an
        # earlier one is neither read nor compared, and a clearing removes
        # every line of it, the canary's own key with stable's: two lines
        # that each hold a value (= or :, as compose reads either) are refused,
        # named, before anything is written (review pass 2). An empty one, as a
        # clearing leaves, is no second key (review pass 3). (Any other Linear
        # name is cleared whatever its lines hold, every one.)
        def valued(line):
            m = re.match(r"\s*(?:export\s+)?LINEAR_API_KEY\s*[=:](.*)$", line)
            return bool(m) and bool(m.group(1).strip().strip("\"" + "'").strip())
        if "LINEAR_API_KEY" in linear and sum(1 for line in file_lines if valued(line)) > 1:
            sys.exit("LINEAR_API_KEY is set on more than one line in %s, and compose reads only the last: keep one line, with the canary's own key (or none)" % (os.environ.get("SHOWN") or out))
        lv = values(out, linear)
        # A key that reads otherwise with the shell's variables (${X:-…}) is not
        # the one compared here, nor the one step 6 reads, but compose hands the
        # container that reading: refused, as guard refuses such a database
        # password (review pass 3).
        if "LINEAR_API_KEY" in linear and (values(out, ["LINEAR_API_KEY"], os.environ)["LINEAR_API_KEY"] or "").strip() != (lv["LINEAR_API_KEY"] or "").strip():
            sys.exit("LINEAR_API_KEY in %s reads otherwise with the shell's variables: write the canary's key itself, no ${...}" % (os.environ.get("SHOWN") or out))
        # Stable's Linear keys: its file's, read without the shell and with it (a
        # value built from a shell variable; review pass 3), and the values
        # canary.sh found exported in its own shell and unset (SHELL_LINEAR),
        # which stable's board-sync may run on with no line in its file.
        stable_linear = [n for n in file_names(stable) if re.fullmatch(r"LINEAR_[A-Z0-9_]*", n, re.I)]
        stable_by_value = {}
        for env in (bare, os.environ):
            for n, v in (values(stable, stable_linear, env) if stable_linear else {}).items():
                if (v or "").strip():
                    stable_by_value.setdefault(v.strip(), "stable's %s" % n)
        for v in os.environ.get("SHELL_LINEAR", "").split("\n"):
            if v.strip():
                stable_by_value.setdefault(v.strip(), "a Linear key exported in canary.sh's shell")
        for n in linear:
            v = (lv[n] or "").strip()
            if not v:
                continue
            if n != "LINEAR_API_KEY":
                fix[n] = ""
                said.append("cleared %s (a Linear key the canary never holds: its board-sync reads the board with a LINEAR_API_KEY of its own and never comments)" % n)
            elif v in stable_by_value:
                fix[n] = ""
                said.append("cleared LINEAR_API_KEY (%s): the canary's board-sync reads with a key of its own, a Linear personal API key made with Read access alone" % stable_by_value[v])
    # plugin=secret pairs separated by spaces, the first = the separator, as
    # server-portable/core/plugins.ts hookSecrets reads them: any secret of
    # stable's, under any plugin's name (review pass 1: split on commas, it
    # matched only the whole value).
    hooks = lambda v: {x.split("=", 1)[1] for x in (v or "").split() if "=" in x and x.split("=", 1)[0] and x.split("=", 1)[1]}
    stable_hooks = hooks(s["OB1_HOOK_SECRETS"])
    pairs = (c["OB1_HOOK_SECRETS"] or "").split()
    own_pairs = [x for x in pairs if not ("=" in x and x.split("=", 1)[1] in stable_hooks)]
    if len(own_pairs) < len(pairs):
        # Stable's pairs out, the canary's own kept.
        fix["OB1_HOOK_SECRETS"] = " ".join(own_pairs)
        said.append("cleared OB1_HOOK_SECRETS of stable's webhook secrets (%d); a webhook OB1_HOOKS serves with no secret of the canary's answers 503 until it has one" % (len(pairs) - len(own_pairs)))
    # The plugin role's password (SMD-3032): its own wherever stable sets one;
    # the canary's migrate sets the role to it.
    sp, cp = s["OB1_PLUGIN_DB_PASSWORD"], c["OB1_PLUGIN_DB_PASSWORD"]
    if sp and (not cp or cp == sp or (len(sp) >= STRONG and sp in cp)):
        fix["OB1_PLUGIN_DB_PASSWORD"] = secrets.token_hex(24)
        said.append("OB1_PLUGIN_DB_PASSWORD, a fresh one (up sets the plugin role to it before the refresh)")
    # A setting spanning lines is refused only when it must be rewritten: one
    # the server reads (parseKeyRecords takes entries a line each) and that
    # needs nothing is left as it is (code review).
    blocked = [n for n in spans if n in fix]
    if blocked:
        # A Linear key is cleared, not rewritten: its lines go (review pass 2).
        lin = [n for n in blocked if n in linear]
        other = [n for n in blocked if n not in linear]
        sys.exit("; ".join(([("%s in %s spans lines: write it on one line, its entries separated by commas" % (", ".join(other), os.environ.get("SHOWN") or out))] if other else [])
                           + ([("%s in %s spans lines, and the canary never holds it: delete its lines" % (", ".join(lin), os.environ.get("SHOWN") or out))] if lin else [])))
    print(json.dumps({"values": fix, "said": said}))
    sys.exit(0)
if mode == "write":
    cand = file_names(stable)
    s = values(stable, cand)
    shell = names(os.devnull, os.environ)
    live = values(stable, [n for n in cand if n not in shell], os.environ)
    built = [n for n in live if not dropped.fullmatch(n) and not set_by_canary.fullmatch(n) and live[n] != s[n]]
    if built:
        sys.exit("%s in %s take part of their value from the shell (${...}); write the canary's file yourself, with the values it should have" % (", ".join(built), stable))
    with os.fdopen(os.open(out, os.O_WRONLY | os.O_TRUNC), "w") as f:
        f.write("# The canary's own env file (deploy/canary.sh, SMD-2583), written by `up`\n# on %s from %s as compose read it: every setting but\n# its database password, port, address, tier and profiles, which are its own,\n# the public origin, which it has none of, and the other profiles' secrets.\n# Edit it to carry a change of stable's across, or delete it to make it\n# again at the next `up`.\n" % (datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), os.environ["FROM"]))
        for n in cand:
            if not dropped.fullmatch(n) and not set_by_canary.fullmatch(n) and s[n] is not None:
                f.write("%s=%s\n" % (n, quote(s[n])))
        f.write("POSTGRES_PASSWORD=%s\n" % quote(os.environ["CANARY_PW"]))
        f.write("COMPOSE_PROJECT_NAME=%s\n" % quote(os.environ["OWN_PROJECT"]))
        for n, v in OWN.items():
            f.write("%s=%s\n" % (n, quote(v)))
    sys.exit(0)
if mode == "guard":
    problems = guard(stable, out)
    if problems:
        sys.exit("; ".join(problems))
    sys.exit(0)
cand = sorted(set(file_names(stable)) | set(file_names(out)))
s, c = values(stable, cand), values(out, cand)
if mode == "drift":
    print(" ".join(n for n in cand if not dropped.fullmatch(n) and not set_by_canary.fullmatch(n) and s[n] != c[n]))
    sys.exit(0)
problems = []
if c.get("POSTGRES_PASSWORD") != os.environ["CANARY_PW"]:
    problems.append("POSTGRES_PASSWORD is not the one written")
own = values(out, list(OWN))
problems += ["%s is not the canary's" % n for n, v in OWN.items() if own[n] != v]
if project_of(out) != os.environ["OWN_PROJECT"]:
    problems.append("COMPOSE_PROJECT_NAME is not the canary's project")
for n in cand:
    if n == "POSTGRES_PASSWORD":
        continue
    if dropped.fullmatch(n):
        if c[n]:
            problems.append("%s, a left-out setting, is set" % n)
    elif set_by_canary.fullmatch(n):
        continue
    elif c[n] != s[n]:
        problems.append("%s reads otherwise than in stable's" % n)
problems += [g for g in guard(stable, out) if g not in problems]
if problems:
    sys.exit("; ".join(problems))
