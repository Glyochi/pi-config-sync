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
| Main tools | `learn_status`, `learn_quiz`, `learn_checkpoint` |
| Child-only tools | `learn_write_mermaid`, `learn_edit_mermaid`, `learn_render_mermaid`, and the matching `learn_*_svg` tools |
| Agents | `learn.researcher`, `learn.mermaid-maker`, `learn.svg-maker` |

Unprefixed toolkit commands, skills, and tool aliases are not registered. Shared
Pi tools such as `ask_user_question`, `read`, and the web tools are unchanged.
Existing linked-note state and historical quiz backfills remain compatible.
Run `/reload` after updating the toolkit.

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
- Linking **appends** a deduplicated backfill of the active branch. Existing
  conversation and handwritten prose are not replaced. After navigation is
  explicitly initialized, only marked generated TOC/progress regions are updated;
  topic headings can also be inserted for a requested historical backfill. Hidden
  message markers keep repeated linking/resuming idempotent; do not remove them.
  Tree changes append newly visited material rather than rewriting logged history.
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
  Fix the note, then relink. A deleted progress companion is not silently recreated;
  restore it or explicitly request a rebuild. Plan mode pauses logging,
  checkpoints, and maker writes/rendering.
  Config-directory outputs and extension-owned `.pi/plans` paths are refused.
- Notes/images remain in the vault, outside `~/.pi/agent`, so config sync never
  uploads learning content. Only code, skills, agent definitions, and the renderer
  dependency lock are synced. Renderer `node_modules` and temporary previews are
  not synced; previews are cleaned up on child shutdown.

## Topic navigation and progress

The teaching skill maintains two views for linked lessons:

```text
Notes/
├── Lesson.md        # Clickable topic TOC + chronological conversation
└── Lesson.goal.md   # Goal, current position, next step, evidence and Mermaid map
```

Both are ordinary Obsidian Markdown. The TOC uses native heading wikilinks;
numbered headings keep repeated topic names/reviews unambiguous. The companion
uses relative Markdown links back to topic sections and a fenced `mermaid`
flowchart. No Obsidian plugin, image rendering, new dependency, or extra model
request is required to maintain the map. Future topics appear in the roadmap,
not as broken TOC links.

`/learn-log` alone still only links/appends to an **existing** log. The skill calls
`learn_checkpoint` once creation of the progress companion is authorized. This
user's requested linked-lesson workflow is standing consent; elsewhere ask before
initialization. Nothing is created for an unlinked or ordinary coding session.
Historical topic backfill is separately requested; there is no automatic semantic
inference over old messages.

### Checkpoints

`learn_status` now reports `progressNote`, `progressNoteExists`,
`progressRevision`, and the current `progress` snapshot. On resume the teacher
reads the companion and follows the relevant source links, rather than restarting
or rereading the entire conversation. `progressError`/`progressWarning` identify
invalid metadata, missing notes, or an out-of-date derived view. Very large
snapshots return `progressSummaryOnly` and `progressStateSource`; read that log's
managed TOC for full topic IDs/dependencies/evidence. Stored data is not truncated.

`learn_checkpoint` is a sequential, model-only tool with these fields:

- `expectedRevision` (required): the latest `progressRevision`; `0` before setup.
- `initialize: true`: creation consent for the first checkpoint, with a `goal` and
  initial `topics`. An existing unrecognized companion is never adopted/overwritten.
- `topics`: upserts by stable ID. Each update supplies `id`, `title`, `status`,
  and optionally `dependsOn`/`evidence`. Omitted topics and omitted evidence/dependencies
  remain. Dependencies must reference known IDs and form a DAG; at most one topic
  is `current`.
- Statuses: `upcoming`, `current`, `completed`, `review`. A Completed topic requires
  an evidence description. The teacher judges demonstrated understanding; the
  extension never promotes topics automatically from quiz results.
- `nextStep`: a concrete action for the next lesson, not merely a broad goal.
- `sections: [{ topic: "id" }]`: start a major topic now. Revisits append new
  chronological sections with the same topic ID. Use `title` without `topic` for
  setup or non-roadmap discussion. Explanations and quizzes stay under the active
  topic; returning to an older branch can append a continuation without rolling
  back the current roadmap.
- For an explicitly requested backfill, a section's `before` is an exact
  24-character `pi-learn` message marker from the existing note. No message or quiz
  content is rewritten. Provide boundaries in chronological order.
- `rebuildProgressNote: true`: re-render only the companion from the existing
  authoritative state, with the current revision and no topic/section changes.
  Obtain permission before using this to recreate a deleted companion. It cannot
  replace an unrelated file or recreate the lesson log.

Checkpoint at conceptual milestones, **not after every message or correct answer**.
The TOC indexes actual section boundaries; the roadmap is a small dependency map
of the learning goal. See `skills/learn-teach/SKILL.md` for the teaching contract
and example arguments.

### Storage and safety

The versioned authoritative snapshot is stored in a hidden comment **inside the
log's generated TOC region**. The companion is only a derived view; there is no
competing JSON database or learning content in synced Pi configuration. State
survives fresh sessions; visiting an older session branch does not rewind it.
Stale revision updates fail and ask the teacher to read `learn_status` again.

Generated regions use `pi-learn-toc` and `pi-learn-goal` start/end comments. Topic
sections have `pi-learn-section` metadata. Keep those comments and generated
headings intact; put personal prose outside the generated regions. Source log
messages, quiz results, frontmatter, and manual prose remain intact.

All writes use Pi's file-mutation queues. A per-log `.learn-lock` additionally
coordinates cooperating Pi processes. A crash can leave this lock: remove it only
after confirming the owning process has stopped. Replacements are staged in the
same directory and checked against the latest content/inode; detected editor
saves cause a conflict rather than overwriting that edit. Ordinary prose still
appends. These checks are not an OS-level transaction with a noncooperating editor;
avoid editing generated regions while a checkpoint runs.

The two files are not an atomic pair: a filesystem failure between commits is
reported with the authoritative saved revision. Refresh an existing stale view at
the next checkpoint or request `rebuildProgressNote`; a missing view requires
explicit restoration/rebuild consent. Symlink replacement, configuration-directory
outputs, `.pi/plans`, Plan mode, and deleted source notes retain their protections.

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
