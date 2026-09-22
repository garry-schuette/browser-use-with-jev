"""Inspect a development installation without loading browser code or credentials."""

import json
import subprocess
from pathlib import Path


def inspect_installation():
    root = Path(__file__).resolve().parents[3]
    python = root / ".venv" / "bin" / "python"
    checks = {
        "checkout": (root / "pyproject.toml").is_file(),
        "virtualenv": python.is_file(),
        "example": (root / "examples" / "basic.py").is_file(),
        "host_callback": (root / "src/browser_use_with_jev/host.py").is_file(),
    }
    versions = {}
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
    result = inspect_installation()
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if all(result["checks"].values()) else 1)
