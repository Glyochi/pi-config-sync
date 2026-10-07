---
name: grill-me
description: Interview the user relentlessly about a plan or design until you reach shared understanding, resolving every branch of the decision tree. Use when the user wants to stress-test a plan or design, get grilled on their thinking, or says "grill me".
---

# Grill me

Interview the user relentlessly until you share an understanding of the plan. This
skill produces an interview and nothing else: do not edit files, run the plan, or
write a summary document while it is running.

## The design tree

Map the plan as a **design tree**: every decision branches into the decisions that
hang off it. The decisions are the user's to make; the facts are yours to find.

The **frontier** is every decision whose prerequisites are already settled — the
questions you can ask *now* without guessing at answers you have not heard yet.

Work the whole frontier out before you ask anything, and keep it as an ordered queue
of the questions you intend to ask. Every answer reshapes that queue: it settles
decisions, unblocks the questions that depended on them, and can retire questions
that no longer apply. Recompute the queue after each answer.

## Ask one question at a time

Ask exactly one question, then end your turn and wait for the answer. Never print
questions you have not asked yet, and never ask a second question in the same
message. Saying where the question sits in the queue ("Q3 of roughly 8") is fine;
the queue itself stays yours.

## Choose how to ask

Pick the form that fits the question:

- **`ask_user_question`** when the realistic answers are a short list of discrete
  choices. Put your recommendation first and label it `(Recommended)`, and let each
  option's description carry its trade-off. The tool allows 2-4 options; a question
  that needs more is really two questions. Never render a choice list as flat text —
  if the answer is a pick from a list, it belongs in the tool. If the tool reports
  that no UI is available (non-interactive runs), ask that same question in prose
  instead of dropping it.
- **Plain prose** when the answer is reasoning, a description, or anything that does
  not reduce to a few options:

  ```
  ❓ **<question title>**: <question body; may be several paragraphs>

  ➡️ <your recommended answer, and why>
  ```

Both forms end the turn. Wait for the answer either way.

## Find facts yourself

Never ask the user for something you can look up. Read the plan, the repository,
its `AGENTS.md`, and the relevant files with `read`, `grep`, `find`, `ls`, or
read-only `bash` before you ask. A running investigation is an unsettled
prerequisite, so only the questions downstream of it wait; ask the rest of the queue
now. When the user has authorized delegation, subagents are a good way to explore
widely.

## Start and stop

- The plan may arrive as the command argument, from an attached plan file, or from
  the conversation. Gather it before the first question. If there is no plan, ask
  for one — never invent it.
- The session ends when the frontier is empty: every branch of the tree visited,
  nothing left silently assumed. Close by restating the settled decisions and the
  risks that remain, then ask the user to confirm shared understanding.
- If the user says stop, stop and restate the shared understanding so far.
- Do not act on the plan until the user confirms.
