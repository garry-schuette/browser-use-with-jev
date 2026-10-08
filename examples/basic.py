"""Run the hybrid agent with a user-selected OpenAI-compatible host model."""

import argparse
import asyncio
import json
from dataclasses import asdict

from browser_use_with_jev.runtime import check_browser_runtime

check_browser_runtime()

from browser_use import ChatOpenAI  # noqa: E402

from browser_use_with_jev import JevAgent, JevClient  # noqa: E402


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    parser.add_argument("--model", required=True, help="Your host provider's model ID")
    parser.add_argument("--base-url", help="Optional OpenAI-compatible host endpoint")
    parser.add_argument("--jev-env", help="Explicit Jev credential file; otherwise use environment")
    parser.add_argument("--max-steps", type=int, default=20)
    args = parser.parse_args()
    model_options = {"model": args.model}
    if args.base_url:
        model_options["base_url"] = args.base_url
    agent = JevAgent(
        task=args.task,
        llm=ChatOpenAI(**model_options),
        jev=JevClient.from_env(args.jev_env),
    )
    history = await agent.run(max_steps=args.max_steps)
    print(history.final_result())
    print(json.dumps(asdict(agent.routing), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
