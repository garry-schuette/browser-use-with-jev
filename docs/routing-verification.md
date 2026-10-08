# Bounded routing verification

Verified on 2026-09-23 against the pinned Browser Use 0.13.10 integration.

## Change and evidence

Large candidate pools no longer immediately hand off at 128 actions. The adapter
selects an operation and a compatible target/group, then descends through groups
until it has a concrete candidate. Small pools retain the flat path. This applies
the operation/target decomposition described by
[Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) and the independent
questions contract in [TypeSafe's fan-out documentation](https://docs.typesafe.ai/patterns/fan-out).
Group routing is this integration's implementation, not a copy of that browser runtime.

Offline tests cover full 303/424-candidate coverage, selection of a final target,
recursive groups, operation compatibility, text-input handoff, API response
validation, low confidence at different layers, stale observations between layers,
context-budget fallback, and the provider's 255-choice ceiling. Each question's
limit includes HOST/VERIFY. The expanded-DOM fixture retains all original context
and full final action labels while using indexed references at group layers.

## Previous Ctrip records, replayed offline

Six saved rounds from the earlier Ctrip session were replayed with a local synthetic
HTTP transport. The saved candidate pools and state text were retained. Indexed
references were reconstructed for built-in clicks/dropdown reads and checked against
the saved DOM; default system boilerplate and the previous routing hint were omitted,
matching the current context path. No real credentials, external model, or browser
actions were used. The mock selects a specified recorded candidate; this tests
coverage, routing and budgets, not Jev's semantic accuracy or a live hotel result.

| Saved pool | Rounds | Requests per selection | Largest submitted Choice | Largest request body |
| --- | ---: | ---: | ---: | ---: |
| 303 candidates | 4 | 2 | 43 choices | 21,673 characters |
| 424 candidates, expanded calendar | 2 | 4 | 65 choices | 39,722 characters |

All six replays returned their specified candidate without candidate/context-limit
handoff. The configured limits remained 128 total choices per question and 40,000
characters per complete request. Pool sizes were not reduced to those numbers:
the bounded choices are groups and final subsets, with all original candidates
still reachable. Character counts are Python JSON serialization lengths, not tokens
or a speed/cost measurement. Private page traces stay outside the repository.

## Live verification

The fresh Ctrip browser run was not started: automatic approval review rejected
using the saved Jev credential with live page observations without explicit approval
for that external data transfer. No fresh hotel-price or Haidian-filter completion
is claimed. Live Jev selection quality and final hotel results remain unverified.
