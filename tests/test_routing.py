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
