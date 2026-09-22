import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_installer(destination):
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts/install_skill.py"), "--skills-dir", str(destination)],
        capture_output=True,
        text=True,
    )


def test_install_is_live_link_and_repeatable(tmp_path):
    for _ in range(2):
        assert run_installer(tmp_path).returncode == 0
    link = tmp_path / "browser-use-with-jev"
    assert link.is_symlink()
    assert link.resolve() == ROOT / "skills/browser-use-with-jev"
    assert (link / "SKILL.md").read_bytes() == (link.resolve() / "SKILL.md").read_bytes()


def test_install_preserves_existing_skill(tmp_path):
    existing = tmp_path / "browser-use-with-jev"
    existing.mkdir()
    (existing / "SKILL.md").write_text("existing instructions")
    assert run_installer(tmp_path).returncode != 0
    assert (existing / "SKILL.md").read_text() == "existing instructions"
