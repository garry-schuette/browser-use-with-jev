import asyncio
import base64
import json

import pytest
from browser_use.llm.messages import UserMessage
from jsonschema import ValidationError
from pydantic import BaseModel

from browser_use_with_jev.bridge import FileHostBridge, respond, status


class Reply(BaseModel):
    text: str


async def pending(session):
    for _ in range(100):
        requests = status(session)["pending"]
        if requests:
            return requests[0]["id"]
        await asyncio.sleep(0.01)
    raise AssertionError("No pending request")


async def test_host_round_trip_and_replay_rejection(tmp_path):
    bridge = FileHostBridge(tmp_path)
    task = asyncio.create_task(
        bridge.infer([UserMessage(content="Fill the name")], output_format=Reply)
    )
    request_id = await pending(tmp_path)
    respond(tmp_path, request_id, {"text": "Alice"})
    with pytest.raises(FileExistsError):
        respond(tmp_path, request_id, {"text": "Bob"})
    assert (await task).text == "Alice"
    assert not status(tmp_path)["pending"]
    with pytest.raises(ValueError, match="no longer pending"):
        respond(tmp_path, request_id, {"text": "Bob"})


async def test_invalid_reply_can_be_corrected_without_consumption(tmp_path):
    bridge = FileHostBridge(tmp_path)
    task = asyncio.create_task(bridge.infer([], output_format=Reply))
    request_id = await pending(tmp_path)
    with pytest.raises(ValidationError):
        respond(tmp_path, request_id, {"wrong": 123})
    assert not task.done()
    respond(tmp_path, request_id, {"text": "Corrected"})
    assert (await task).text == "Corrected"


async def test_timeout_and_cancel_remove_pending_state(tmp_path):
    bridge = FileHostBridge(tmp_path, timeout=0.01)
    with pytest.raises(TimeoutError):
        await bridge.infer([])
    assert not status(tmp_path)["pending"]
    (tmp_path / "cancel").touch()
    with pytest.raises(asyncio.CancelledError):
        await FileHostBridge(tmp_path).infer([])
    assert not status(tmp_path)["pending"]


async def test_screenshots_exported_to_private_local_files(tmp_path):
    bridge = FileHostBridge(tmp_path)
    encoded = base64.b64encode(b"synthetic image bytes").decode()
    messages = [
        UserMessage(
            content=[
                {"type": "text", "text": "Inspect this image"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
            ]
        )
    ]
    task = asyncio.create_task(bridge.infer(messages))
    request_id = await pending(tmp_path)
    request = json.loads((tmp_path / "requests" / f"{request_id}.json").read_text())
    assert encoded not in json.dumps(request)
    image = next((tmp_path / "images").iterdir())
    assert image.read_bytes() == b"synthetic image bytes"
    assert image.stat().st_mode & 0o777 == 0o600
    respond(tmp_path, request_id, "Image read")
    assert await task == "Image read"


async def test_request_ids_cannot_escape_session(tmp_path):
    with pytest.raises(ValueError, match="Invalid request ID"):
        respond(tmp_path, "../../other", "bad")


def test_routing_handoffs_are_json_serializable():
    from dataclasses import asdict

    from browser_use_with_jev import RoutingStats

    stats = RoutingStats(handoffs={"verify": 1, "text_input:1": 1})
    assert json.loads(json.dumps(asdict(stats)))["handoffs"] == {
        "verify": 1,
        "text_input:1": 1,
    }


def test_config_uses_explicit_or_environment_before_saved_file(tmp_path, monkeypatch):
    from browser_use_with_jev import bridge

    path = tmp_path / "config.json"
    path.write_text(json.dumps({"jev_env": "/configured/credentials"}))
    monkeypatch.setattr(bridge, "config_path", lambda: path)
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert bridge.configured_jev_file(None) == "/configured/credentials"
    assert bridge.configured_jev_file("/explicit/credentials") == "/explicit/credentials"
    monkeypatch.setenv("TYPESAFE_API_KEY", "fake")
    assert bridge.configured_jev_file(None) is None


async def test_wait_returns_request_and_exact_wait_metrics(tmp_path):
    from browser_use_with_jev.bridge import wait_for_request

    bridge = FileHostBridge(tmp_path)
    task = asyncio.create_task(bridge.infer([]))
    request_id = await pending(tmp_path)
    result = wait_for_request(tmp_path, timeout=0)
    assert result["request"]["id"] == request_id
    assert result["request"]["expires_at"] > result["request"]["created_at"]
    respond(tmp_path, request_id, "ok")
    assert "request" not in wait_for_request(tmp_path, timeout=0)
    assert await task == "ok"
    saved = json.loads((tmp_path / "requests" / f"{request_id}.json").read_text())
    assert saved["wait_ms"] >= 0
    assert saved["completed_at"] >= saved["created_at"]
    assert status(tmp_path)["host_wait_ms"] == saved["wait_ms"]


async def test_expired_and_cancelled_requests_reject_responses(tmp_path):
    from browser_use_with_jev.bridge import write_json

    task = asyncio.create_task(FileHostBridge(tmp_path).infer([]))
    request_id = await pending(tmp_path)
    path = tmp_path / "requests" / f"{request_id}.json"
    request = json.loads(path.read_text())
    request["expires_at"] = 0
    write_json(path, request)
    with pytest.raises(ValueError, match="expired"):
        respond(tmp_path, request_id, "late")
    (tmp_path / "cancel").touch()
    with pytest.raises(ValueError, match="cancelled"):
        respond(tmp_path, request_id, "late")
    with pytest.raises(asyncio.CancelledError):
        await task


def test_sandbox_guard_blocks_native_import_but_queue_commands_work(tmp_path):
    import os
    import subprocess
    import sys

    if sys.platform != "darwin":
        pytest.skip("macOS native display guard")
    env = {**os.environ, "CODEX_SANDBOX": "seatbelt"}
    result = subprocess.run(
        [sys.executable, "-c", "from browser_use_with_jev import JevAgent"],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 1  # A Python error, never SIGABRT.
    assert "AppKit SIGABRT" in result.stderr
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "browser_use_with_jev.bridge",
            "status",
            "--session-dir",
            str(tmp_path),
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0
    assert json.loads(result.stdout)["pending"] == []


async def test_wait_wakes_when_new_request_arrives(tmp_path):
    from browser_use_with_jev.bridge import wait_for_request

    FileHostBridge(tmp_path)
    waiter = asyncio.create_task(asyncio.to_thread(wait_for_request, tmp_path, 2))
    inference = asyncio.create_task(FileHostBridge(tmp_path).infer([]))
    result = await waiter
    request_id = result["request"]["id"]
    respond(tmp_path, request_id, "received")
    assert await inference == "received"


async def test_failed_runtime_preflight_persists_failed_state(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from browser_use_with_jev import runtime
    from browser_use_with_jev.bridge import start

    def fail():
        raise RuntimeError("unsafe display")

    monkeypatch.setattr(runtime, "check_browser_runtime", fail)
    session = tmp_path / "new-session"
    with pytest.raises(RuntimeError, match="unsafe display"):
        await start(SimpleNamespace(session_dir=session))
    assert status(session)["status"] == "failed"
    assert status(session)["error_type"] == "RuntimeError"
