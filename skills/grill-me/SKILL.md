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

## Work the tree in rounds

Ask the whole frontier in one round, then wait for the user's answers before asking
the next round. A question whose answer depends on another question still open in
this round belongs to a *later* round.

Ask questions as plain numbered text in your reply, in this shape:

```
❓ **Q1** - **<question title>**: <question body; may be several paragraphs, and
names the realistic choices>

➡️ <your recommended answer, and why>

---

❓ **Q2** - **<question title>**: ...
```

Do **not** call `ask_user_question`. A grilling answer is usually a paragraph of
reasoning, not a pick from a list, and the user must be able to answer the whole
round in one message.

Each round of answers reshapes the tree: settled decisions push the frontier
outward and unblock the questions that depended on them. Recompute the frontier and
ask the next round. If an answer is vague or evasive, put the sharper version of
that question in the next round.

## Find facts yourself

Never ask the user for something you can look up. Read the plan, the repository,
its `AGENTS.md`, and the relevant files with `read`, `grep`, `find`, `ls`, or
read-only `bash` before you ask. A running investigation is an unsettled
prerequisite, so only the questions downstream of it wait; ask the rest of the
frontier now. When the user has authorized delegation, subagents are a good way to
explore widely.

## Start and stop

- The plan may arrive as the command argument, from an attached plan file, or from
  the conversation. Gather it before the first round. If there is no plan, ask for
  one — never invent it.
- The session ends when the frontier is empty: every branch of the tree visited,
  nothing left silently assumed. Close by restating the settled decisions and the
  risks that remain, then ask the user to confirm shared understanding.
- If the user says stop, stop after the current round and restate the shared
  understanding so far.
- Do not act on the plan until the user confirms.
