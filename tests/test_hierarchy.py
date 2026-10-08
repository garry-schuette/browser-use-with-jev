import json
from copy import deepcopy

import httpx
import pytest

from browser_use_with_jev.actions import Candidate
from browser_use_with_jev.agent import StaleDecision
from browser_use_with_jev.routing import HANDOFFS, operation_questions, target_question


def answer(question, choice, confidence=0.99):
    return {
        "type": "choice",
        "choice": choice,
        "confidence": confidence,
        "probabilities": {key: float(key == choice) for key in question["criteria"]},
    }


def route_to(questions, desired, dom_index=None):
    """Synthetic oracle: choose an offered leaf or its containing group."""
    selected = None
    answers = {}
    for key, question in questions.items():
        if key == "operation":
            continue
        criteria = question["criteria"]
        choice = next(
            (
                k
                for k, v in criteria.items()
                if k == desired
                or isinstance(v, dict)
                and desired in v["members"]
                or isinstance(v, dict)
                and dom_index in v.get("dom_indices", [])
            ),
            "HOST",
        )
        if choice != "HOST":
            selected = key
        answers[key] = answer(question, choice)
    if "operation" in questions:
        answers["operation"] = answer(questions["operation"], selected or "op0")
    return answers


def install_transport(instance, desired, mutate=None, dom_index=None):
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        questions = body["questions"]
        answers = route_to(questions, desired, dom_index)
        if mutate:
            mutate(answers, len(requests))
        return httpx.Response(200, json={"model": "jev-test", "answers": answers})

    instance.jev.transport = httpx.MockTransport(handler)
    return requests


def large_pool(instance, count):
    instance.candidate_provider = lambda p, s: [
        Candidate(f"Click observed hotel filter {i}", {"click": {"index": i + 1}})
        for i in range(count)
    ]
    # Keep the exact count separate from the built-in page candidates.
    instance.allow_candidate = lambda c: c.label.startswith("Click observed hotel filter")


@pytest.mark.parametrize("count", [303, 424])
async def test_large_candidate_sets_select_last_target_without_truncation(agent, count):
    instance, host = agent
    large_pool(instance, count)
    requests = install_transport(instance, f"a{count - 1}")
    output = await instance.get_model_output([])
    assert output.action[0].model_dump(exclude_none=True) == {"click": {"index": count}}
    assert len(requests) == instance.routing.jev_calls == 2
    assert instance.routing.jev_actions == 1
    assert instance._decision_record["candidate_count"] == count
    first = requests[0]["questions"]["op0"]["criteria"]
    covered = [
        cid for value in first.values() if isinstance(value, dict) for cid in value["members"]
    ]
    assert len(covered) == len(set(covered)) == count
    assert set(covered) == {f"a{i}" for i in range(count)}
    assert all(len(q["criteria"]) <= 128 for r in requests for q in r["questions"].values())
    assert len(instance._decision_record["requests"]) == 2
    assert instance.routing.jev_ms == sum(
        next(iter(r["answers"].values()))["elapsed_ms"]
        for r in instance._decision_record["requests"]
    )
    host.assert_not_called()


def test_each_operation_head_contains_only_compatible_targets_and_preserves_frames():
    options = [
        Candidate("Frame A same date", {"click": {"index": 1}}),
        Candidate("Frame B same date", {"click": {"index": 2}}),
        Candidate("Search", None, "text_input:3"),
        Candidate("Down", {"scroll": {"down": True, "pages": 1}}),
        Candidate("Up", {"scroll": {"down": False, "pages": 1}}),
        Candidate("Economy", {"select_dropdown": {"index": 4, "text": "Economy"}}),
    ]
    questions, operations, _ = operation_questions(options, 128)
    assert len(operations) == 5
    pools = [set(pool) for _, pool in operations.values()]
    assert pools == [{"a0", "a1"}, {"a2"}, {"a3"}, {"a4"}, {"a5"}]
    assert all(set(HANDOFFS) <= set(q["criteria"]) for q in questions.values())


def test_recursive_groups_cover_every_target_with_small_limit():
    options = {f"a{i}": Candidate(f"Control {i}", {"click": {"index": i + 1}}) for i in range(424)}
    seen = []

    def visit(pool):
        target = target_question(pool, 6, "click")
        assert len(target.question["criteria"]) <= 6
        if not target.groups:
            seen.extend(pool)
        for child in target.groups.values():
            assert len(child) < len(pool)
            visit(child)

    visit(options)
    assert seen == list(options)


@pytest.mark.parametrize("stage", [1, 2])
@pytest.mark.parametrize(
    "choice,confidence,reason",
    [
        ("HOST", 0.1, "host"),
        ("VERIFY", 0.1, "verify"),
        (None, 0.1, "low_confidence"),
    ],
)
async def test_handoff_or_uncertainty_at_any_layer_executes_nothing(
    agent, stage, choice, confidence, reason
):
    instance, host = agent
    large_pool(instance, 424)

    def mutate(answers, call):
        if call == stage:
            a = answers["operation" if stage == 1 else "next"]
            if choice:
                a["choice"] = choice
                a["probabilities"] = {k: float(k == choice) for k in a["probabilities"]}
            a["confidence"] = confidence

    requests = install_transport(instance, "a423", mutate)
    await instance.get_model_output([])
    assert instance.routing.handoffs == {reason: 1}
    assert instance.routing.jev_actions == 0
    assert len(requests) == stage
    host.assert_awaited_once()


async def test_uncertainty_on_unused_target_head_does_not_block_selected_operation(agent):
    instance, host = agent
    instance.max_candidates = 7
    instance.candidate_provider = lambda p, s: [
        Candidate(f"Extra observed click {i}", {"click": {"index": i + 10}}) for i in range(4)
    ]

    def mutate(answers, call):
        for key, a in answers.items():
            if key not in {"operation", "op0"}:
                a["confidence"] = 0.01

    requests = install_transport(instance, "a0", mutate)
    await instance.get_model_output([])
    assert "operation" in requests[0]["questions"]
    assert instance.routing.jev_actions == 1
    host.assert_not_called()


@pytest.mark.parametrize("count,limit", [(128, 128), (300, 1000)])
async def test_total_choice_cap_includes_handoffs_and_provider_ceiling(agent, count, limit):
    instance, host = agent
    instance.max_candidates = limit
    large_pool(instance, count)
    requests = install_transport(instance, f"a{count - 1}")
    await instance.get_model_output([])
    assert requests
    assert all(
        len(q["criteria"]) <= min(limit, 255) for r in requests for q in r["questions"].values()
    )
    host.assert_not_called()


async def test_text_target_in_hierarchy_hands_to_host_with_original_index(agent):
    instance, host = agent
    instance.max_candidates = 7
    instance.candidate_provider = lambda p, s: [
        Candidate(f"Extra click {i}", {"click": {"index": i + 10}}) for i in range(4)
    ]
    requests = install_transport(instance, "a1")
    await instance.get_model_output([])
    assert len(requests) == 1
    assert instance.routing.handoffs == {"text_input:2": 1}
    assert instance.routing.jev_actions == 0
    host.assert_awaited_once()


@pytest.mark.parametrize("failure", ["missing_answer", "wrong_head_target", "bad_distribution"])
async def test_invalid_multi_question_response_never_reaches_browser(agent, failure):
    instance, host = agent
    large_pool(instance, 424)

    def mutate(answers, call):
        if failure == "missing_answer":
            del answers["op0"]
        elif failure == "wrong_head_target":
            answers["operation"]["choice"] = "g0"
        else:
            answers["op0"]["probabilities"]["g0"] = 2.0

    install_transport(instance, "a423", mutate)
    await instance.get_model_output([])
    assert instance.routing.handoffs == {"jev_error": 1}
    assert instance.routing.jev_actions == 0
    host.assert_awaited_once()


async def test_state_change_between_group_and_target_aborts_before_second_request(agent, page):
    instance, host = agent
    large_pool(instance, 424)
    requests = install_transport(instance, "a423")
    fresh = deepcopy(page)
    fresh.dom_state.selector_map[1].backend_node_id += 1
    instance.browser_session.get_browser_state_summary.return_value = fresh
    with pytest.raises(StaleDecision):
        await instance.get_model_output([])
    assert len(requests) == 1
    assert instance.routing.jev_actions == 0
    host.assert_not_called()


async def test_oversized_speculation_defers_targets_without_dropping_constraints(agent):
    instance, host = agent
    instance.max_candidates = 6
    instance.max_context_chars = 5000
    # Two large operation pools; only one is applicable. Each head fits alone.
    instance.candidate_provider = lambda p, s: (
        [Candidate(f"Observed {'x' * 200} {i}", {"click": {"index": i + 1}}) for i in range(8)]
        + [
            Candidate(f"Other {'y' * 200} {i}", {"select_dropdown": {"index": 1, "text": str(i)}})
            for i in range(8)
        ]
    )
    instance.allow_candidate = lambda c: c.label.startswith(("Observed", "Other"))
    requests = install_transport(instance, "a7")
    instance.task = "Read only. Never submit or purchase."
    await instance.get_model_output([])
    assert instance._decision_record["routing_mode"] == "hierarchical_serial"
    assert list(requests[0]["questions"]) == ["operation"]
    assert all(r["state"]["task"] == instance.task for r in requests)
    assert all(len(json.dumps(r, ensure_ascii=False)) <= 5000 for r in requests)
    assert instance.routing.jev_actions == 1
    host.assert_not_called()


async def test_selected_target_context_limit_hands_off_without_oversized_call(agent):
    instance, host = agent
    large_pool(instance, 424)
    instance.max_context_chars = 3000
    requests = install_transport(instance, "a423")
    await instance.get_model_output([])
    assert len(requests) == 1
    assert instance.routing.handoffs == {"context_limit": 1}
    assert instance._decision_record["requests"][-1]["submitted"] is False
    assert instance._decision_record["request_submitted"] is False
    assert instance._decision_record["request_chars"] == len(
        json.dumps(instance._decision_record["request"], ensure_ascii=False)
    )
    host.assert_awaited_once()


async def test_large_dom_reuses_indices_then_splits_long_leaf_labels_to_fit(agent, page):
    instance, host = agent
    prototype = page.dom_state.selector_map[1]
    page.dom_state.selector_map = {}
    for i in range(1, 425):
        node = deepcopy(prototype)
        node.backend_node_id = i
        node.ax_node.name = f"Date {i} " + "Calendar details " * 15
        page.dom_state.selector_map[i] = node
    # Represent an expanded page; names of nested rows are resolved from this
    # observation for group selection, then full labels are offered for actions.
    # Upstream prefixes newly observed nodes with an asterisk.
    dom = "\n".join(f"*[{i}]<button>Control {i}</button>" for i in range(1, 425))
    dom += "\n" + "Original task constraints and page details. " * 400
    page.dom_state.llm_representation = lambda: dom
    instance.allow_candidate = lambda c: bool(c.action and "click" in c.action)
    requests = install_transport(instance, "a423", dom_index=424)
    output = await instance.get_model_output([])
    assert output.action[0].model_dump(exclude_none=True) == {"click": {"index": 424}}
    assert len(requests) >= 3
    assert all(r["state"]["dom"] == dom for r in requests)
    assert all(len(json.dumps(r, ensure_ascii=False)) <= 40000 for r in requests)
    assert all(len(q["criteria"]) <= 128 for r in requests for q in r["questions"].values())
    # A final action is still chosen using the complete candidate description.
    assert requests[-1]["questions"]["next"]["criteria"]["a423"].endswith(
        page.dom_state.selector_map[424].ax_node.name.strip()
    )
    host.assert_not_called()


def test_group_references_only_known_current_dom_and_keeps_unknown_labels():
    pool = {
        f"a{i}": Candidate(f"Label {i}", {"click": {"index": i}}, dom_index=i) for i in range(10)
    }
    target = target_question(pool, 6, "click", {0, 1, 2})
    criteria = target.question["criteria"]
    assert criteria["g0"]["dom_indices"] == [0, 1, 2]
    assert criteria["g0"]["members"] == {"a3": "Label 3"}
    assert criteria["g1"]["members"] == {f"a{i}": f"Label {i}" for i in range(4, 8)}
