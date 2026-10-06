# Pi permission policy rationale

Why `~/.pi/agent/pi-permissions.jsonc` is shaped the way it is. This document is
tracked by pi-config-sync (`git-sync.jsonc` -> `extraPaths`) so the reasoning
travels with the policy to every machine.

Policy file: [`pi-permissions.jsonc`](./pi-permissions.jsonc)
Extension: `pi-permission-system` (`~/.pi/agent/npm/node_modules/pi-permission-system`)

## The model

**Allow by default. Ask only for file deletes, `sudo`, and credential access.
Hard-deny recursive force deletes.**

- `defaultPolicy.tools` / `bash` / `mcp` / `skills` = `allow`
- Reads and writes run freely, including the `write`/`edit` tools and shell
  create verbs (`>`, `cp`, `mv`, `touch`, `mkdir`, `mktemp`, `ln`, `tee`, `dd`,
  `tar -x`, `unzip`)
- Ask: delete verbs (`rm`, `rmdir`, `unlink`, `shred`, `truncate`,
  `find -delete`, `git clean`, `git rm`, `git reset --hard`, `git restore`),
  `sudo`, and any read or write touching credentials
- Deny: `rm -rf`, `rm -fr`, `rm -r` (declared last)

## Why this shape

### The container already removes most of the blast radius

Pi runs inside the `linux-quick-setup` Docker container (see
`docker-compose.yaml`). The relevant facts:

- Runs as uid 1000 `dev`, `CapEff=0`, no docker socket -> no privilege
  escalation and no container escape.
- `/` is an ephemeral overlay: package installs, `/etc` edits, and dotfiles
  vanish when the container is recreated and never touch the host.
- The only persistent mounts are `/workspace` (the host project directory,
  normally git-tracked) and the `pi-auth`, `pi-sessions`, `pi-state` named
  volumes.

So the classic reason for a read-only/guarded shell - protecting the host OS -
does not apply. Most destructive mistakes are recoverable: `/workspace` is
normally a git repo, and the container itself is disposable.

### Why deletes still ask

Deleting is the one operation that is expensive even when the tree is
git-tracked: untracked and ignored files (`.env`, data, build artifacts, local
DBs) are gone for good, and a wrong `rm` can cost more time than a one-tap
confirmation. Asking on delete keeps the common case frictionless while putting
a speed bump on the irreversible one.

`rm -rf` / `rm -fr` / `rm -r` are denied outright because a recursive-force
delete can wipe the mounted project tree in one command, and the deny is cheap
insurance against a mistake or a prompt-injected instruction.

### Why `sudo` asks

`sudo` cannot do anything in this container (uid 1000, `CapEff=0`), so a prompt
is sufficient; a hard deny would add no safety and only hide the intent.

### Why credentials ask on both read and write

This is the one risk the container does **not** mitigate. The agent process has
to read `~/.pi/agent/auth/auth.json` to talk to the model, the container has
outbound network access, and "re-authenticate" is not the same as "rotate a
leaked key" - a leaked key stays valid until revoked.

Gated paths (the "broader set"): `~/.pi/agent/auth/**`, `~/.git-credentials`,
`~/.netrc`, `~/.npmrc`, `~/.ssh/**`, `~/.aws/**`, `~/.config/gh/**`,
`~/.docker/config.json`, plus name patterns `*token*`, `*secret*`,
`*credential*`, `*.env*`.

Two layers implement this:

1. **Tool resource keys** for the path-bearing built-ins, e.g.
   `"read:*/.pi/agent/auth/*": "ask"`. Built-in tools resolve a target of the
   form `<action>:<normalized-absolute-path>` and match it against `tools`
   patterns in reverse declaration order, so a later credential `ask` beats the
   earlier `"*": "allow"`. Covered actions: `read`, `write`, `edit`, `grep`.
2. **Bash command patterns** (`*auth.json*`, `*.git-credentials*`, `*.env*`, ...)
   because shell commands do not go through the tool resource path.

### Why chains, pipes, and redirection are allowed

`;`, `&&`, `||`, `|`, `$( )`, backticks, and `>` are not separately gated. The
blast radius is disposable, and blocking chaining produced far more prompts than
safety. The cost is that a mutating segment can ride along with an allowed read
command; the delete and credential patterns are written as "anywhere" globs so
they still match inside a chain.

### Why `special.external_directory` is allow

`external_directory` is evaluated before the normal tool check. Leaving it
`ask` would prompt on every read outside the working directory. With `allow`,
external reads fall through to the normal tool rule (`allow`), while the
credential resource keys still govern the sensitive paths. `doom_loop` stays
`ask`.

## How the matching works (and why ordering matters)

- Bash rules are globs matched against the **whole command string**, with
  **last-matching-rule-wins** (`src/wildcard-matcher.ts`, `src/bash-filter.ts`).
  `*` matches any characters, including `;`, `|`, and newlines.
- Because of last-match-wins, the `rm -rf` deny rules are declared **last** so
  they beat the `*rm *` ask. Credential patterns are declared after the delete
  asks; all of those are `ask`, so their relative order does not matter.
- The config is JSONC: comments and trailing commas are supported. The
  extension only **reads** this file (the `/permission-system` modal writes the
  extension `config.json`, not the policy), so comments are safe.

## Known limitations

- Bash credential patterns are best-effort string matches. `cat
  ~/.pi/agent/auth/auth.json` is caught; base64 or `$VAR` indirection is not.
- No egress control is configured. A prompt-injected session can still read and
  exfiltrate keys over the network. If that matters, restrict the container's
  network or use scoped, short-lived keys.
- `mv` deletes its source but is allowed, per the create/delete decision.
- Credential gating covers `read`/`write`/`edit`/`grep` plus bash; `find`/`ls`
  metadata on credential paths is not gated.
- `rm -Rf`, `rm -rF`, and similar flag spellings fall through to the `*rm *`
  ask, not the deny.
- Redirection is allowed, so `> existing-file` overwrites without asking.

## How to change the policy

1. Edit `~/.pi/agent/pi-permissions.jsonc`.
2. Validate: the file must parse as JSONC and satisfy
   `schemas/permissions.schema.json` in the extension package.
3. `/reload` (or restart Pi) so the extension re-reads the policy.
4. pi-config-sync commits and pushes the change automatically on the next sync;
   run `/gitsync sync` to do it immediately.

Keep broad rules first and specific overrides later; put `deny` rules last.
