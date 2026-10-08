"""Thin adapter: selection changes, upstream execution and tools remain intact."""

import json
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

from .runtime import check_browser_runtime

check_browser_runtime()

from browser_use import Agent  # noqa: E402
from browser_use.llm.messages import UserMessage  # noqa: E402

from .actions import Candidate, candidates, fingerprint  # noqa: E402
from .context import decision_context  # noqa: E402
from .jev import JevClient, JevError  # noqa: E402
from .routing import HANDOFFS, operation_questions, target_question  # noqa: E402


class StaleDecision(RuntimeError):
    """Browser changed during a decision. Let the next upstream step observe again."""


class Handoff(Exception):
    """A routing stage needs the original host; carries a local reason only."""


@dataclass
class RoutingStats:
    jev_calls: int = 0
    jev_actions: int = 0  # Selected actions, not a claim of successful execution.
    host_calls: int = 0
    jev_errors: int = 0
    stale_decisions: int = 0
    jev_ms: float = 0
    handoffs: dict[str, int] = field(default_factory=dict)


class JevAgent(Agent):
    """Browser Use Agent with Jev-first routing and an explicit host-model fallback.

    ``llm`` remains the full upstream model, including extraction and verification.
    It can also be a HostModel callback supplied by an embedding agent.
    ``allow_candidate`` restricts Jev delegation only; it is not an authorization
    boundary for upstream tools or the host model.
    """

    def __init__(
        self,
        *args,
        jev: JevClient,
        min_confidence: float = 0.65,
        max_candidates: int = 128,
        max_context_chars: int = 40000,
        host_every: int = 12,
        jev_on_error: str = "handoff",
        allow_candidate: Callable[[Candidate], bool] | None = None,
        candidate_provider: Callable | None = None,
        decision_sink: Callable[[dict], None] | None = None,
        **kwargs,
    ):
        if not 0 <= min_confidence <= 1 or max_candidates < 1 or max_context_chars < 1:
            raise ValueError("Invalid Jev routing limits")
        if host_every < 1 or jev_on_error not in {"handoff", "raise"}:
            raise ValueError("Invalid host handoff settings")
        if kwargs.get("llm") is None and len(args) < 2:
            raise ValueError("Supply llm explicitly (a Browser Use model or HostModel callback)")
        self.jev = jev
        self.min_confidence = min_confidence
        self.max_candidates = max_candidates
        self.max_context_chars = max_context_chars
        self.host_every = host_every
        self.jev_on_error = jev_on_error
        self.allow_candidate = allow_candidate
        self.candidate_provider = candidate_provider
        self.decision_sink = decision_sink
        self._round = 0
        self._decision_record = {}
        self.routing = RoutingStats()
        self._jev_page = None
        self._jev_streak = 0
        self._last_jev_action = None
        super().__init__(*args, **kwargs)
        # Overrides may contain application constraints; never strip them.
        self._jev_system_text = (
            self._message_manager.system_prompt.text
            if self.settings.override_system_message is None
            else None
        )
        self._jev_system_extension = self.settings.extend_system_message

    async def _get_next_action(self, browser_state_summary):
        # Only protected hook used. Pinned and covered by upstream contract tests.
        self._jev_page = browser_state_summary
        try:
            return await super()._get_next_action(browser_state_summary)
        finally:
            self._jev_page = None

    def _trace(self, **values):
        self._decision_record.update(values)
        if self.decision_sink:
            self.decision_sink(dict(self._decision_record))

    async def _host(self, messages, reason):
        self._trace(outcome="host", handoff_reason=reason)
        self.routing.host_calls += 1
        self.routing.handoffs[reason] = self.routing.handoffs.get(reason, 0) + 1
        self._jev_streak = 0
        self._last_jev_action = None
        self.logger.info("Jev → host: %s", reason)
        hint = UserMessage(
            content=(
                f"Jev routing handoff: {reason}. Use the current browser evidence and the original "
                "task. Verify outcomes independently. Jev has not asserted task completion."
            )
        )
        return await super().get_model_output([*messages, hint])

    async def _fresh(self, before):
        fresh = await self.browser_session.get_browser_state_summary(
            cached=False, include_screenshot=False
        )
        if fresh.state_error or fingerprint(fresh) != before:
            self._trace(outcome="stale")
            self.routing.stale_decisions += 1
            raise StaleDecision("Browser changed during Jev selection; no action returned")

    def _accepted(self, decision):
        self._trace(decision=asdict(decision))
        if decision.choice in HANDOFFS:
            raise Handoff(decision.choice.lower())
        if decision.confidence < self.min_confidence:
            raise Handoff("low_confidence")
        return decision.choice

    async def _ask(self, context, questions, phase, *, flat=False):
        request = self.jev.build_questions_request(context, questions)
        request_chars = len(json.dumps(request, ensure_ascii=False))
        entry = {
            "phase": phase,
            "request": request,
            "request_chars": request_chars,
            "choice_counts": {key: len(q["criteria"]) for key, q in questions.items()},
            "submitted": False,
        }
        prior = self._decision_record.get("requests", [])
        self._trace(
            requests=[*prior, entry],
            request=request,
            request_chars=request_chars,
            request_submitted=False,
        )
        if request_chars > self.max_context_chars:
            raise Handoff("context_limit")
        entry = {**entry, "submitted": True}
        self._trace(
            requests=[*prior, entry],
            jev_requested=True,
            request_submitted=True,
            outcome="requesting",
        )
        self.routing.jev_calls += 1
        try:
            if flat:
                decision = await self.jev.choose(context, questions["next"]["criteria"])
                answers, elapsed_ms = {"next": decision}, decision.elapsed_ms
            else:
                result = await self.jev.choose_many(context, questions)
                answers, elapsed_ms = result.answers, result.elapsed_ms
        except JevError:
            self._trace(requests=[*prior, {**entry, "outcome": "jev_error"}], outcome="jev_error")
            self.routing.jev_errors += 1
            if self.jev_on_error == "raise":
                raise
            raise Handoff("jev_error") from None
        self.routing.jev_ms += elapsed_ms
        self._trace(
            requests=[*prior, {**entry, "answers": {k: asdict(v) for k, v in answers.items()}}],
            outcome="selected",
        )
        return answers

    def _target(self, pool, limit, description, context, dom_indices):
        target = target_question(pool, limit, description, dom_indices)
        # Full leaf labels can exceed the remaining body budget even when the
        # choice count fits. Split again, without removing any candidate/constraint.
        if (
            len(pool) > 1
            and not target.groups
            and len(
                json.dumps(
                    self.jev.build_questions_request(context, {"next": target.question}),
                    ensure_ascii=False,
                )
            )
            > self.max_context_chars
        ):
            target = target_question(pool, max(4, len(pool) // 2 + 2), description, dom_indices)
        return target

    async def _select(self, options, context, before, dom_indices):
        # The provider supports at most 255 total choices, including handoffs.
        limit = min(self.max_candidates, 255)
        if len(options) + len(HANDOFFS) <= limit:
            self._trace(routing_mode="flat")
            criteria = {f"a{i}": c.label for i, c in enumerate(options)} | HANDOFFS
            questions = self.jev.build_request(context, criteria)["questions"]
            answer = (await self._ask(context, questions, "flat", flat=True))["next"]
            return options[int(self._accepted(answer)[1:])]
        if limit < 4:
            raise Handoff("candidate_limit")
        route = operation_questions(options, limit, dom_indices)
        if route is None:
            raise Handoff("candidate_limit")
        questions, operations, targets = route
        self._trace(
            routing_mode="hierarchical",
            operation_counts={key: len(pool) for key, (_, pool) in operations.items()},
        )
        # Speculate on compatible targets in the same call when the complete body
        # fits. Otherwise defer target questions until the operation is known.
        if (
            len(
                json.dumps(self.jev.build_questions_request(context, questions), ensure_ascii=False)
            )
            > self.max_context_chars
        ):
            questions = {"operation": questions["operation"]}
            self._trace(routing_mode="hierarchical_serial")
        answers = await self._ask(context, questions, "operation")
        key = self._accepted(answers["operation"])
        description, pool = operations[key]
        self._trace(selected_operation=key, selection_path=[key])
        target = targets[key]
        answer = answers.get(key)
        while True:
            if answer is None:
                target = self._target(pool, limit, description, context, dom_indices)
                await self._fresh(before)
                answer = (await self._ask(context, {"next": target.question}, "target"))["next"]
            choice = self._accepted(answer)
            self._trace(selection_path=[*self._decision_record["selection_path"], choice])
            if choice in pool:
                return pool[choice]
            pool = target.groups[choice]
            answer = None

    async def get_model_output(self, input_messages):
        self._round += 1
        self._decision_record = {
            "round": self._round,
            "created_at": time.time(),
            "jev_requested": False,
            "min_confidence": self.min_confidence,
            "max_candidates": self.max_candidates,
        }
        self._trace(outcome="routing")
        page = self._jev_page
        if page is None or self.AgentOutput is self.DoneAgentOutput:
            return await self._host(input_messages, "upstream_required")
        if self.state.last_result and any(r.error for r in self.state.last_result):
            return await self._host(input_messages, "action_recovery")
        if self._jev_streak >= self.host_every:
            return await self._host(input_messages, "periodic_review")
        if page.state_error:
            return await self._host(input_messages, "observation_error")
        if not page.url or page.url == "about:blank":
            return await self._host(input_messages, "navigation_required")
        if self._last_jev_action is not None:
            last_fingerprint, _ = self._last_jev_action
            if fingerprint(page) == last_fingerprint:
                self._last_jev_action = None
                return await self._host(input_messages, "no_progress")
            self._last_jev_action = None
        options = candidates(page, self.ActionModel)
        if self.candidate_provider:
            extra = list(self.candidate_provider(page, self.ActionModel))
            for candidate in extra:
                if not isinstance(candidate, Candidate) or candidate.action is None:
                    raise ValueError("Custom candidates must be concrete Candidate actions")
                if len(candidate.action) != 1 or "done" in candidate.action:
                    raise ValueError(
                        "Candidates require one action; completion belongs to the host"
                    )
                self.ActionModel.model_validate(candidate.action)
            options.extend(extra)
        if self.allow_candidate:
            options = [c for c in options if self.allow_candidate(c)]
        self._trace(
            candidate_count=len(options),
            candidates={f"a{i}": asdict(c) for i, c in enumerate(options)},
        )
        if not options:
            return await self._host(input_messages, "candidate_limit")
        before = fingerprint(page)
        previous = self.state.last_model_output
        context = decision_context(
            messages=input_messages,
            system_text=self._jev_system_text,
            system_extension=self._jev_system_extension,
            state_message=self._message_manager.state.history.state_message,
            task=self.task,
            page=page,
            previous=previous,
            plan=self.state.plan,
            results=self.state.last_result,
        )
        self._trace(
            context_source=context["source"],
            input_text_chars=sum(len(m.text) for m in input_messages),
            context_chars=len(json.dumps(context, ensure_ascii=False)),
            max_context_chars=self.max_context_chars,
        )
        try:
            # Reference only nodes present in both the typed current DOM and the
            # actual Jev context. Unknown/custom-only labels stay in group questions.
            pattern = r"(?m)^[ \t]*\*?\[(\d+)\]<"
            observed = {int(i) for i in re.findall(pattern, page.dom_state.llm_representation())}
            context_text = "\n".join(m["text"] for m in context["messages"])
            if context["source"] == "typed_state":
                context_text += "\n" + context["dom"]
            present = {int(i) for i in re.findall(pattern, context_text)}
            option = await self._select(options, context, before, observed & present)
        except Handoff as handoff:
            return await self._host(input_messages, str(handoff))
        if option.action is None:
            return await self._host(input_messages, option.reason)
        await self._fresh(before)
        output = self.AgentOutput.model_validate(
            {
                "evaluation_previous_goal": "Not evaluated by Jev; inspect action results.",
                "memory": previous.memory if previous else "",
                "next_goal": "Inspect the result of the selected action and continue the task.",
                "action": [option.action],
            }
        )
        self._trace(outcome="action_returned", action=option.action)
        self._last_jev_action = (before, option.action)
        self.routing.jev_actions += 1
        self._jev_streak += 1
        return output
