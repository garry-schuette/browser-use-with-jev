---
name: browser-use-with-jev
description: Use and iterate on Browser Use with Jev, the Python integration that retains upstream Browser Use execution while routing bounded choices to Jev. Use for browser tasks explicitly using this integration and for extending, testing, or debugging its decision routing and host-model handoffs.
---

# Browser Use with Jev

This is the `ZiyaoLi/browser-use-with-jev` project, not the community
`wy-coliney/jev-browser-use` Skill or Browser Use's `jev-ultrafast` demo.

## Locate and check the installation

Resolve this SKILL.md's real path. In the supported development installation it
is `<checkout>/skills/browser-use-with-jev/SKILL.md`; the personal skill entry is
a symlink. The checkout root is two directories above this skill directory.
Do not assume the user's current working directory is the checkout.

Run `python3 <skill-dir>/scripts/doctor.py` to check the checkout, virtualenv,
installed dependency version and required entrypoints without reading keys,
calling a model, or opening a browser. If dependencies are missing, use
`uv sync --locked` in the checkout. Read `<checkout>/README.md` for current SDK
usage and `<checkout>/docs/architecture.md` before changing integration behavior.

If this skill was copied without its checkout, do not guess paths: clone the
project and run its `scripts/install_skill.py` development installer. Preserve
any existing conflicting skill instead of overwriting it.

## Run a browser task

1. Use upstream Browser Use as the browser runtime. Keep the user's task and
   authorized effects intact. `JevAgent` accepts the original `browser`, `tools`,
   host `llm`, and other upstream options.
2. Load Jev credentials only from `TYPESAFE_API_KEY` or the file explicitly
   supplied by the user. `JevClient.from_env(path)` supports dotenv and raw-key
   files. Never print credentials, store them in this skill, or add them to Git.
3. A real host model is required for text generation, complex tools, recovery,
   and completion. If the user has configured an API-backed host, use
   `<checkout>/examples/basic.py` or the SDK. Pass task text through structured
   arguments or a safely written script rather than unsafe shell interpolation.
4. If the user wants the current Codex model to serve as the host, check the
   current README and runtime implementation. As shipped initially, `HostModel`
   is an async callback interface only; no Codex communication bridge exists.
   Do not claim the callback automatically uses this conversation, invent host
   replies, buy another API, or silently switch to a different browser project.
   Explain that specific missing bridge and implement it when requested.
5. Leave action execution and result history with Browser Use. Jev selects
   bounded candidates; it does not emit free-form browser code or verify success.
   Assess the final task from fresh evidence, not Jev's VERIFY choice alone.

Report task outcome and actual verification separately from routing metrics.
`jev_actions` counts selected actions, not successful execution;
`routing.host_calls` excludes auxiliary extraction/compaction/judge calls.
Do not claim a speedup or a majority of decisions without measured evidence.

## Iterate on this project

Make changes in the checkout; the symlink exposes them to later skill loads.
Keep Browser Use as a dependency. Avoid whole-repository vendoring and do not
patch installed site-packages. The protected upstream hook is version-pinned;
dependency upgrades need compatibility tests.

For a concrete routing failure, reproduce it, add a behavior test where useful,
fix the narrow cause, and run the relevant tests. Use the full suite for changes
to the routing or host contract:

```bash
uv run ruff check src tests examples scripts skills
uv run ruff format --check src tests examples scripts skills
uv run pytest -q
uv build
```

Tests use fake browser/API responses and no real keys. Real-browser or live-Jev
tests must be reported separately. On macOS, upstream import may require normal
display access outside a restricted sandbox.

Do not include local `.archive`, credentials, browser profiles, or private page
traces in commits or packages. Follow the user's current publishing instructions;
installation alone does not authorize committing or pushing future tasks.
