"""Install a live development link without overwriting an existing skill."""

import argparse
import os
from pathlib import Path


def install(destination: Path) -> Path:
    source = Path(__file__).resolve().parents[1] / "skills/browser-use-with-jev"
    if not (source / "SKILL.md").is_file():
        raise RuntimeError("Run the installer from a complete project checkout")
    target = destination.expanduser() / source.name
    if target.is_symlink() and target.resolve() == source:
        return target
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"Preserving existing skill at {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(source, target_is_directory=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skills-dir",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "skills",
    )
    args = parser.parse_args()
    print(f"Installed development skill: {install(args.skills_dir)}")


if __name__ == "__main__":
    main()
