"""Generate concrete candidates from Browser Use's typed DOM and active tool schema."""

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError


@dataclass(frozen=True)
class Candidate:
    label: str
    action: dict[str, Any] | None
    reason: str = ""


def candidates(page, action_model) -> list[Candidate]:
    result = []

    def supports(action):
        try:
            parsed = action_model.model_validate(action)
        except ValidationError:
            return False
        return set(parsed.model_dump(exclude_none=True)) == set(action)

    def add(label, action):
        if not supports(action):
            return
        result.append(Candidate(label, action))

    for index, node in page.dom_state.selector_map.items():
        if index < 1 or node.is_visible is False:
            continue
        attrs = node.attributes
        if "disabled" in attrs or attrs.get("aria-disabled") == "true":
            continue
        tag = node.node_name.lower()
        name = (
            getattr(node.ax_node, "name", None)
            or attrs.get("aria-label")
            or attrs.get("title")
            or attrs.get("placeholder")
            or tag
        )[:300]
        label = f"[{index}] {tag}: {name}"
        if (
            tag in {"input", "textarea"}
            and attrs.get("type", "text")
            not in {"button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image"}
            or attrs.get("contenteditable") in {"true", ""}
        ):
            if supports({"input": {"index": index, "text": ""}}):
                result.append(
                    Candidate(f"Generate and enter text in {label}", None, f"text_input:{index}")
                )
        elif tag == "select":
            add(f"Read dropdown options for {label}", {"dropdown_options": {"index": index}})
        elif tag != "input" or attrs.get("type") not in {"file", "hidden"}:
            add(f"Click {label}", {"click": {"index": index}})
        if node.is_scrollable:
            for down in (True, False):
                add(
                    f"Scroll {'down' if down else 'up'} inside {label}",
                    {"scroll": {"down": down, "pages": 1, "index": index}},
                )
    for down in (True, False):
        add(f"Scroll page {'down' if down else 'up'}", {"scroll": {"down": down, "pages": 1}})
    add("Go back in browser history", {"go_back": {}})
    add("Wait one second for page loading", {"wait": {"seconds": 1}})
    for tab in page.tabs:
        add(f"Switch to tab {tab.title}: {tab.url}", {"switch": {"tab_id": tab.target_id[-4:]}})
    return result


def fingerprint(page) -> str:
    """Guard both semantic state and the identity behind indexed targets."""
    state = {
        "url": page.url,
        "dom": page.dom_state.llm_representation(),
        "nodes": [
            (i, n.backend_node_id, n.frame_id, n.target_id)
            for i, n in page.dom_state.selector_map.items()
        ],
        "tabs": [(t.target_id, t.url) for t in page.tabs],
        "scroll": [page.pixels_above, page.pixels_below],
    }
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()
