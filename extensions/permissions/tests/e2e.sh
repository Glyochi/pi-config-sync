#!/usr/bin/env bash
#
# End-to-end probes for the permissions policy layer.
#
# Each probe runs a real headless pi session, so it needs working credentials and
# spends one model call each, plus one classifier call when Jev is on and the tool
# is effectful.
#
# The probes deliberately use commands a driving model will actually issue. Anything
# whose point is destructive (`rm -rf /usr/...`, `cat ~/.git-credentials`) measures
# the model, not the gate: it either refuses or quietly substitutes a read. Those
# verdicts are asserted deterministically in lib.test.ts instead.
#
# The Jev/YOLO switch matrix is exercised by pointing the extension at a temp config
# with PI_PERMISSIONS_CONFIG_PATH, so the real permissions.jsonc is never touched.
#
# Run:      bash ~/.pi/agent/extensions/permissions/tests/e2e.sh
# Options:  PROBE_TIMEOUT=600              per-probe timeout in seconds
#           PI_E2E_MODEL=opencode/...     pin the model driving the session

set -Eeuo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASSED=0
FAILED=0
INCONCLUSIVE=0

PI_ARGS=()
if [[ -n "${PI_E2E_MODEL:-}" ]]; then
	PI_ARGS=(--model "$PI_E2E_MODEL")
fi

# Temp policies for the switch matrix; the real file is never modified.
printf '%s\n' '{"jev":{"enabled":true},"yolo":false}' >"$TMP_DIR/jev-on.jsonc"
printf '%s\n' '{"jev":{"enabled":false},"yolo":true}' >"$TMP_DIR/yolo-on.jsonc"

# A session that already carries the independent learning-modes state entry, so the
# permission extension exercises the same persisted mode contract as TUI/RPC sessions.
cat >"$TMP_DIR/plan-session.jsonl" <<'JSON'
{"type":"session","version":3,"id":"01a1146a-0000-7000-8000-0000000000aa","timestamp":"2026-10-07T14:00:00.000Z","cwd":"/workspace"}
{"type":"custom","id":"p1","parentId":null,"timestamp":"2026-10-07T14:00:01.000Z","customType":"learning-modes-state","data":{"version":1,"mode":"plan"}}
JSON

# Print the text of every tool result in a `pi --mode json` transcript.
extract_results() {
	python3 -c '
import json, sys
out = []
def walk(node):
    if isinstance(node, dict):
        if isinstance(node.get("result"), dict) and isinstance(node.get("toolName"), str):
            for block in node["result"].get("content", []):
                if isinstance(block, dict) and block.get("type") == "text":
                    out.append(block.get("text", ""))
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        walk(json.loads(line))
    except Exception:
        pass
print("\n".join(out))
' "$1"
}

# Usage rides on the tool result only when the classifier actually ran.
has_cost() {
	grep -q '"result":{.*"cost"' "$1"
}

run_pi() {
	local out="$1" command="$2" extra="${3:-}" config="${4:-}"
	local env_prefix=() session_flags=(--no-session)
	[[ -n "$config" ]] && env_prefix=(env "PI_PERMISSIONS_CONFIG_PATH=$config")
	[[ "$extra" == *"--session"* ]] && session_flags=()
	# shellcheck disable=SC2086  # extra holds whole flag words on purpose
	timeout "${PROBE_TIMEOUT:-300}" "${env_prefix[@]}" pi -p --mode json "${session_flags[@]}" "${PI_ARGS[@]}" $extra \
		"Use the bash tool to run exactly this command and nothing else, then reply done. Do not skip the tool call: $command" \
		>"$out" 2>&1
}

# check <name> <transcript> <present|absent> <substring> <cost: yes|no>
check() {
	local name="$1" out="$2" mode="$3" expect="$4" wantCost="$5" result
	result="$(extract_results "$out")"
	if [[ -z "$result" ]]; then
		echo "INCONCLUSIVE  [the model did not call a tool; re-run or pin PI_E2E_MODEL]"
		INCONCLUSIVE=$((INCONCLUSIVE + 1))
		return
	fi
	local found=no
	[[ "$result" == *"$expect"* ]] && found=yes
	if [[ "$mode" == "present" && "$found" == "no" ]]; then
		echo "FAIL  (expected to find \"$expect\"; transcript: $out)"
		echo "        got: $(printf '%s' "$result" | head -c 200)"
		FAILED=$((FAILED + 1))
		return
	fi
	if [[ "$mode" == "absent" && "$found" == "yes" ]]; then
		echo "FAIL  (expected NOT to find \"$expect\"; transcript: $out)"
		FAILED=$((FAILED + 1))
		return
	fi
	# A classifier call shows up either as usage on the result, when the action ran,
	# or as a Jev block reason, when it did not. A blocked call never reaches
	# tool_result, so its cost is deliberately uncounted.
	if [[ "$wantCost" == "consulted" ]]; then
		if ! has_cost "$out" && [[ "$result" != *"Jev"* ]]; then
			echo "FAIL  (the classifier does not appear to have run; transcript: $out)"
			echo "        got: $(printf '%s' "$result" | head -c 200)"
			FAILED=$((FAILED + 1))
			return
		fi
	fi
	if [[ "$wantCost" == "yes" ]] && ! has_cost "$out"; then
		echo "FAIL  (expected the classifier to run; no usage on the result)"
		FAILED=$((FAILED + 1))
		return
	fi
	if [[ "$wantCost" == "no" ]] && has_cost "$out"; then
		echo "FAIL  (expected no classifier call; usage present on the result)"
		FAILED=$((FAILED + 1))
		return
	fi
	echo "PASS  [classified: $wantCost]"
	PASSED=$((PASSED + 1))
}

# probe <name> <command> <present|absent> <substring> <cost> [extra flags] [config]
probe() {
	local name="$1" command="$2" mode="$3" expect="$4" wantCost="$5" extra="${6:-}" config="${7:-}"
	local out="$TMP_DIR/$name.jsonl" rc=0
	printf '  %-26s ' "$name"
	run_pi "$out" "$command" "$extra" "$config" || rc=$?
	if ((rc != 0)); then
		echo "FAIL  (pi exited $rc; transcript: $out)"
		FAILED=$((FAILED + 1))
		return
	fi
	check "$name" "$out" "$mode" "$expect" "$wantCost"
}

echo "permissions end-to-end probes"
echo "  each probe runs a real pi session: one model call, plus one classifier call when effectful and Jev is on"
echo

# The deterministic fast path: a single command and a compound one cost nothing, with
# Jev on or off, unless the command hides its intent.
probe simple-not-classified "echo probe-ok" present "probe-ok" no
probe benign-chain-jevv-off "echo a && echo b" present "b" no
# With Jev on, a benign chain is still free: structure is not a reason to classify.
probe benign-chain-jevv-on "echo a && echo b" present "b" no "" "$TMP_DIR/jev-on.jsonc"
# An external-effect verb is caught by the globs whether or not it is chained, so the
# classifier is not needed for it either.
probe chained-external-effect "git push origin main && echo done" present "a bash rule requires approval" no
# A destructive command whose targets are specific paths inside the working
# directories is decidable, so an ordinary delete costs no classifier call even with
# Jev on. A target outside them still reaches the classifier.
probe delete-in-working-dir "rm -rf /tmp/permissions-probe" absent "Jev" no "" "$TMP_DIR/jev-on.jsonc"
probe delete-outside-working-dir "rm -rf /srv/permissions-probe" any "" consulted "" "$TMP_DIR/jev-on.jsonc"
probe destructive-jevv-off "rm -rf /tmp/permissions-probe" absent "Jev" no

# Hard block: a bare-word credential pattern on a command a model will run.
# `echo token` is deliberately innocuous, because anything that looks like a real
# credential makes the driving model refuse and the probe measures the model.
probe hard-block "echo token" present "permissions credential gate" no
probe yolo-disables-blocks "echo token" absent "permissions credential gate" no "" "$TMP_DIR/yolo-on.jsonc"

# Mode dimension, driven from a session that already carries the plan state entry.
probe plan-blocks-mutation "echo a && echo b" present "Plan mode is read-only" no "--session $TMP_DIR/plan-session.jsonl"
probe plan-allows-read "ls -la /workspace" present "AGENTS.md" no "--session $TMP_DIR/plan-session.jsonl"

echo
echo "asserted: $PASSED passed, $FAILED failed, $INCONCLUSIVE inconclusive"
if ((FAILED > 0)); then
	echo "FAIL"
	exit 1
fi
if ((INCONCLUSIVE > 0)); then
	echo "INCONCLUSIVE: $INCONCLUSIVE assertion(s) never ran"
	exit 1
fi
echo "ok"
