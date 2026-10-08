"""Reuse upstream's current, redacted state instead of maintaining a second history."""


def decision_context(
    *, messages, system_text, system_extension, state_message, task, page, previous, plan, results
):
    # Strip only the exact default prompt captured at initialization. Unknown or
    # replaced system messages are constraints, not boilerplate, and stay intact.
    compact = []
    has_state = False
    for message in messages:
        text = message.text
        if message.role == "system" and system_text is not None and text == system_text:
            text = system_extension or ""
        if message is state_message:
            has_state = True
        if text:
            compact.append({"role": message.role, "text": text})

    context = {"version": 2, "messages": compact}
    if has_state:
        # The upstream state already contains task, history/compacted memory,
        # todo, plan, read-once results, tabs, scroll position and indexed DOM.
        # Keep its filtering/redaction, and do not parse page-controlled XML tags.
        context["source"] = "upstream_state"
        return context

    # Direct SDK calls without the upstream state slot still need typed evidence.
    context.update(
        source="typed_state",
        task=task,
        url=page.url,
        title=page.title,
        dom=page.dom_state.llm_representation(),
        tabs=[{"id": t.target_id[-4:], "url": t.url, "title": t.title} for t in page.tabs],
        scroll={"pixels_above": page.pixels_above, "pixels_below": page.pixels_below},
        memory=previous.memory if previous else None,
        subgoal=previous.next_goal if previous else None,
        plan=[p.model_dump() for p in plan or []],
        last_action=[a.model_dump(exclude_none=True) for a in previous.action] if previous else [],
        last_result=[r.model_dump(exclude_none=True) for r in results or []],
    )
    return context
