"""Inspect a development installation without loading browser code or credentials."""

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def inspect_installation(mode="standalone"):
    root = Path(__file__).resolve().parents[3]
    python = root / ".venv" / "bin" / "python"
    checks = {
        "checkout": (root / "pyproject.toml").is_file(),
        "virtualenv": python.is_file(),
        "example": (root / "examples" / "basic.py").is_file(),
        "host_callback": (root / "src/browser_use_with_jev/host.py").is_file(),
        "conversation_bridge": (root / "src/browser_use_with_jev/bridge.py").is_file(),
    }
    versions = {}
    if mode == "sidebar":
        skill = root / "skills/browser-use-with-jev"
        checks = {
            "checkout": checks["checkout"],
            **{
                name: (skill / name).is_file()
                for name in [
                    "sidebar.mjs",
                    "sidebar-client.mjs",
                    "sidebar-transport.mjs",
                    "sidebar-worker.mjs",
                ]
            },
        }
        node = shutil.which("node")
        checks["node_22_or_newer"] = False
        if node:
            result = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=15)
            version = result.stdout.strip().removeprefix("v")
            checks["node_22_or_newer"] = result.returncode == 0 and int(version.split(".")[0]) >= 22
            versions["node"] = version
        return {"checkout": str(root), "mode": mode, "checks": checks, "versions": versions}
    if checks["virtualenv"]:
        code = (
            "import importlib.metadata as m,json;"
            "print(json.dumps({p:m.version(p) for p in "
            "['browser-use','browser-use-with-jev']}))"
        )
        result = subprocess.run(
            [str(python), "-c", code], capture_output=True, text=True, timeout=15
        )
        checks["dependencies"] = result.returncode == 0
        if checks["dependencies"]:
            versions = json.loads(result.stdout)
    else:
        checks["dependencies"] = False
    return {"checkout": str(root), "checks": checks, "versions": versions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["sidebar", "standalone"], default="standalone")
    result = inspect_installation(parser.parse_args().mode)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if all(result["checks"].values()) else 1)
