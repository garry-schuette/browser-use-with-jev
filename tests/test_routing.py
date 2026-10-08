from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from browser_use import Agent, Tools
from browser_use.agent.views import ActionResult

from browser_use_with_jev.actions import candidates
from browser_use_with_jev.agent import StaleDecision
from browser_use_with_jev.jev import Decision, JevError


async def test_jev_action_uses_real_upstream_schema_without_host(agent):
    instance, host = agent
    output = await instance.get_model_output([])
    assert output.action[0].model_dump(exclude_none=True) == {"click": {"index": 1}}
    host.assert_not_called()
    assert instance.routing.jev_actions == 1
    assert instance.routing.host_calls == 0
    assert instance.run.__func__ is Agent.run
    assert instance.multi_act.__func__ is Agent.multi_act


@pytest.mark.parametrize("choice", ["HOST", "VERIFY", "a1"])
async def test_planning_verification_and_text_handoff_use_original_host(agent, choice):
    instance, host = agent
    instance.jev.choose.return_value = Decision(choice, 0.99, "jev-1.13", 10, {})
    output = await instance.get_model_output([])
    assert output.action[0].model_dump()["done"]["text"] == "Host verified"
    host.assert_awaited_once()
    assert instance.routing.jev_actions == 0


async def test_low_confidence_hands_back(agent):
    instance, host = agent
    instance.jev.choose.return_value = Decision("a0", 0.2, "jev-1.13", 10, {})
    await instance.get_model_output([])
    assert instance.routing.handoffs["low_confidence"] == 1
    host.assert_awaited_once()


async def test_changed_target_identity_never_returns_action(agent, page):
    instance, host = agent
    fresh = deepcopy(page)
    fresh.dom_state.selector_map[1].backend_node_id = 999
    instance.browser_session.get_browser_state_summary.return_value = fresh
    with pytest.raises(StaleDecision):
        await instance.get_model_output([])
    assert instance.routing.stale_decisions == 1
    assert instance.routing.jev_actions == 0
    host.assert_not_called()


async def test_api_failure_handoff_is_counted_and_can_be_disabled(agent):
    instance, host = agent
    instance.jev.choose.side_effect = JevError("Jev HTTP 401")
    await instance.get_model_output([])
    assert instance.routing.jev_errors == 1
    assert instance.routing.handoffs["jev_error"] == 1
    instance.jev_on_error = "raise"
    with pytest.raises(JevError):
        await instance.get_model_output([])
    assert host.await_count == 1


async def test_upstream_done_only_contract_and_failed_action_go_to_host(agent):
    instance, host = agent
    instance.AgentOutput = instance.DoneAgentOutput
    await instance.get_model_output([])
    instance.jev.choose.assert_not_called()
    assert instance.routing.handoffs["upstream_required"] == 1


async def test_failed_action_is_not_blindly_retried(agent):
    instance, host = agent
    instance.state.last_result = [ActionResult(error="Click outcome unknown")]
    await instance.get_model_output([])
    instance.jev.choose.assert_not_called()
    assert instance.routing.handoffs["action_recovery"] == 1


async def test_blank_page_routes_to_host_without_jev(agent, page):
    instance, host = agent
    page.url = "about:blank"
    page.dom_state.selector_map.clear()
    await instance.get_model_output([])
    assert instance.routing.handoffs["navigation_required"] == 1
    instance.jev.choose.assert_not_called()
    host.assert_awaited_once()


async def test_unchanged_state_after_jev_action_routes_to_host(agent):
    instance, host = agent
    await instance.get_model_output([])
    await instance.get_model_output([])
    assert instance.routing.handoffs["no_progress"] == 1
    assert instance.jev.choose.await_count == 1
    host.assert_awaited_once()


def test_date_fields_offer_click_and_invalid_navigation_is_filtered(page):
    model = Tools().registry.create_action_model()
    page.dom_state.selector_map[2].attributes = {"readonly": "", "placeholder": "入住日期"}
    options = candidates(page, model)
    assert any(c.action == {"click": {"index": 2}} for c in options)
    assert not any(c.reason == "text_input:2" for c in options)
    assert not any(c.action and "switch" in c.action for c in options)
    page.url = "about:blank"
    blank_options = candidates(page, model)
    assert not any(c.action and "go_back" in c.action for c in blank_options)
    assert not any(c.action and "wait" in c.action for c in blank_options)


def test_loading_page_without_controls_can_wait_before_navigating_away(page):
    page.dom_state.selector_map.clear()
    page.pixels_above = 0
    page.pixels_below = 0
    options = candidates(page, Tools().registry.create_action_model())
    actions = [c.action for c in options]
    assert {"wait": {"seconds": 1}} in actions
    assert {"go_back": {}} in actions


async def test_upstream_context_hook_clears_observation_on_exception(agent, page, monkeypatch):
    instance, _ = agent
    monkeypatch.setattr(Agent, "_get_next_action", AsyncMock(side_effect=RuntimeError("failure")))
    with pytest.raises(RuntimeError):
        await instance._get_next_action(page)
    assert instance._jev_page is None


def test_candidates_respect_disabled_controls_and_registry_exclusions(page):
    tools = Tools(exclude_actions=["click"])
    model = tools.registry.create_action_model()
    options = candidates(page, model)
    assert not any(c.action and "click" in c.action for c in options)
    assert any(c.reason == "text_input:2" for c in options)
    page.dom_state.selector_map[2].attributes["disabled"] = ""
    assert not any(c.reason == "text_input:2" for c in candidates(page, model))


async def test_custom_upstream_tool_survives_host_handoff(agent):
    instance, host = agent
    tools = Tools()

    @tools.registry.action("Get custom business data")
    async def business_record(record_id: int):
        return ActionResult(extracted_content=str(record_id))

    instance.tools = tools
    instance._setup_action_models()
    instance.jev.choose.return_value = Decision("HOST", 0.99, "jev-1.13", 10, {})
    host.return_value = {"action": [{"business_record": {"record_id": 7}}]}
    output = await instance.get_model_output([])
    assert output.action[0].model_dump() == {"business_record": {"record_id": 7}}
    # This business tool needs no browser connection; exercise the real executor offline.
    result = await tools.act(output.action[0], browser_session=None)
    assert result.extracted_content == "7"


async def test_periodic_review_and_candidate_limit_keep_host_capabilities(agent):
    instance, host = agent
    instance._jev_streak = instance.host_every
    await instance.get_model_output([])
    assert instance.routing.handoffs["periodic_review"] == 1
    instance.max_candidates = 1
    await instance.get_model_output([])
    assert instance.routing.handoffs["candidate_limit"] == 1
    instance.jev.choose.assert_not_called()


async def test_custom_candidates_let_jev_select_registered_tools(agent):
    from browser_use_with_jev import Candidate

    instance, host = agent
    instance.candidate_provider = lambda page, schema: [
        Candidate(
            "Select observed option Economy", {"select_dropdown": {"index": 1, "text": "Economy"}}
        )
    ]
    instance.allow_candidate = lambda c: bool(c.action and "select_dropdown" in c.action)
    output = await instance.get_model_output([])
    assert output.action[0].model_dump() == {"select_dropdown": {"index": 1, "text": "Economy"}}
    host.assert_not_called()


async def test_text_context_preserves_constraints_without_forwarding_images(agent):
    from browser_use.llm.messages import SystemMessage, UserMessage

    instance, _ = agent
    await instance.get_model_output(
        [
            SystemMessage(content="Never submit this form"),
            UserMessage(
                content=[
                    {"type": "text", "text": "Read the page"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,synthetic"}},
                ]
            ),
        ]
    )
    context = instance.jev.choose.call_args.args[0]
    assert context["messages"] == [
        {"role": "system", "text": "Never submit this form"},
        {"role": "user", "text": "Read the page"},
    ]


async def test_context_budget_includes_task_and_history(agent):
    from browser_use.llm.messages import UserMessage

    instance, host = agent
    await instance.get_model_output([UserMessage(content="x" * 40001)])
    instance.jev.choose.assert_not_called()
    assert instance.routing.handoffs["context_limit"] == 1


async def test_custom_candidate_cannot_bypass_host_completion(agent):
    from browser_use_with_jev import Candidate

    instance, host = agent
    instance.candidate_provider = lambda p, s: [Candidate("done", {"done": {"text": "unverified"}})]
    with pytest.raises(ValueError, match="completion belongs"):
        await instance.get_model_output([])
    instance.jev.choose.assert_not_called()


@pytest.mark.parametrize("choice", ["HOST", "VERIFY"])
async def test_low_confidence_explicit_handoff_preserves_intent_and_trace(agent, choice):
    instance, host = agent
    records = []
    instance.decision_sink = records.append
    instance.jev.choose.return_value = Decision(
        choice, 0.2, "jev-1.13", 12, {}, {choice: 0.6, "a0": 0.4}
    )
    await instance.get_model_output([])
    assert instance.routing.handoffs == {choice.lower(): 1}
    assert records[-1]["decision"]["confidence"] == 0.2
    assert records[-1]["decision"]["probabilities"][choice] == 0.6
    assert records[-1]["jev_requested"] is True
    assert records[-1]["candidates"]["a0"]["action"] == {"click": {"index": 1}}
    host.assert_awaited_once()


async def test_local_limit_logs_actual_candidates_without_jev_call(agent):
    instance, _ = agent
    records = []
    instance.decision_sink = records.append
    instance.max_candidates = 1
    await instance.get_model_output([])
    record = records[-1]
    assert record["candidate_count"] == len(record["candidates"]) > 1
    assert record["jev_requested"] is False
    assert record["handoff_reason"] == "candidate_limit"
    assert "decision" not in record
    instance.jev.choose.assert_not_called()


def test_duplicate_identity_hidden_frame_and_scroll_only_candidates(page):
    nodes = page.dom_state.selector_map
    nodes[3] = deepcopy(nodes[1])  # Same observed target; no second click.
    nodes[4] = deepcopy(nodes[1])
    nodes[4].frame_id = "other-frame"  # Same label/id in different frame is distinct.
    nodes[5] = deepcopy(nodes[1])
    nodes[5].backend_node_id = 105
    nodes[5].parent_node = deepcopy(nodes[1])
    nodes[5].parent_node.attributes = {"aria-hidden": "true"}
    nodes[6] = deepcopy(nodes[1])
    nodes[6].backend_node_id = 106
    nodes[6].node_name = "IFRAME"
    nodes[7] = deepcopy(nodes[1])
    nodes[7].backend_node_id = 107
    nodes[7].node_name = "DIV"
    nodes[7].is_scrollable = True
    options = candidates(page, Tools().registry.create_action_model())
    clicks = [c.action["click"]["index"] for c in options if c.action and "click" in c.action]
    assert clicks == [1, 4]
    assert (
        sum(bool(c.action and c.action.get("scroll", {}).get("index") == 7) for c in options) == 2
    )


async def test_compact_context_reuses_state_once_and_logs_exact_request(agent):
    import json

    from browser_use.llm.messages import UserMessage

    instance, _ = agent
    manager = instance._message_manager
    observation = UserMessage(
        content=(
            "<user_request>Read only; never buy tickets.</user_request>\n"
            "<agent_history>Previously opened the calendar.</agent_history>\n"
            "<agent_state>Remember the requested date; todo: inspect prices.</agent_state>\n"
            "<browser_state>[1] Next [2] Search</browser_state>\n"
            "<read_state>Only shown once: ticket costs 28.</read_state>"
        )
    )
    manager._set_message_with_type(observation, "state")
    records = []
    instance.decision_sink = records.append
    messages = manager.get_messages()
    await instance.get_model_output(messages)
    context, criteria = instance.jev.choose.call_args.args
    assert context == {
        "version": 2,
        "source": "upstream_state",
        "messages": [{"role": "user", "text": observation.text}],
    }
    assert records[-1]["request"] == instance.jev.build_request(context, criteria)
    assert records[-1]["request_chars"] == len(
        json.dumps(records[-1]["request"], ensure_ascii=False)
    )
    assert manager.get_messages() == messages
    assert len(json.dumps(context)) < len(manager.system_prompt.text) / 5


async def test_compact_context_handoff_keeps_full_messages_and_images(agent, monkeypatch):
    from browser_use.llm.messages import UserMessage

    instance, _ = agent
    state = UserMessage(
        content=[
            {"type": "text", "text": "Read-only task; calendar loading"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,synthetic"}},
        ]
    )
    instance._message_manager._set_message_with_type(state, "state")
    messages = instance._message_manager.get_messages()
    host_call = AsyncMock(return_value="host-output")
    monkeypatch.setattr(Agent, "get_model_output", host_call)
    instance.jev.choose.return_value = Decision("HOST", 0.9, "jev-1.13", 10, {})
    await instance.get_model_output(messages)
    assert host_call.call_args.args[0][:-1] == messages
    assert host_call.call_args.args[0][1] is state
    assert "data:image" not in str(instance.jev.choose.call_args.args[0])


@pytest.mark.parametrize("override", [None, "Never submit any form."])
async def test_configured_system_constraints_survive_compaction(tmp_path, page, override):
    from browser_use.llm.messages import UserMessage

    from browser_use_with_jev import HostModel, JevAgent, JevClient

    jev = JevClient("synthetic")
    jev.choose = AsyncMock(return_value=Decision("HOST", 0.9, "jev-1.13", 10, {}))
    host = AsyncMock(return_value={"action": [{"done": {"text": "verified", "success": True}}]})
    instance = JevAgent(
        task="Inspect tickets",
        llm=HostModel(host),
        jev=jev,
        override_system_message=override,
        extend_system_message="Never select a date.",
        file_system_path=str(tmp_path / "files"),
        enable_signal_handler=False,
    )
    instance._jev_page = page
    instance._broadcast_model_state = AsyncMock()
    instance._message_manager._set_message_with_type(UserMessage(content="Current page"), "state")
    messages = instance._message_manager.get_messages()
    messages.append(UserMessage(content="Correction: inspect prices only."))
    await instance.get_model_output(messages)
    context = jev.choose.call_args.args[0]
    assert context["messages"][0]["text"] == (
        (override + "\n" if override is not None else "") + "Never select a date."
    )
    assert context["messages"][-1]["text"] == "Correction: inspect prices only."


async def test_request_budget_includes_candidate_descriptions(agent):
    from browser_use_with_jev import Candidate

    instance, host = agent
    instance.candidate_provider = lambda p, s: [Candidate("x" * 40001, {"go_back": {}})]
    await instance.get_model_output([])
    instance.jev.choose.assert_not_called()
    assert instance.routing.handoffs == {"context_limit": 1}
    host.assert_awaited_once()
