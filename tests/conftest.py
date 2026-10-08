import os
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BROWSER_USE_CLOUD_SYNC"] = "false"
os.environ["BROWSER_USE_CONFIG_DIR"] = tempfile.mkdtemp(prefix="buwj-tests-")

from browser_use_with_jev.runtime import check_browser_runtime

check_browser_runtime()

import pytest  # noqa: E402
from browser_use.browser.views import BrowserStateSummary, TabInfo  # noqa: E402

from browser_use_with_jev import HostModel, JevAgent, JevClient  # noqa: E402
from browser_use_with_jev.jev import Decision  # noqa: E402


@pytest.fixture
def page():
    nodes = {
        1: SimpleNamespace(
            is_visible=True,
            attributes={},
            node_name="BUTTON",
            ax_node=SimpleNamespace(name="Next"),
            is_scrollable=False,
            backend_node_id=101,
            frame_id="f",
            target_id="t",
        ),
        2: SimpleNamespace(
            is_visible=True,
            attributes={"type": "text"},
            node_name="INPUT",
            ax_node=SimpleNamespace(name="Search"),
            is_scrollable=False,
            backend_node_id=102,
            frame_id="f",
            target_id="t",
        ),
    }
    return BrowserStateSummary(
        dom_state=SimpleNamespace(
            selector_map=nodes, llm_representation=lambda: "[1] Next [2] Search"
        ),
        url="https://example.com",
        title="Example",
        tabs=[TabInfo(url="https://example.com", title="Example", target_id="target-1234")],
    )


@pytest.fixture
def agent(tmp_path, page):
    host = AsyncMock(
        return_value={"action": [{"done": {"text": "Host verified", "success": True}}]}
    )
    jev = JevClient("synthetic-test-key")
    jev.choose = AsyncMock(return_value=Decision("a0", 0.99, "jev-1.13", 10, {}))
    agent = JevAgent(
        task="Find the requested page",
        llm=HostModel(host),
        jev=jev,
        file_system_path=str(tmp_path / "files"),
        enable_signal_handler=False,
    )
    agent._jev_page = page
    object.__setattr__(
        agent.browser_session, "get_browser_state_summary", AsyncMock(return_value=page)
    )
    agent._broadcast_model_state = AsyncMock()
    return agent, host
