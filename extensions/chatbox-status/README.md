# chatbox-status

A personal status extension. It consumes the public mode and permissions snapshots, publishes a compact composer view-model for the existing `modes` editor, and records per-run model-generation time as a transcript annotation. It does not register commands or tools or make policy decisions; its only input handling is the questionnaire-scoped Escape suppression described below.

## Display

- The active plan title and bounded `## Goal` summary are centered in the composer's top border only when the plan is open, owned by this session, and the mode is Plan or Build.
- The lower composer border shows the current mode and compact permissions state (`permissions off`, or Jev/YOLO/threshold). Pi's native model/provider/thinking row is not duplicated.
- Each settled agent run gets a `Model time: … · outcome · model · thinking level · mode` custom session entry after its final assistant response. Model and thinking level come from the final assistant generation and are omitted when unavailable; the mode label is colored to match the composer and captured when the run starts. The entry is durable in the transcript and excluded from model context; its duration sums assistant-generation intervals and excludes tool execution and blocking user-prompt waits.
- While `ask_user_question` reports an active prompt, Escape is consumed so it cannot cancel the questionnaire; Ctrl+C remains available to cancel. Escape behavior in other dialogs is unchanged. This uses the prompt's `rpiv:ask-user:blocked` event and a session-scoped terminal-input listener.

The `modes` extension owns the single custom editor and renders the versioned composer view-model published on `chatbox-status:composer.v1`. Cross-extension payloads and runtime guards are defined in [`../shared/contracts.ts`](../shared/contracts.ts); display helpers live in [`../shared/composer-status.ts`](../shared/composer-status.ts). See [`../EXTENSION-CONVENTIONS.md`](../EXTENSION-CONVENTIONS.md) for event and consumer conventions.

Run the pure-state and contract tests with:

```sh
node --experimental-strip-types --test ../shared/tests/*.test.ts tests/*.test.ts
```
