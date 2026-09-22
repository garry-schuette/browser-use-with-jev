"""Local request/response bridge: the active coding agent supplies host inference.

No host API key, background model, network listener, or automatic approval.
Private files carry messages between the Browser Use worker and the host tools.
"""

import argparse
import asyncio
import base64
import json
import os
import re
import time
import uuid
from dataclasses import asdict
from pathlib import Path


def write_json(path, value, *, exclusive=False):
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("x", encoding="utf-8") as stream:
            os.chmod(temp, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
        if exclusive:
            os.link(temp, path)  # Atomic create, never replace a submitted response.
        else:
            os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def request_path(session, request_id):
    if not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise ValueError("Invalid request ID")
    return session / "requests" / f"{request_id}.json"


def config_path():
    return Path.home() / ".config/browser-use-with-jev/config.json"


def configured_jev_file(explicit):
    if explicit is not None or os.environ.get("TYPESAFE_API_KEY"):
        return explicit
    path = config_path()
    if path.exists():
        return json.loads(path.read_text()).get("jev_env")
    return None


class FileHostBridge:
    def __init__(self, session, timeout=600):
        self.session = Path(session).resolve()
        self.timeout = timeout
        self.lock = asyncio.Lock()
        for directory in [self.session, self.session / "requests", self.session / "images"]:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.host_calls = 0

    def export_messages(self, messages, request_id):
        result = []
        for message in messages:
            data = message.model_dump(mode="json", exclude_none=True)
            if isinstance(data.get("content"), list):
                for i, part in enumerate(data["content"]):
                    if part.get("type") != "image_url":
                        continue
                    url = part["image_url"]["url"]
                    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,(.*)", url, re.DOTALL)
                    if match:
                        path = (
                            self.session / "images" / (f"{request_id}-{len(result)}-{i}.{match[1]}")
                        )
                        with path.open("xb") as stream:
                            os.chmod(path, 0o600)
                            stream.write(base64.b64decode(match[2], validate=True))
                        data["content"][i] = {"type": "local_image", "path": str(path)}
            result.append(data)
        return result

    async def infer(self, messages, *, output_format=None, **kwargs):
        async with self.lock:
            request_id = uuid.uuid4().hex
            path = request_path(self.session, request_id)
            response_path = path.with_suffix(".response.json")
            self.host_calls += 1
            request = {
                "id": request_id,
                "status": "pending",
                "created_at": time.time(),
                "messages": self.export_messages(messages, request_id),
                "output_schema": output_format.model_json_schema() if output_format else None,
            }
            write_json(path, request)
            print(json.dumps({"event": "host_request", "id": request_id}), flush=True)
            deadline = time.monotonic() + self.timeout
            try:
                while time.monotonic() < deadline:
                    if (self.session / "cancel").exists():
                        raise asyncio.CancelledError("Host cancelled the browser task")
                    if response_path.exists():
                        response = json.loads(response_path.read_text())
                        if response.get("id") != request_id:
                            raise ValueError("Response ID mismatch")
                        if response.get("error"):
                            raise asyncio.CancelledError("Host declined the pending request")
                        value = response["completion"]
                        if output_format:
                            value = output_format.model_validate(value)
                        elif not isinstance(value, str):
                            raise ValueError("Host must return a string for unstructured requests")
                        request["status"] = "consumed"
                        return value
                    await asyncio.sleep(0.2)
                raise TimeoutError("Timed out waiting for the active host agent")
            except BaseException:
                request["status"] = "cancelled"
                raise
            finally:
                write_json(path, request)


def status(session):
    state_file = session / "state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {"status": "unknown"}
    if state.get("status") == "running" and state.get("pid"):
        try:
            os.kill(state["pid"], 0)
        except ProcessLookupError:
            state["status"] = "interrupted"
        except PermissionError:
            pass
    pending = []
    for path in sorted((session / "requests").glob("*.json")):
        if path.name.endswith(".response.json"):
            continue
        request = json.loads(path.read_text())
        if request["status"] == "pending":
            pending.append({"id": request["id"], "created_at": request["created_at"]})
    return {**state, "pending": pending}


def respond(session, request_id, value):
    path = request_path(session, request_id)
    request = json.loads(path.read_text())
    if request["status"] != "pending":
        raise ValueError("Request is no longer pending")
    if request["output_schema"] is not None:
        from jsonschema import validate

        validate(instance=value, schema=request["output_schema"])
    elif not isinstance(value, str):
        raise ValueError("Expected a JSON string")
    write_json(
        path.with_suffix(".response.json"),
        {
            "id": request_id,
            "completion": value,
        },
        exclusive=True,
    )


async def start(args):
    # Browser Use imports native display code on macOS; other commands avoid it.
    from browser_use import Browser

    from .agent import JevAgent
    from .host import HostModel
    from .jev import JevClient

    session = args.session_dir.resolve()
    session.mkdir(mode=0o700, parents=True, exist_ok=False)
    bridge = FileHostBridge(session, args.host_timeout)
    browser = Browser(
        headless=args.headless,
        user_data_dir=str(session / "profile"),
        keep_alive=False,
        enable_default_extensions=args.extensions,
    )
    state = {"status": "running", "pid": os.getpid()}
    write_json(session / "state.json", state)
    watcher = None
    agent = None
    try:
        agent = JevAgent(
            task=args.task_file.read_text(),
            jev=JevClient.from_env(configured_jev_file(args.jev_env)),
            llm=HostModel(bridge.infer),
            browser=browser,
            file_system_path=str(session / "files"),
            llm_timeout=args.host_timeout + 60,
            step_timeout=args.host_timeout + 180,
            max_context_chars=120000,
            enable_signal_handler=False,
        )
        run_task = asyncio.create_task(agent.run(max_steps=args.max_steps))

        async def watch_cancel():
            while not run_task.done():
                if (session / "cancel").exists():
                    run_task.cancel()
                    return
                await asyncio.sleep(0.2)

        watcher = asyncio.create_task(watch_cancel())
        history = await run_task
        state.update(
            status="finished", final_result=history.final_result(), success=history.is_successful()
        )
        history.save_to_file(str(session / "history.json"))
    except asyncio.CancelledError:
        state.update(status="cancelled")
    except Exception as error:
        # Error type only: upstream exception strings may include page or provider data.
        state.update(status="failed", error_type=type(error).__name__)
        raise
    finally:
        if watcher:
            watcher.cancel()
        state["host_requests"] = bridge.host_calls
        if agent:
            state["routing"] = asdict(agent.routing)
        try:
            write_json(session / "state.json", state)
        finally:
            await browser.kill()
    print(json.dumps({"event": "finished", "status": state["status"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    config = sub.add_parser("configure", help="Save a credential file path, never the key itself")
    config.add_argument("--jev-env", type=Path, required=True)
    for name in ["start", "status", "request", "respond", "cancel"]:
        command = sub.add_parser(name)
        command.add_argument("--session-dir", type=Path, required=True)
        if name == "start":
            command.add_argument("--task-file", type=Path, required=True)
            command.add_argument("--jev-env", type=Path)
            command.add_argument("--max-steps", type=int, default=30)
            command.add_argument("--host-timeout", type=int, default=600)
            command.add_argument("--headless", action="store_true")
            command.add_argument("--extensions", action="store_true")
        if name in {"request", "respond"}:
            command.add_argument("--id", required=True)
        if name == "respond":
            command.add_argument("--file", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "configure":
        source = args.jev_env.expanduser().resolve()
        if not source.is_file():
            parser.error("Credential file does not exist")
        path = config_path()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        value = json.loads(path.read_text()) if path.exists() else {}
        value["jev_env"] = str(source)
        write_json(path, value)
        print("Saved Jev credential file reference; no key copied")
    elif args.command == "start":
        if args.max_steps < 1 or args.host_timeout < 1:
            parser.error("max-steps and host-timeout must be positive")
        # Set before importing Browser Use, and only for this worker process.
        os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
        os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
        asyncio.run(start(args))
    elif args.command == "status":
        print(json.dumps(status(args.session_dir), ensure_ascii=False, indent=2))
    elif args.command == "request":
        print(request_path(args.session_dir, args.id).read_text())
    elif args.command == "respond":
        respond(args.session_dir, args.id, json.loads(args.file.read_text()))
        print("Response submitted")
    elif args.command == "cancel":
        (args.session_dir / "cancel").touch(mode=0o600)
        print("Cancellation requested")


if __name__ == "__main__":
    main()
