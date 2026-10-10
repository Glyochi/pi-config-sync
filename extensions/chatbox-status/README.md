# chatbox-status

A personal Pi extension that renders a passive status widget above the editor. It consumes Pi lifecycle events and the public mode/permission state events; it does not register commands or tools and does not modify policy/session state.

The widget shows:

- Current Ask/Plan/Build mode.
- The title and bounded `## Goal` summary for an open plan owned by this session while in Plan or Build mode.
- The sum of assistant-generation intervals for the current/last agent run. It advances only during assistant message generation and freezes with the completed, aborted, or error outcome.
- Permission switches, threshold, Jev model, and classification count, or `permissions off` when the overall policy gate is disabled.

Cross-extension payloads and runtime guards are defined in [`../shared/contracts.ts`](../shared/contracts.ts). See [`../EXTENSION-CONVENTIONS.md`](../EXTENSION-CONVENTIONS.md) for the event and consumer conventions.

Run the pure-state tests with:

```sh
node --experimental-strip-types --test tests/*.test.ts
```
