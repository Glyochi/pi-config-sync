# Pi question tool rationale

Why `ask_user_question` is the only question tool in this setup. This document is
tracked by pi-config-sync (`git-sync.jsonc` -> `extraPaths`) so the reasoning
travels with the config to every machine.

Tool: `ask_user_question` from `@juicesharp/rpiv-ask-user-question`
(`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question`)

## The model

**One question tool: rpiv's `ask_user_question`. `Ctrl+]` collapses its overlay.**

## Why

Three tools that all ask the user a question used to be installed at once:

| Tool | Source | Rendering |
| --- | --- | --- |
| `ask_user_question` | `@juicesharp/rpiv-ask-user-question` | `ctx.ui.custom` overlay anchored bottom-center, with a `Ctrl+]` collapse/expand key |
| `questionnaire` | `@firstpick/pi-package-questionnaire`, bundled and auto-registered by `@firstpick/pi-extension-grill-me` | `ctx.ui.select()` |
| `question` | `@janvitos/pi-plan-build` | `ctx.ui.select()` |

`ctx.ui.select()` clears pi's editor container and mounts a content-sized
`ExtensionSelectorComponent` in the editor slot at the bottom of the screen. It has
no height cap, no scrolling, and no collapse key, and it takes focus, so the
transcript above cannot be scrolled while it is up. Its height follows the wrapped
question prompt, and grill-me asks the model to put the recommendation *and its
reason* in that prompt, so on a short pane the box covered the latest model
response with no way back.

The duplication was also a coin flip for the model: in session `01a11398` the same
turn used `ask_user_question` on the first attempt and `questionnaire` on the
retry, while `/grill-me` forced `questionnaire` by protocol.

rpiv's dialog has the same bottom-anchored footprint but is escapable: press
`Ctrl+]` to hide it and read or scroll the transcript, then `Ctrl+]` again to bring
it back with the answers you had entered intact. The key is configurable via
`collapseKey` in `~/.config/rpiv-ask-user-question/config.json` (default
`ctrl+]`), which is outside the agent dir and therefore **not** synced by
pi-config-sync.

## How the other two are disabled

- `@firstpick/pi-extension-grill-me` is no longer in `settings.json` `packages`.
  Removing it also removes `questionnaire`, the `grill_record_turn` /
  `grill_record_turns` / `grill_save_results` tools, and the `/grill-me` command.
- `pi-plan-build.json` sets `"questionTool": false`. Plan-build's default is `true`,
  and its `applyTools` re-adds `question` on every mode refresh, so
  `defaultTools: ["-question"]` in `settings.json` would not stick — this file is
  the only lever.

## Do not reintroduce

Installing `npm:@firstpick/pi-extension-grill-me` again reinstates the bundled
`questionnaire` tool and the non-collapsible box. If the `/grill-me` workflow is
wanted back, either accept that box or give grill-me a `questionnaire` tool that
renders like rpiv's — rpiv caps a call at 4 questions and 2-4 options per question,
so grill-me's larger batches would have to be split and merged.

Changing either `settings.json` `packages` or `pi-plan-build.json` requires a pi
restart; `/reload` cannot unregister a tool.
