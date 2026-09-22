"""Thin adapter: selection changes, upstream execution and tools remain intact."""

import json
from collections.abc import Callable
from dataclasses import dataclass, field

from browser_use import Agent
from browser_use.llm.messages import UserMessage

from .actions import Candidate, candidates, fingerprint
from .jev import JevClient, JevError


class StaleDecision(RuntimeError):
    """Browser changed during a decision. Let the next upstream step observe again."""


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
        self.routing = RoutingStats()
        self._jev_page = None
        self._jev_streak = 0
        super().__init__(*args, **kwargs)

    async def _get_next_action(self, browser_state_summary):
        # Only protected hook used. Pinned and covered by upstream contract tests.
        self._jev_page = browser_state_summary
        try:
            return await super()._get_next_action(browser_state_summary)
        finally:
            self._jev_page = None

    async def _host(self, messages, reason):
        self.routing.host_calls += 1
        self.routing.handoffs[reason] = self.routing.handoffs.get(reason, 0) + 1
        self._jev_streak = 0
        self.logger.info("Jev → host: %s", reason)
        hint = UserMessage(
            content=(
                f"Jev routing handoff: {reason}. Use the current browser evidence and the original "
                "task. Verify outcomes independently. Jev has not asserted task completion."
            )
        )
        return await super().get_model_output([*messages, hint])

    async def get_model_output(self, input_messages):
        page = self._jev_page
        if page is None or self.AgentOutput is self.DoneAgentOutput:
            return await self._host(input_messages, "upstream_required")
        if self.state.last_result and any(r.error for r in self.state.last_result):
            return await self._host(input_messages, "action_recovery")
        if self._jev_streak >= self.host_every:
            return await self._host(input_messages, "periodic_review")
        if page.state_error:
            return await self._host(input_messages, "observation_error")
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
        if not options or len(options) > self.max_candidates:
            return await self._host(input_messages, "candidate_limit")
        dom = page.dom_state.llm_representation()
        if len(dom) > self.max_context_chars:
            return await self._host(input_messages, "context_limit")
        before = fingerprint(page)
        criteria = {f"a{i}": c.label for i, c in enumerate(options)}
        criteria.update(
            HOST="Need planning, text generation, extraction, custom tools, or unsupported actions",
            VERIFY="Task appears complete; ask the host to independently verify and report",
        )
        previous = self.state.last_model_output
        context = {
            # Preserve upstream instructions and history; omit image bytes only.
            "messages": [{"role": m.role, "text": m.text} for m in input_messages],
            "task": self.task,
            "url": page.url,
            "title": page.title,
            "dom": dom,
            "memory": previous.memory if previous else None,
            "subgoal": previous.next_goal if previous else None,
            "plan": [p.model_dump() for p in self.state.plan or []],
            "last_action": [a.model_dump(exclude_none=True) for a in previous.action]
            if previous
            else [],
            "last_result": [r.model_dump(exclude_none=True) for r in self.state.last_result or []],
        }
        if len(json.dumps(context, ensure_ascii=False)) > self.max_context_chars:
            return await self._host(input_messages, "context_limit")
        self.routing.jev_calls += 1
        try:
            decision = await self.jev.choose(context, criteria)
        except JevError:
            self.routing.jev_errors += 1
            if self.jev_on_error == "raise":
                raise
            return await self._host(input_messages, "jev_error")
        self.routing.jev_ms += decision.elapsed_ms
        if decision.confidence < self.min_confidence:
            return await self._host(input_messages, "low_confidence")
        if decision.choice in {"HOST", "VERIFY"}:
            return await self._host(input_messages, decision.choice.lower())
        option = options[int(decision.choice[1:])]
        if option.action is None:
            return await self._host(input_messages, option.reason)
        fresh = await self.browser_session.get_browser_state_summary(
            cached=False, include_screenshot=False
        )
        if fresh.state_error or fingerprint(fresh) != before:
            self.routing.stale_decisions += 1
            raise StaleDecision("Browser changed during Jev selection; no action returned")
        output = self.AgentOutput.model_validate(
            {
                "evaluation_previous_goal": "Not evaluated by Jev; inspect action results.",
                "memory": previous.memory if previous else "",
                "next_goal": previous.next_goal if previous else self.task,
                "action": [option.action],
            }
        )
        self.routing.jev_actions += 1
        self._jev_streak += 1
        return output
