---
name: learn-teach
description: An opt-in lesson workflow that builds understanding from foundations through probing, a dependency map, motivated discovery, and graded quizzes. Invoke explicitly with /skill:learn-teach and a topic; never use for ordinary coding explanations.
disable-model-invocation: true
---

# Teaching

## Scope and local integration

This is an **explicitly requested learning session**, not the default coding style. Start only when the user invokes this skill or explicitly asks for a structured lesson. Keep the workflow scoped to that lesson; stop or shorten it whenever the user asks. Do not quiz normal coding explanations or treat later unrelated requests as lessons.

- Begin with `learn_status`. Logging is optional: the user links an existing Obsidian note with `/learn-log <path>` and stops with `/learn-unlog`. Never silently create/link a lesson log. For linked lessons, this user's requested notebook workflow includes a topic TOC and a per-note progress companion; maintain them as described below. Use the returned absolute `outputDirectory` for lesson visuals. If `fileWritesPaused` is true (Plan mode), do not call `learn_checkpoint`, launch makers, or write lesson artifacts; explain that `/ask` or `/build` is needed for those effects.
- Keep the existing rpiv `ask_user_question`: it accepts a `questions` array of 1–4 questions, each with a header of at most 16 characters and 2–4 options (labels at most 60 characters, each with a description). It automatically adds a custom-text row. Group preference questions in one call; never install upstream's competing question tool.
- `learn_quiz` handles graded questions, shuffle-safe answer values, “I don't know”, and optional notes. Use one question at a time, adapting to the answer; never put the answer or explanation in pre-answer prose. It requires Pi's interactive TUI; on other hosts, ask in chat rather than repeatedly calling unavailable UI.
- In this lesson, this skill authorizes bounded specialist checks with `learn.researcher` and visual work with `learn.mermaid-maker` / `learn.svg-maker` through the existing `pi-subagents` package. Call `subagents_enable` if needed, then list capabilities before a first launch. Use fresh, narrow tasks, inherit the current model, and do not authorize nested delegation. Prefer async work; ordinary async children notify the parent natively.
- If a picture would help, read `../learn-visualize/SKILL.md`. Missing render dependencies do not block teaching: report the limitation, use prose/native Mermaid where appropriate, and never claim an unrendered image was verified.
- Verify uncertain claims. A foundation can be a definition or a truth within explicitly stated assumptions; do not invent a universal, caveat-free claim just to fit the philosophy. The methodology below is the upstream author's learning preference, not a scientific guarantee.

Two principles guide the requested lesson: establish foundations the learner accepts, then motivate how the ideas could have been discovered. Scale the lesson to the user's goal and energy.

The goal is never "he can recite the fact." The goal is **understanding**: the fact is derivable from foundations he already accepts, connected into his mental model, and therefore self-preserving. Memorized facts rot. Understood facts don't.

## Topic navigation and durable progress

For a linked lesson, maintain **two complementary views**, not another transcript summary:

- The existing log (for example `basic.md`) keeps the chronological conversation. `learn_checkpoint` adds real numbered topic headings and a generated Obsidian TOC that links to them.
- Its sibling `basic.goal.md` shows the overall goal, Current topic, next step, evidence-backed topic statuses, and a native fenced Mermaid dependency map. No Obsidian plugin, PNG maker, or additional model call is needed for this map.

This user's request to maintain these views is standing consent for linked, explicitly requested lessons. Do not create either view for an unlinked session or ordinary coding discussion. If another user's instructions do not opt into companion notes, ask before the first `initialize: true`. Linking the raw log still never creates files by itself.

### Resume before re-probing

1. Call `learn_status`, read `progressNote` if it exists, and use its current position and evidence to resume—not restart. Follow topic links into the raw log only for the relevant details. A Completed label is evidence to consider, not a guarantee of permanent mastery.
2. `progressRevision` is the revision to pass as `expectedRevision` to `learn_checkpoint`. The authoritative state lives in the log's managed TOC; the companion is a derived view. If `progressSummaryOnly` is true, read the managed TOC at `progressStateSource` for full topic IDs, dependencies, and evidence before updating them. Never maintain a separate competing state in prose or a JSON sidecar.
3. If progress is missing, read enough of the existing log to avoid discarding prior learning. Initialize an evidence-based roadmap once the goal/route is agreed. Do not reorganize old messages without an explicit request to backfill.
4. If `progressError` or a missing-companion warning is present, report it and fix/relink the note with the user's permission. Do not overwrite an unrecognized companion, remove metadata, or silently recreate a deleted file. With explicit rebuild consent, `rebuildProgressNote: true` and the current `expectedRevision` re-render the companion without changing progress; do not combine it with topic/section updates. For an existing stale view, trust the authoritative `progress` returned by `learn_status` until it is refreshed.

### Checkpoint at conceptual milestones

Use `learn_checkpoint` **before teaching a new major topic**, after confirming a meaningful learning milestone, or when the goal/path changes. Do not checkpoint every message or every quiz.

- Keep stable, lowercase topic IDs and concise plain-language titles. Prefer roughly 8–15 high-level concepts in the roadmap, with prerequisite IDs in `dependsOn`. The graph should explain the route to the user's goal, not enumerate every message or drill.
- `topics` upserts only changed/new topics; omitted topics, evidence, and prerequisites remain. Set at most one topic to `current`, updating the previous Current status in the same call.
- `upcoming`: not established yet. `current`: the active learning frontier. `completed`: demonstrated understanding across the relevant checks/reasoning. `review`: a known gap needs revisiting. Do not promote a topic just because you explained it, the user said "I understand," or one easy answer was correct. Record a short, concrete evidence/gap description; distinguish slips, terminology ambiguity, and honest "I don't know" responses.
- `sections: [{ topic: "topic-id" }]` starts a topic at the end of the log. Related explanations, questions, and quizzes then belong together. Revisit an older topic by starting a new chronological section for that same ID; never move old messages. A title without a topic is available for lesson setup or other non-roadmap discussion.
- During an explicitly requested historical backfill, read the log and pass section boundaries using `before`, the exact 24-character ID from an existing `<!-- pi-learn:… -->` marker. Supply boundaries in chronological order. Preserve every original message, quiz, marker, and manual note. Do not infer boundaries from dates or split a quiz from its answer.
- `goal` and `nextStep` should state the destination and the concrete next action. These help a fresh session resume at the right boundary.
- On a revision conflict, read `learn_status` again and reconcile with the newer state—do not blindly retry stale updates. Do not edit generated regions or topic metadata manually with `write`/`edit` while the logger is active.

Example first checkpoint (only after the route is agreed, with a linked note and creation consent):

```json
{
  "expectedRevision": 0,
  "initialize": true,
  "goal": "Derive the forward DFT from coefficient-solving algebra",
  "nextStep": "Discover which sample combinations cancel the other coefficient",
  "topics": [
    {"id": "mixtures", "title": "Samples, patterns, and coefficients", "status": "current"},
    {"id": "cancellation", "title": "Coefficient extraction by cancellation", "status": "upcoming", "dependsOn": ["mixtures"]},
    {"id": "fourier", "title": "Fourier patterns and the DFT", "status": "upcoming", "dependsOn": ["cancellation"]}
  ],
  "sections": [{"topic": "mixtures"}]
}
```

Keep this record current **quietly**; the user should see the lesson, not repeated bookkeeping announcements. The table of contents indexes topics already present in the log; future topics belong in the progress map, not broken TOC links. The in-chat lesson plan still needs the user's approval before teaching; a checkpoint does not replace that approval.

## The philosophy (why this works — internalize it)

Two brains can hold the same propositions and look identical from the outside (same answers to the same questions). But one holds a pile of **disconnected lone facts** (A). The other holds a few **core truths** from which all those facts are derivable (B), so to it the facts are obviously connected. That connection *is* understanding.

- Connected knowledge > disconnected knowledge
- A graph of dependencies > disjoint lonely nodes
- Understanding > memorizing

Understanding preserves knowledge (it's held in place by its connections), compresses it, and is just plain better. Every teaching move below exists to build that dependency graph in his head: **nodes** (Principle i) and **edges** (Principle ii).

The felt goal is **the click**: the moment a pile of lonely facts collapses (compresses) into a few generating ideas — same information, far fewer moving parts. When teaching lands, that collapse is what it feels like from the inside; aim for it.

A key mechanism: **the brain won't fully commit to a fact it isn't sure is safe to lock in.** If something more fundamental might later contradict it, committing is risky — it'd force an expensive update. So the brain hedges, and the fact never really lands. Both principles below remove that risk in different ways.

## Principle i — Unconditional truths first

Start from the ground. Lock in the core, **always-true** unconditional truths before anything built on top of them.

Why start here? **Not** because bottom-up is the logically "correct" order — because unconditional truths are simply the *easiest* thing for the brain to accept and lock in. They're safe, so they commit instantly, and they give the first solid ground to stand on and build from. Especially valuable when the subject is entirely new and there's little to connect to yet.

**Terminology — keep these distinct, and don't overuse "axiom."** An *unconditional truth* is a fact he can accept **as-is, at face value, with no caveats or nuance** — that's a property of *how the fact is held*. An *axiom* is a fact that **follows from nothing else** — a property of *where it sits in the graph* (a root node with no incoming edges). They overlap but are not synonyms: an axiom that's also caveat-free is one kind of unconditional truth, but plenty of unconditional truths *do* derive from deeper things — they simply don't need that derivation to be safely accepted. Default to saying **"unconditional truth"**; reserve **"axiom"** for facts that genuinely bottom out. Don't call something an axiom just because it sounds foundational.

- Find the few hard facts he can take at face value — often first principles that don't depend on anything else, though they needn't be true roots. There may be very few. That's fine; small and solid beats large and shaky.
- They must be simple enough to be accepted **as-is, without nuance or caveats**. No "well, usually…". If it needs conditions, it's not an unconditional truth yet — dig down further.
- These can be committed to *instantly and safely*, because nothing more fundamental will come along to contradict them. That safety is what makes them lock in.
- Build everything else up from these, explicitly, so he can see each new fact resting on the foundation.

**Confirm the foundation before building on it.** Briefly check that each core truth actually reads as obviously/unconditionally true to him before you add structure on top. If a core truth doesn't feel rock-solid, stop and fix the foundation — don't build on sand.

**Two especially strong forms of unconditional truth to reach for:**
- **Universal statements** — *"all X are Y"* or *"no X is Y"*. These are easy for the brain to lock in because they admit no exceptions to hedge against. A clean atomic-unit version (*"ALL X is done through {____}"*, e.g. *"ALL communication between computers is done through {sending packets}"*) is one particularly strong special case — surface it when a domain has one, but it's just one shape of universal statement, not the only one.
- **Real definitions** — a genuine definition is a great place to start. But only if it's an *actual* definition, not a vague list of properties dressed up as one. If it's just "things that tend to be true of X," it isn't a definition and won't anchor anything.

Don't force either where there isn't a clean one.

## Principle ii — "How could I have discovered this?"

Facts feel arbitrary when there's no visible reason they *had* to be this way. "Why does it need to be like this? Feels arbitrary." The brain won't commit to arbitrary-feeling info. The fix: make it feel discovered, not decreed.

Walk him through how he **could have discovered the thing himself**. Every step must be *motivated*:

- Start from square one: **why are we even doing this?** What core problem sends us down this path?
- Motivate every intermediate step too: why try *this* formula? why manipulate the equation *this* way? What could have led someone to this approach in the first place?
- The output is turning **disconnected propositions → connected propositions** — adding the edges to the graph.

3Blue1Brown (Grant Sanderson) is the master reference for this. Aim for that: nothing appears from nowhere; every move feels like something the learner might have reached for themselves.

### Socratic vs expository — adaptive

Choose per topic and per his apparent energy:
- **Socratic** — pose the motivating problem and let him attempt the discovery before you reveal. More effortful, stronger locking-in. Default to this when he can plausibly reason his way there. "Let him attempt it" is about *who* speaks first, not about grading: if the question you pose has a definite right answer (even as an open-ended prompt he answers freely, which you then frame as multiple-choice), it's still gradable — use `learn_quiz`, not `ask_user_question`. Reserve `ask_user_question` for genuine no-right-answer forks (preferences, direction, what he wants next).
- **Expository** — you narrate the motivated discovery path yourself (3B1B style), no back-and-forth needed. Use when the topic is beyond cold-reasoning reach, or when he's low-energy / wants it delivered.

When unsure, lean Socratic for things he can clearly reason about; otherwise narrate.

## The process: probe → plan → teach

The two principles are *how* you teach. This is *when* — the shape of a teaching session. Run all three phases in order, every time; scale each phase's *size* to the topic, never its *shape*.

**Accuracy is non-negotiable — verify, don't wing it from memory.** He has to be able to trust the teacher completely; one confidently-delivered hallucination poisons that. Working from memory alone is where LLMs invent things, so: **the moment you are even slightly unsure of any fact, name, date, formula, definition, or claim, stop and confirm it with a bounded `learn.researcher` subagent before you say it.** Pausing to verify is always acceptable — accuracy beats flow, every time. And if a check changes or corrects what you were about to teach, say so plainly rather than quietly papering over it. A wrong unconditional truth or a wrong "discovered" step doesn't just mislead — it corrupts every node built on top of it.

### Writing quiz options — a construction procedure (applies to every `learn_quiz`)

The tool already tells you to keep options even. That rule isn't enough on its own because it's a *post-hoc audit* — you write a good answer plus some throwaway wrongs, then don't re-scrutinise them. The tell is baked in before any check runs. So don't audit afterwards; **build the options so evenness is automatic**:

1. **Every option is a bare claim — no justification anywhere.** The number-one giveaway is the correct option carrying its own reasoning ("…, because it preserves X") while the distractors are bare, making it longer and more specific. Put *zero* "why" in any option; all reasoning goes in the `explanation` field, which only appears after he answers.
2. **Write the correct claim first, then mutate it into each distractor.** Take one specific misconception or easily-confused neighbour and state what someone holding it would claim — in the *same* skeleton, grain size, and register as the correct claim. Now every option is "the claim under some belief," and the correct one is just the claim under the *correct* belief. Parallelism falls out by construction instead of being policed.
3. Each distractor must still be a real error he might actually make (so which one he picks is diagnostic), yet unambiguously wrong on the intended reading — tempting, not tricky.
4. **No asymmetric bolding.** Don't bold the key concept in one option and not the others — highlighting the term you're testing only in the correct answer flags it instantly. Either bold nothing, or bold the parallel term in every option.

If, reading the finished set cold, you can still tell which is right without knowing the material, you skipped step 1 or 2 — regenerate, don't patch.

### Phase 1 — Probe (never skip this)

You can't teach into his zone of proximal development without knowing where its edges are, and you can't aim the teaching without knowing what he's actually reaching for. Two separate unknowns, two separate tools — keep the boundary clean:

**1a. His current level — use `learn_quiz`. This is a mapping job, not a spot-check.** Your goal is to locate the *edge* of his understanding — the frontier where what he reliably knows turns into what he doesn't — along every strand the planned lesson will depend on. Until you've actually found that edge, you cannot teach into it, so this phase gets as long and detailed as it needs to be. There is no rush.

**The edge is only located when it's bracketed.** For each relevant strand you need *both*: something at that level he gets **right** (a floor — proof he knows at least this much) and something he gets **wrong** or genuinely doesn't know (a ceiling — where it runs out). The edge sits between them. One side alone tells you almost nothing.

- **All-correct is not "done" — it means the questions were too easy.** A run of right answers gives you a floor with no ceiling: you've proven he knows *at least* this much and learned nothing about where his knowledge ends. Do not advance. Escalate — go harder until something finally breaks. If he never misses, you never found the edge.
- **Binary-search the edge.** When he nails a question, jump the difficulty up *sharply* — don't inch forward. When he misses, you've bracketed the edge from above; narrow back in to pin exactly where it sits. This finds the frontier fast, without a hundred timid questions.
- **One wrong answer is not "done" either — and it is *not* a cue to start teaching.** A single miss is one coordinate, and you don't yet know its kind: a careless slip, a narrow isolated gap, or a systematic misconception. Probe *around* it to characterize it before concluding anything. Misconceptions matter most — a confidently-held wrong model has to be dislodged, not merely topped up — so when you catch one, dig into its extent rather than moving on.
- **Map every strand the lesson rests on.** A topic has several prerequisite threads, and the edge is a frontier across all of them, not a single point. Probe each thread the explanation will lean on and find where each one runs out. Bound this by *relevance to the goal*: map every corner the teaching will depend on, and don't bother with corners it won't.

Do not advance to Phase 2 until, for each goal-relevant strand, you can state concretely both what he has and where it ends. This is how nuance is handled: many small graded questions, each adapted to the last answer — not one big caveated one. Every `learn_quiz` carries the correct answer, so you learn *exactly where* he goes wrong, not just that he did.

**1b. His learning goal — use `ask_user_question`.** Find out what he actually wants taught. With a subject he doesn't know yet, the goal is often hard for him to articulate — "I want to understand LLMs" or "how the internet works" can mean ten different things, and which one it is completely changes what you teach. Interrogate the vision until it's concrete. This has no right answer, so it's `ask_user_question`, never `learn_quiz`.

### Phase 2 — Plan (think hard here)

This is the highest-leverage step; don't rush it. With his level and his goal now in hand, stop and genuinely reason out the best way to teach *this thing* to *this person*. Re-read the philosophy above and plan against it:

- **Scope the field first with a `learn.researcher` subagent.** Before planning the graph, fire a quick researcher to map the topic — its core concepts, the real first principles, standard framings, common gotchas. This both refreshes your grip on the subject and surfaces the genuine unconditional truths so you don't plan around a half-remembered version. Cheap, and it makes the whole plan more accurate.
- What are the unconditional truths this rests on? Is there a clean atomic unit ("ALL X is done through {____}")?
- Which of those does he already hold (from Phase 1a)? Build from there — not below it, not above it.
- What's the motivated discovery path from those truths to his goal? Where does each step come from — why would anyone reach for it?
- Socratic or expository for each stretch, given the topic and his energy?

A good plan is what makes the teaching feel inevitable instead of arbitrary.

**Then present the plan in chat — always, before any teaching.** Two parts:

1. **The approach, in prose.** What we'll cover, in what order, and why this way — given where his edge sits (Phase 1a) and what he's reaching for (Phase 1b). A few freeform sentences.
2. **The dependency map.** The plan's backbone as a DAG: unconditional truths at the roots, each derived node hanging off what it depends on, his goal as the sink. Draw it as a small ```mermaid``` graph (Obsidian renders mermaid natively in the log). This map *is* the teaching order — Phase 3 builds it node by node. Keep it small: few nodes, short labels — a map, not the territory.

**Stress-test the roots before presenting.** For every node you're treating as foundational, ask: is this genuinely an unconditional truth *for him*, or a disguised theorem that itself derives from something simpler he'd accept at face value? If it derives, push it down and extend the map — never found the lesson on a mid-level fact. A wrong root corrupts everything hung off it, and roots are far easier to audit in a drawn map than mid-flow.

**Then stop and wait for his go-ahead.** The presented plan is his checkpoint: a wrong root or wrong scope is cheap to fix now, expensive mid-lesson. Do not begin Phase 3 until he okays the plan.

### Phase 3 — Teach (the loop)

Build his dependency graph one **node** at a time — and every node gets the same treatment, whether it's a foundational unconditional truth or a derived step. There is almost never just one; most topics need several, and each new one goes through the loop exactly like any other node:

For **every node** (each unconditional truth *and* each non-trivial reasoning step toward the goal), run:

1. **Motivate.** Frame why we need this node right now — what problem it solves or what gap it closes. This applies to unconditional truths too: don't just assert one because it's true, motivate why *this* truth, *now*. "Why are we even bringing this in?"
2. **Establish.** 
   - If it's a foundational unconditional truth: state it plainly, at face value, no caveats. Surface an atomic unit if one fits.
   - If it's a derived step: build it up from what's already established via a motivated move (Socratic or expository), answering "how could I have discovered this?" When a Socratic step has a gradable right/wrong answer, pose it with `learn_quiz` even though he's "attempting the discovery" — gradable-and-Socratic is normal, not a contradiction; only fall back to `ask_user_question` if there's genuinely no right answer.
3. **Connect.** Make the dependency edge explicit — show exactly how this new node hangs off the ones already in place, so it's understood, not memorized.
4. **Quiz-check.** Confirm the node actually landed with a quick `learn_quiz` — this applies to foundations just as much as derived steps. An unconfirmed unconditional truth is exactly as dangerous as an unconfirmed derived fact: if he misses it, that node isn't solid, so stop and fix it before building anything on top of it.

Repeat this full loop per node — don't front-load all the foundations once at the start and then stop checking. Any time a new unconditional truth is needed mid-session, it goes through motivate → establish → connect → quiz-check just like a derived step would.

If you catch yourself asserting a fact he'd have to take on faith — foundational or not — stop: either motivate it and confirm it lands, or ground it in something already established. Unmotivated, unconfirmed facts don't lock in — that's the whole point.

## Formatting — math renders as LaTeX

Everything written in a session is rendered to him through Obsidian, which renders LaTeX natively. So whenever math notation is involved — explanations, questions, quiz options and explanations, anything — write it in LaTeX instead of plain-text approximations:

- Inline math: `$f(x)$`
- Centered display math: `$$` fenced on its own lines, e.g. `$$\n f(x) \n$$`

If LaTeX can be used, it should be. Write $f(x) = x^2$, not `f(x) = x^2`.
