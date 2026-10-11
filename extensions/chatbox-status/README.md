# chatbox-status

A personal, passive status extension. It consumes the public mode and permissions snapshots, publishes a compact composer view-model for the existing `modes` editor, and records per-run model-generation time as a transcript annotation. It does not register commands or tools or make policy decisions.

## Display

- The active plan title and bounded `## Goal` summary are centered in the composer's top border only when the plan is open, owned by this session, and the mode is Plan or Build.
- The lower composer border shows the current mode and compact permissions state (`permissions off`, or Jev/YOLO/threshold). Pi's native model/provider/thinking row is not duplicated.
- Each settled agent run gets a `Model time: … · outcome · mode` custom session entry after its final assistant response. The mode label is colored to match the composer, and is captured when the run starts. The entry is durable in the transcript and excluded from model context; its duration sums assistant-generation intervals and excludes tool execution and blocking user-prompt waits.

The `modes` extension owns the single custom editor and renders the versioned composer view-model published on `chatbox-status:composer.v1`. Cross-extension payloads and runtime guards are defined in [`../shared/contracts.ts`](../shared/contracts.ts); display helpers live in [`../shared/composer-status.ts`](../shared/composer-status.ts). See [`../EXTENSION-CONVENTIONS.md`](../EXTENSION-CONVENTIONS.md) for event and consumer conventions.

Run the pure-state and contract tests with:

```sh
node --experimental-strip-types --test ../shared/tests/*.test.ts tests/*.test.ts
```
