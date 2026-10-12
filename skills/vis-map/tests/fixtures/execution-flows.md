# Synthetic execution-context fixture

A controller, two child processes, and a dynamic request-thread family. This is a test model, not repository guidance.

## Format

```toml
version = 2
```

## Flow Entities

```toml
[[entity]]
id = "controller"
name = "Controller"
summary = "Runs a supervisor loop."

[[entity]]
id = "state"
name = "State store"
summary = "An object synchronously called from multiple execution threads."

[[entity]]
id = "worker"
name = "Worker"
summary = "Child runtime with a main and control thread."
```

## Flow DataTypes

```toml
[[datatype]]
id = "settings"
name = "Settings"
summary = "Worker settings shape."
fields = [{ name = "endpoint", type = "string", required = true }]
```

## Scenarios

```toml
[[scenario]]
id = "supervisor"
title = "Supervisor loop and child startup"
entrypoint = true
inputs = [{ name = "settings", datatype = "settings" }]

[[scenario.processes]]
id = "parent"
name = "Supervisor process"
count = 1

[[scenario.processes]]
id = "child-a"
name = "Child A process"

[[scenario.processes]]
id = "child-b"
name = "Child B process"

[[scenario.threads]]
id = "main"
name = "Main thread"
process = "parent"
role = "main"
daemon = false

[[scenario.threads]]
id = "reconciler"
name = "Supervisor loop thread"
process = "parent"
daemon = true

[[scenario.threads]]
id = "control"
name = "Status reader thread"
process = "parent"
daemon = true

[[scenario.threads]]
id = "requests"
name = "HTTP request threads"
process = "parent"
count = "0..n"
daemon = true

[[scenario.threads]]
id = "child-main"
name = "Child A main thread"
process = "child-a"
role = "main"

[[scenario.threads]]
id = "child-control"
name = "Child A control thread"
process = "child-a"
daemon = true

[[scenario.threads]]
id = "second-main"
name = "Child B main thread"
process = "child-b"
role = "main"

[[scenario.threads]]
id = "second-control"
name = "Child B control thread"
process = "child-b"
daemon = true

[[scenario.participants]]
id = "launcher"
name = "Launcher"
kind = "external"

[[scenario.participants]]
id = "controller"
name = "Controller instance"
kind = "runtime"
entity = "controller"

[[scenario.participants]]
id = "store"
name = "State store instance"
kind = "runtime"
entity = "state"

[[scenario.participants]]
id = "worker"
name = "Child A instance"
kind = "runtime"
entity = "worker"

[[scenario.events]]
id = "invoke"
title = "Launch controller"
participant = "launcher"
kind = "trigger"

[[scenario.events]]
id = "main-entry"
title = "Enter main thread"
participant = "controller"
thread = "main"
kind = "start"

[[scenario.events]]
id = "construct"
title = "Construct the runtime"
participant = "controller"
thread = "main"
kind = "action"

[[scenario.events]]
id = "start-loop"
title = "Start supervisor loop thread"
participant = "controller"
thread = "main"
kind = "action"

[[scenario.events]]
id = "loop-entry"
title = "Enter supervisor thread"
participant = "controller"
thread = "reconciler"
kind = "start"

[[scenario.events]]
id = "check-stop"
title = "Stop requested?"
participant = "controller"
thread = "reconciler"
kind = "decision"

[[scenario.events]]
id = "stopped"
title = "Supervisor thread terminates"
participant = "controller"
thread = "reconciler"
kind = "terminate"

[[scenario.events]]
id = "snapshot"
title = "Read state through synchronous object call"
participant = "store"
thread = "reconciler"
kind = "action"

[[scenario.events]]
id = "diff"
title = "Is a child missing?"
participant = "controller"
thread = "reconciler"
kind = "decision"

[[scenario.events]]
id = "spawn-child"
title = "Create and start child process"
participant = "controller"
thread = "reconciler"
kind = "action"

[[scenario.events]]
id = "registered"
title = "Register child handle"
participant = "store"
thread = "reconciler"
kind = "action"

[[scenario.events]]
id = "matching"
title = "No process changes"
participant = "controller"
thread = "reconciler"
kind = "action"

[[scenario.events]]
id = "tick-complete"
title = "Continue independently of child readiness"
participant = "controller"
thread = "reconciler"
kind = "action"

[[scenario.events]]
id = "child-entry"
title = "Enter child process main thread"
participant = "worker"
thread = "child-main"
kind = "start"

[[scenario.events]]
id = "setup"
title = "Run synchronous setup subflow"
participant = "worker"
thread = "child-main"
kind = "subflow"
subflow = "child-setup"
mode = "sync"
bindings = [{ direction = "in", source = "settings", target = "settings", datatype = "settings" }]

[[scenario.events]]
id = "start-worker-control"
title = "Start child control thread"
participant = "worker"
thread = "child-main"
kind = "action"

[[scenario.events]]
id = "worker-control-entry"
title = "Enter child control thread"
participant = "worker"
thread = "child-control"
kind = "start"

[[scenario.events]]
id = "send-status"
title = "Send status heartbeat"
participant = "worker"
thread = "child-control"
kind = "action"

[[scenario.events]]
id = "control-entry"
title = "Enter status reader thread"
participant = "controller"
thread = "control"
kind = "start"

[[scenario.events]]
id = "read-status"
title = "Read status message"
participant = "controller"
thread = "control"
kind = "action"

[[scenario.events]]
id = "store-status"
title = "Update shared store in reader thread"
participant = "store"
thread = "control"
kind = "action"

[[scenario.events]]
id = "request-entry"
title = "Enter request-handler thread"
participant = "controller"
thread = "requests"
kind = "start"

[[scenario.events]]
id = "wake"
title = "Wake supervisor on request"
participant = "controller"
thread = "requests"
kind = "action"

[[scenario.links]]
id = "launch-main"
source = "invoke"
target = "main-entry"
type = "launches"
category = "spawn"

[[scenario.links]]
id = "main-construct"
source = "main-entry"
target = "construct"
type = "continues"
category = "sequence"

[[scenario.links]]
id = "construct-start"
source = "construct"
target = "start-loop"
type = "continues"
category = "sequence"

[[scenario.links]]
id = "start-thread"
source = "start-loop"
target = "loop-entry"
type = "starts-thread"
category = "spawn"

[[scenario.links]]
id = "loop-check"
source = "loop-entry"
target = "check-stop"
type = "begins-loop"
category = "sequence"

[[scenario.links]]
id = "stop-branch"
source = "check-stop"
target = "stopped"
type = "stops"
category = "sequence"
guard = "stop requested"

[[scenario.links]]
id = "running-branch"
source = "check-stop"
target = "snapshot"
type = "runs-tick"
category = "sequence"
guard = "still running"

[[scenario.links]]
id = "snapshot-diff"
source = "snapshot"
target = "diff"
type = "compares-state"
category = "sequence"

[[scenario.links]]
id = "missing-branch"
source = "diff"
target = "spawn-child"
type = "creates-worker"
category = "sequence"
guard = "child missing"

[[scenario.links]]
id = "matching-branch"
source = "diff"
target = "matching"
type = "no-change"
category = "sequence"
guard = "child already present"

[[scenario.links]]
id = "spawn-register"
source = "spawn-child"
target = "registered"
type = "records-handle"
category = "sequence"

[[scenario.links]]
id = "registered-complete"
source = "registered"
target = "tick-complete"
type = "continues"
category = "sequence"

[[scenario.links]]
id = "matching-complete"
source = "matching"
target = "tick-complete"
type = "continues"
category = "sequence"

[[scenario.links]]
id = "repeat-tick"
source = "tick-complete"
target = "check-stop"
type = "repeats"
category = "sequence"
loop = true
guard = "until stopped"

[[scenario.links]]
id = "spawn-process"
source = "spawn-child"
target = "child-entry"
type = "starts-child-process"
category = "spawn"

[[scenario.links]]
id = "child-setup"
source = "child-entry"
target = "setup"
type = "runs-setup"
category = "sequence"

[[scenario.links]]
id = "setup-control"
source = "setup"
target = "start-worker-control"
type = "continues-after-setup"
category = "sequence"

[[scenario.links]]
id = "spawn-control"
source = "start-worker-control"
target = "worker-control-entry"
type = "starts-control-thread"
category = "spawn"

[[scenario.links]]
id = "control-entry-status"
source = "control-entry"
target = "read-status"
type = "reads status messages"
category = "sequence"

[[scenario.links]]
id = "control-status"
source = "worker-control-entry"
target = "send-status"
type = "reports"
category = "sequence"

[[scenario.links]]
id = "status-message"
source = "send-status"
target = "read-status"
type = "status-pipe"
category = "message"

[[scenario.links]]
id = "reader-store"
source = "read-status"
target = "store-status"
type = "synchronous-update"
category = "sequence"

[[scenario.links]]
id = "request-start-wake"
source = "request-entry"
target = "wake"
type = "continues"
category = "sequence"

[[scenario.links]]
id = "request-wake"
source = "wake"
target = "snapshot"
type = "wakes-loop"
category = "signal"

[[scenario]]
id = "child-setup"
title = "Child setup detail"
entrypoint = false
inputs = [{ name = "settings", datatype = "settings" }]

[[scenario.processes]]
id = "child"
name = "Child process"

[[scenario.threads]]
id = "main"
name = "Child main thread"
process = "child"
role = "main"

[[scenario.participants]]
id = "worker"
name = "Worker instance"
kind = "runtime"
entity = "worker"

[[scenario.events]]
id = "child-setup-entry"
title = "Enter child setup thread"
participant = "worker"
thread = "main"
kind = "start"

[[scenario.events]]
id = "initialize"
title = "Initialize from settings"
participant = "worker"
thread = "main"
kind = "action"
contract = "settings"

[[scenario.events]]
id = "ready"
title = "Return to caller"
participant = "worker"
thread = "main"
kind = "return"

[[scenario.links]]
id = "initialize-entry"
source = "child-setup-entry"
target = "initialize"
type = "initializes"
category = "sequence"

[[scenario.links]]
id = "initialize-ready"
source = "initialize"
target = "ready"
type = "returns"
category = "sequence"
```
