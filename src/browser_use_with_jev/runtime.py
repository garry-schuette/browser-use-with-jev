"""Fail before upstream native display initialization in the known unsafe runtime."""

import os
import sys


def check_browser_runtime():
    if sys.platform == "darwin" and os.environ.get("CODEX_SANDBOX") == "seatbelt":
        raise RuntimeError(
            "Browser Use display initialization is unsafe in the macOS Codex seatbelt "
            "sandbox (AppKit SIGABRT). Run the browser worker with normal desktop "
            "permissions outside that sandbox. Headless mode does not avoid the import-time "
            "probe. Queue commands (status/request/respond/cancel) remain safe here."
        )
