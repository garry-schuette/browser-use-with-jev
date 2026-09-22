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
