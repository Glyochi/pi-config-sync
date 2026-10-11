#!/usr/bin/env python3
"""Regression smoke test for modes events during a session resume/switch."""

import json
import os
import pathlib
import queue
import shutil
import subprocess
import tempfile
import threading
import time


def session_file(path: pathlib.Path, session_id: str, cwd: pathlib.Path, mode: str) -> None:
    entries = [
        {
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": "2026-10-11T05:00:00.000Z",
            "cwd": str(cwd),
        },
        {
            "type": "custom",
            "id": f"mode-{session_id}",
            "parentId": None,
            "timestamp": "2026-10-11T05:00:01.000Z",
            "customType": "modes-state",
            "data": {"version": 1, "mode": mode},
        },
    ]
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")


def main() -> int:
    pi = shutil.which("pi")
    if not pi:
        raise SystemExit("pi executable not found")

    test_dir = pathlib.Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="pi-session-replacement-") as temp:
        root = pathlib.Path(temp) / "project"
        sessions = pathlib.Path(temp) / "sessions"
        root.mkdir()
        sessions.mkdir()
        source = sessions / "source.jsonl"
        target = sessions / "target.jsonl"
        source_id = "01a1297b-0000-7000-8000-000000000001"
        target_id = "01a1297b-0000-7000-8000-000000000002"
        session_file(source, source_id, root, "plan")
        session_file(target, target_id, root, "build")

        env = os.environ.copy()
        env["PI_REPLACEMENT_TEST_TARGET"] = str(target)
        command = [
            pi,
            "--mode", "rpc",
            "--session", str(source),
            "--session-dir", str(sessions),
            "--extension", str(test_dir / "session-replacement-extension.ts"),
            "--offline",
            "--no-themes",
            "--no-context-files",
        ]
        process = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        output_queue: queue.Queue[str | None] = queue.Queue()
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        def drain(stream: object, sink: list[str], output: queue.Queue[str | None] | None = None) -> None:
            for line in stream:  # type: ignore[attr-defined]
                value = line.rstrip()
                sink.append(value)
                if output is not None:
                    output.put(value)
            if output is not None:
                output.put(None)

        stdout_reader = threading.Thread(target=drain, args=(process.stdout, stdout_lines, output_queue), daemon=True)
        stderr_reader = threading.Thread(target=drain, args=(process.stderr, stderr_lines), daemon=True)
        stdout_reader.start()
        stderr_reader.start()

        def send(record: dict[str, object]) -> None:
            assert process.stdin is not None
            process.stdin.write(json.dumps(record) + "\n")
            process.stdin.flush()

        def response(request_id: str, timeout: float = 30) -> dict[str, object]:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    line = output_queue.get(timeout=min(0.25, deadline - time.monotonic()))
                except queue.Empty:
                    if process.poll() is not None:
                        break
                    continue
                if line is None:
                    break
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") == "response" and record.get("id") == request_id:
                    return record
            raise AssertionError(f"timed out waiting for {request_id}; output:\n" + "\n".join(stdout_lines[-30:]))

        try:
            send({"id": "before", "type": "get_state"})
            before = response("before")
            assert before.get("data", {}).get("sessionId") == source_id, before

            send({"id": "resume", "type": "prompt", "message": "/test-resume-target"})
            resumed = response("resume")
            assert resumed.get("success") is True and resumed.get("data", {}).get("disposition") == "handled", resumed

            send({"id": "after", "type": "get_state"})
            after = response("after")
            assert after.get("data", {}).get("sessionId") == target_id, after

            # Make another mode transition after replacement to ensure the new
            # session's extension listeners remain live and current.
            send({"id": "mode", "type": "prompt", "message": "/plan"})
            mode = response("mode")
            assert mode.get("success") is True and mode.get("data", {}).get("disposition") == "handled", mode
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            stdout_reader.join(timeout=5)
            stderr_reader.join(timeout=5)

        combined = "\n".join(stdout_lines) + "\n" + "\n".join(stderr_lines)
        assert "Event handler error (modes:state.v1)" not in combined, combined
        assert "stale after session replacement" not in combined, combined

    print("ok: session replacement publishes and consumes mode state without stale contexts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
