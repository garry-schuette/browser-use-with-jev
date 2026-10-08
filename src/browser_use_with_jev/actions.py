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
    # Built-in targets can refer back to the observed DOM while choosing a group.
    # Custom candidates retain their labels unless the provider supplies this hint.
    dom_index: int | None = None


def hidden_branch(node):
    seen = set()
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        attrs = node.attributes
        if node.is_visible is False or "hidden" in attrs or "inert" in attrs:
            return True
        if attrs.get("aria-hidden", "").lower() == "true":
            return True
        node = getattr(node, "parent_node", None)
    return False


def candidates(page, action_model) -> list[Candidate]:
    result = []

    def supports(action):
        try:
            parsed = action_model.model_validate(action)
        except ValidationError:
            return False
        return set(parsed.model_dump(exclude_none=True)) == set(action)

    def add(label, action, dom_index=None):
        if not supports(action):
            return
        result.append(Candidate(label, action, dom_index=dom_index))

    seen_targets = set()
    interactive_roles = {
        "button",
        "link",
        "checkbox",
        "radio",
        "tab",
        "option",
        "menuitem",
        "combobox",
        "textbox",
    }
    for index, node in page.dom_state.selector_map.items():
        if index < 1 or hidden_branch(node):
            continue
        attrs = node.attributes
        if "disabled" in attrs or attrs.get("aria-disabled") == "true":
            continue
        identity = (node.target_id, node.frame_id, node.backend_node_id)
        if node.backend_node_id is not None:
            if identity in seen_targets:
                continue
            seen_targets.add(identity)
        tag = node.node_name.lower()
        snapshot = getattr(node, "snapshot_node", None)
        role = getattr(node.ax_node, "role", None) or attrs.get("role")
        role = str(role or "").lower()
        scroll_only = (
            node.is_scrollable
            and tag in {"div", "section", "main", "body", "html"}
            and role not in {"button", "link", "checkbox", "radio", "tab", "option", "menuitem"}
            and not getattr(snapshot, "is_clickable", False)
            and "onclick" not in attrs
            and "tabindex" not in attrs
        )
        name = (
            getattr(node.ax_node, "name", None)
            or attrs.get("aria-label")
            or attrs.get("title")
            or attrs.get("placeholder")
            or ""
        )[:300].strip()
        # Browser Use indexes many anonymous layout wrappers. They do not give
        # Jev enough information to distinguish a useful click from a no-op.
        if not name and tag in {"div", "span"} and role not in interactive_roles:
            if not node.is_scrollable:
                continue
        name = name or tag
        label = f"[{index}] {tag}: {name}"
        date_field = tag == "input" and (
            attrs.get("type", "").lower() in {"date", "datetime-local"}
            or attrs.get("aria-haspopup", "").lower() in {"dialog", "grid"}
            or attrs.get("readonly") is not None
            and any(
                word
                in (
                    name + " " + attrs.get("class", "") + " " + attrs.get("placeholder", "")
                ).lower()
                for word in ("date", "calendar", "日期", "入住", "退房")
            )
        )
        if (
            tag in {"input", "textarea"}
            and attrs.get("type", "text")
            not in {"button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image"}
            or attrs.get("contenteditable") in {"true", ""}
        ):
            if supports({"input": {"index": index, "text": ""}}):
                if not date_field:
                    result.append(
                        Candidate(
                            f"Generate and enter text in {label}",
                            None,
                            f"text_input:{index}",
                            index,
                        )
                    )
            if date_field:
                add(f"Open date picker from {label}", {"click": {"index": index}}, index)
        elif tag == "select":
            add(f"Read dropdown options for {label}", {"dropdown_options": {"index": index}}, index)
        elif (tag != "input" or attrs.get("type") not in {"file", "hidden"}) and (
            tag not in {"iframe", "frame"} and not scroll_only
        ):
            add(f"Click {label}", {"click": {"index": index}}, index)
        if node.is_scrollable:
            for down in (True, False):
                add(
                    f"Scroll {'down' if down else 'up'} inside {label}",
                    {"scroll": {"down": down, "pages": 1, "index": index}},
                )
    if page.pixels_below is None or page.pixels_below > 0:
        add("Scroll page down", {"scroll": {"down": True, "pages": 1}})
    if page.pixels_above is None or page.pixels_above > 0:
        add("Scroll page up", {"scroll": {"down": False, "pages": 1}})
    if page.url and page.url != "about:blank" and not result:
        add("Wait one second for page loading", {"wait": {"seconds": 1}})
    if page.url and page.url != "about:blank":
        add("Go back in browser history", {"go_back": {}})
    for tab in page.tabs:
        if tab.url != page.url:
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
