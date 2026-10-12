# Synthetic intended flow fixtures

CLI startup and queue-driven service examples used only in tests.

## Format

```toml
version = 1
```

## Flow Entities

```toml
[[entity]]
id = "cli"
name = "CLI application"
summary = "Parses command-line input and coordinates startup."
code_refs = ["src/cli.py::main"]

[[entity]]
id = "setup"
name = "Client setup"
summary = "Loads configuration and prepares a client."

[[entity]]
id = "service"
name = "Queue consumer"
summary = "Receives and schedules background work."

[[entity]]
id = "worker"
name = "Job processor"
summary = "Processes one background work item."
```

## Flow DataTypes

```toml
[[datatype]]
id = "arguments"
name = "CLI arguments"
summary = "Arguments supplied to the command."
fields = [{ name = "argv", type = "array<string>", required = true }]

[[datatype]]
id = "settings"
name = "Settings"
summary = "Resolved client configuration shape."
fields = [
  { name = "endpoint", type = "URI", required = true },
  { name = "timeout_ms", type = "integer", required = true },
]

[[datatype]]
id = "job"
name = "Work item"
summary = "Payload delivered to a background worker."
fields = [
  { name = "job_id", type = "string", required = true },
  { name = "payload", type = "object", required = true },
]
```

## Scenarios

```toml
[[scenario]]
id = "cli-startup"
title = "CLI startup and command"
description = "The CLI resolves configuration, then initializes its client."
entrypoint = true
inputs = [
  { name = "arguments", datatype = "arguments" },
  { name = "settings", datatype = "settings" },
]

[[scenario.participants]]
id = "terminal"
name = "User terminal"
kind = "external"

[[scenario.participants]]
id = "cli-process"
name = "CLI process"
kind = "runtime"
entity = "cli"

[[scenario.participants]]
id = "setup-instance"
name = "Startup helper"
kind = "runtime"
entity = "setup"

[[scenario.events]]
id = "invoke-cli"
title = "User invokes command"
participant = "terminal"
kind = "trigger"
contract = "arguments"
timing = "At process start"

[[scenario.events]]
id = "parse-options"
title = "Parse command options"
participant = "cli-process"
kind = "action"
contract = "arguments"

[[scenario.events]]
id = "scan-argument"
title = "Scan the next argument"
participant = "cli-process"
kind = "action"

[[scenario.events]]
id = "choose-settings"
title = "Choose settings source"
participant = "cli-process"
kind = "decision"

[[scenario.events]]
id = "load-settings"
title = "Load saved settings"
participant = "cli-process"
kind = "action"
contract = "settings"

[[scenario.events]]
id = "default-settings"
title = "Use default settings"
participant = "cli-process"
kind = "action"
contract = "settings"

[[scenario.events]]
id = "settings-join"
title = "Settings branches converge"
participant = "cli-process"
kind = "join"
contract = "settings"

[[scenario.events]]
id = "initialize-client"
title = "Initialize client"
participant = "setup-instance"
kind = "subflow"
subflow = "client-setup"
mode = "sync"
bindings = [{ direction = "in", source = "settings", target = "settings", datatype = "settings" }]

[[scenario.events]]
id = "command-ready"
title = "Continue to command"
participant = "cli-process"
kind = "return"

[[scenario.links]]
id = "cli-parse"
source = "invoke-cli"
target = "parse-options"
type = "receives"

[[scenario.links]]
id = "parse-scan"
source = "parse-options"
target = "scan-argument"
type = "causes"

[[scenario.links]]
id = "repeat-scan"
source = "scan-argument"
target = "scan-argument"
type = "repeats"
loop = true
guard = "while arguments remain"

[[scenario.links]]
id = "scan-settings"
source = "scan-argument"
target = "choose-settings"
type = "continues"
guard = "after argument scan"

[[scenario.links]]
id = "saved-branch"
source = "choose-settings"
target = "load-settings"
type = "branches"
guard = "saved settings exist"

[[scenario.links]]
id = "default-branch"
source = "choose-settings"
target = "default-settings"
type = "branches"
guard = "no saved settings"

[[scenario.links]]
id = "loaded-join"
source = "load-settings"
target = "settings-join"
type = "converges"

[[scenario.links]]
id = "default-join"
source = "default-settings"
target = "settings-join"
type = "converges"

[[scenario.links]]
id = "invoke-setup"
source = "settings-join"
target = "initialize-client"
type = "invokes"

[[scenario.links]]
id = "setup-return"
source = "initialize-client"
target = "command-ready"
type = "awaits"
timing = "After setup returns"

[[scenario]]
id = "client-setup"
title = "Synchronous client setup"
description = "A subflow consumes the caller's settings contract."
entrypoint = false
inputs = [{ name = "settings", datatype = "settings" }]

[[scenario.participants]]
id = "setup-runtime"
name = "Setup runtime"
kind = "runtime"
entity = "setup"

[[scenario.events]]
id = "read-settings"
title = "Read client settings"
participant = "setup-runtime"
kind = "action"
contract = "settings"

[[scenario.events]]
id = "client-ready"
title = "Client is ready"
participant = "setup-runtime"
kind = "return"

[[scenario.links]]
id = "settings-loaded"
source = "read-settings"
target = "client-ready"
type = "produces"

[[scenario]]
id = "queue-consumer"
title = "Queue-triggered service"
description = "An external queue trigger schedules background processing."
entrypoint = true
inputs = [{ name = "work_item", datatype = "job" }]

[[scenario.participants]]
id = "message-broker"
name = "Message broker"
kind = "external"

[[scenario.participants]]
id = "consumer-instance"
name = "Consumer instance"
kind = "runtime"
entity = "service"

[[scenario.events]]
id = "message-arrives"
title = "Work item arrives"
participant = "message-broker"
kind = "trigger"
contract = "job"
delivery = "At-least-once queue delivery"
timing = "On message availability"

[[scenario.events]]
id = "schedule-job"
title = "Schedule background job"
participant = "consumer-instance"
kind = "subflow"
subflow = "background-job"
mode = "async"
bindings = [{ direction = "in", source = "work_item", target = "job", datatype = "job" }]

[[scenario.events]]
id = "acknowledge"
title = "Acknowledge queue delivery"
participant = "consumer-instance"
kind = "action"
timing = "After enqueue"

[[scenario.links]]
id = "queue-schedules"
source = "message-arrives"
target = "schedule-job"
type = "schedules"
delivery = "Enqueue to worker"

[[scenario.links]]
id = "schedule-ack"
source = "schedule-job"
target = "acknowledge"
type = "continues"
timing = "Without waiting for job completion"

[[scenario]]
id = "background-job"
title = "Background job processing"
description = "One delivered item is processed by a runtime worker."
entrypoint = false
inputs = [{ name = "job", datatype = "job" }]

[[scenario.participants]]
id = "worker-instance"
name = "Worker instance"
kind = "runtime"
entity = "worker"

[[scenario.participants]]
id = "retry-worker"
name = "Retry worker instance"
kind = "runtime"
entity = "worker"

[[scenario.events]]
id = "accept-job"
title = "Accept work item"
participant = "worker-instance"
kind = "action"
contract = "job"

[[scenario.events]]
id = "check-inventory"
title = "Check inventory"
participant = "worker-instance"
kind = "subflow"
subflow = "inventory-query"
mode = "sync"
bindings = [{ direction = "in", source = "job", target = "job", datatype = "job" }]

[[scenario.events]]
id = "unknown-retry"
title = "Retry behavior is unexplored"
participant = "worker-instance"
kind = "gap"
open_question = "What retry policy applies after an inventory timeout?"

[[scenario.events]]
id = "finish-job"
title = "Finish processing"
participant = "retry-worker"
kind = "return"

[[scenario.links]]
id = "job-check"
source = "accept-job"
target = "check-inventory"
type = "requests"
timing = "During job handling"

[[scenario.links]]
id = "check-gap"
source = "check-inventory"
target = "unknown-retry"
type = "open-question"

[[scenario.links]]
id = "gap-finish"
source = "unknown-retry"
target = "finish-job"
type = "continues"

[[scenario]]
id = "inventory-query"
title = "Inventory query subflow"
description = "A nested synchronous request to the inventory boundary."
entrypoint = false
inputs = [{ name = "job", datatype = "job" }]

[[scenario.participants]]
id = "inventory-api"
name = "Inventory API"
kind = "external"

[[scenario.events]]
id = "send-query"
title = "Send inventory query"
participant = "inventory-api"
kind = "action"
contract = "job"
delivery = "Request/response"

[[scenario.events]]
id = "query-result"
title = "Return inventory result"
participant = "inventory-api"
kind = "return"

[[scenario.links]]
id = "query-result-link"
source = "send-query"
target = "query-result"
type = "returns"
```
