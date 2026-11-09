# Opt-in learning toolkit

Personal integration of [amosblomqvist/learn](https://github.com/amosblomqvist/learn),
reviewed at commit `7cfd8942f82ab9476e63572387e1fe9bcea5082c`.
The upstream teaching philosophy, quiz implementation, and maker/researcher prompts
are adapted here; logging, Linux rendering, and integration are locally maintained.
Upstream did not include a license file at that revision; no new license or
redistribution permission is asserted by this integration. Review upstream's terms
before redistributing these adaptations.

## Shared `learn` prefix

| Resource | Names |
| --- | --- |
| Slash commands | `/learn-doctor`, `/learn-log`, `/learn-unlog` |
| Skills | `/skill:learn-teach`, `/skill:learn-visualize` |
| Extension bundle / package | `extensions/learn/` / `learn-toolkit` |
| Main tools | `learn_status`, `learn_quiz` |
| Child-only tools | `learn_write_mermaid`, `learn_edit_mermaid`, `learn_render_mermaid`, and the matching `learn_*_svg` tools |
| Agents | `learn.researcher`, `learn.mermaid-maker`, `learn.svg-maker` |

Unprefixed toolkit commands, skills, and tool aliases are not registered. Shared
Pi tools such as `ask_user_question`, `read`, and the web tools are unchanged.
Existing linked-note state and historical quiz backfills remain compatible.
Run `/reload` after this naming update.

## Start a lesson

1. Start Pi in your Obsidian vault, or mount that vault into the container as the
   working directory. The host Obsidian app and container must see the **same files**.
2. Run `/reload` after installing/syncing the toolkit, then `/learn-doctor`.
3. Optionally create/open an ordinary note, then link its existing **container-visible**
   path with `/learn-log /workspace/Notes/Lesson.md`. Spaces in paths are supported.
4. Run `/skill:learn-teach <topic and goal>`.
5. Answer the graded quizzes. `Tab` focuses the optional note; `Ctrl+J` adds a newline.
   `Ctrl+]` hides/reopens the quiz overlay; `PgUp`/`PgDn` scroll long questions or
   feedback. After submitting, `Enter` or `Esc` dismisses the feedback.
6. `/learn-unlog` stops mirroring the session.

Teaching and visualization skills set `disable-model-invocation: true`. They do not
turn normal coding explanations into lessons. Invoke `/skill:learn-teach` explicitly,
or ask for a structured teaching lesson: the `learn_status` tool supplies the
skill path for that explicit request. `/skill:learn-visualize <brief>` is also available
for a standalone requested visual.

A requested lesson authorizes narrowly scoped `learn.researcher`,
`learn.mermaid-maker`, and `learn.svg-maker` delegations. Their models inherit the
current parent model, which must support image inspection for verified visuals.
No author's model IDs, API keys, or second subagent implementation are installed.

## Notes and images

- Logging is opt-in and persisted per session/branch in `learn-md-log` custom entries.
  It captures user/assistant prose and quiz/question Q&A, **not** thinking blocks or
  arbitrary tool output. Sensitive information you type or the assistant repeats can
  still appear in the note; review it before sharing.
- Linking **appends** a deduplicated backfill of the active branch. Existing note
  content is never overwritten. Hidden markers make repeated linking/resuming
  idempotent; do not remove them if you want deduplication. Tree changes append
  newly visited branch material rather than rewriting previously logged history.
- Quiz questions use the shuffled display order. Answers/explanations are logged
  only after submission; cancelling never reveals them.
- The existing rpiv `ask_user_question` owns all preference/decision questions,
  including its schema, notes, and configurable collapse key. `learn_quiz` is a separate
  graded tool. Native `executionMode: sequential` serializes mixed quiz/question
  batches, without patching rpiv or relying on its private state.
- `learn_status` reports the linked note and absolute image output directory.
  Makers receive that directory explicitly: `<note-directory>/viz`, or `<cwd>/viz`
  without a linked note. Embed the returned unique PNG filename as
  `![[viz-…png|500]]`. Keep the directory inside the same Obsidian vault.
- Missing/deleted/unwritable notes pause logging rather than recreating files.
  Fix the note, then relink. Plan mode pauses logging and maker writes/rendering.
  Config-directory outputs and extension-owned `.pi/plans` paths are refused.
- Notes/images remain in the vault, outside `~/.pi/agent`, so config sync never
  uploads learning content. Only code, skills, agent definitions, and the renderer
  dependency lock are synced. Renderer `node_modules` and temporary previews are
  not synced; previews are cleaned up on child shutdown.

## Install / reproduce

The setup repository owns `install_pi_learn.sh` and the Dockerfile. The Pi config
repository owns this directory, `skills/{learn-teach,learn-visualize}`, and `agents/learn`.
`git-sync.jsonc` explicitly allows `agents/`; no changes to the existing Pi package
list or built-in researcher are needed.

From a checkout of `linux-quick-setup`:

```bash
# npm dependencies only (also called by install_pi.sh when the toolkit is present)
bash install_pi_learn.sh
# Debian/Ubuntu host or an older running container: install system renderers too
bash install_pi_learn.sh --system-deps
```

`PI_CODING_AGENT_DIR` overrides the default `~/.pi/agent`. The helper uses `npm ci`
with the committed lock, `--ignore-scripts`, and `--legacy-peer-deps`. Pi host peers
are not copied into the extension, and Puppeteer never downloads a second browser.
Run the helper again after syncing a changed dependency lock. `/learn-doctor` checks
presence; the render smoke tests below check actual operation.

Mermaid uses locked `@mermaid-js/mermaid-cli@12.2.0` and `puppeteer@25.16.0` plus
system Chromium; SVG uses `rsvg-convert` (`librsvg2-bin`). Install fonts too
(`fonts-dejavu-core` on Debian). On non-Debian Linux, install equivalent system
packages manually, then run the helper without `--system-deps`.

`PI_LEARN_CHROME` can select an absolute browser executable. Chromium's sandbox
stays enabled on hosts. The Dockerfile sets `PI_LEARN_CHROME_NO_SANDBOX=1`, because
Docker's default restrictions prevent its user-namespace sandbox; an existing Docker
container is also detected by `/.dockerenv` when the setting is absent. Set it to
`0` to insist on the sandbox; never disable it casually on an unsandboxed host.
SVG must be self-contained (no scripts, external images/styles, or entities), and
Mermaid uses strict security mode. These guards are not a filesystem/OS sandbox.

The image installs the system packages and invokes the npm helper through
`install_pi.sh`. Build with a `PI_SYNC_REF` containing this config. Older config
refs without the toolkit are skipped. The image's build gate runs the suite plus
real rendering when the synced tests are present. Updating a running container's
config alone does not install new local-extension dependencies: use the helper or
rebuild. Push both repos before recreating a pull-reset container.

## Tests

Native `node:test` files live in `extensions/learn/tests/`. They require Node.js
22.19+ and an npm-installed Pi SDK (the helper locates the installed Pi binary).
No model calls, credentials, real questionnaire answers, or git pushes are needed.

```bash
# All unit/runtime tests; external render smoke tests skipped
npm test --prefix ~/.pi/agent/extensions/learn
# Full suite, including real Chromium/Mermaid and SVG renders
PI_LEARN_RENDER_SMOKE=1 npm test --prefix ~/.pi/agent/extensions/learn
# One test file
cd ~/.pi/agent/extensions/learn
node --experimental-strip-types --test tests/quiz.test.mjs
# One named test
node --experimental-strip-types --test --test-name-pattern='cancel never' tests/quiz.test.mjs
```

The Docker build uses the full-suite command above when this toolkit is present;
the setup repo's manual image-publishing workflow therefore runs it too. A live
researcher/maker launch remains a separate integration check, since it needs the
operator's configured provider and may incur model usage.
