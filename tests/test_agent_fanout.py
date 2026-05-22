from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "agent_fanout.py"


def write_config(path: Path, python: str) -> Path:
    config = path / "config.toml"
    alpha_code = (
        "import sys; "
        "prompt=sys.stdin.read(); "
        "print('alpha:' + prompt.split('Task:', 1)[1].strip().splitlines()[0])"
    )
    beta_code = (
        "import pathlib; "
        "pathlib.Path('beta.txt').write_text('beta output' + chr(10)); "
        "print('beta done')"
    )
    alpha_command = json.dumps([python, "-c", alpha_code])
    beta_command = json.dumps([python, "-c", beta_code])
    config.write_text(
        f"""
default_agents = ["alpha", "beta"]
timeout_seconds = 30
workspace_mode = "copy"
capture_diff = true

[agents.alpha]
label = "Alpha Mock"
command = {alpha_command}
stdin = "{{prompt}}"

[agents.beta]
label = "Beta Mock"
command = {beta_command}
""".strip()
    )
    return config


def run_cli(tmp_path: Path, args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "scripts")
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_plan_collects_each_agent_raw_output(tmp_path: Path) -> None:
    config = write_config(tmp_path, sys.executable)
    result = run_cli(
        tmp_path,
        ["plan", "--config", str(config), "--task", "design the interface", "--json"],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["action"] == "plan"
    assert [item["agent"] for item in payload["results"]] == ["alpha", "beta"]
    assert "alpha:design the interface" in payload["results"][0]["stdout"]
    assert "beta done" in payload["results"][1]["stdout"]


def test_agent_override_runs_only_named_agent(tmp_path: Path) -> None:
    config = write_config(tmp_path, sys.executable)
    result = run_cli(
        tmp_path,
        ["plan", "--config", str(config), "--agents", "alpha", "--task", "narrow run", "--json"],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert [item["agent"] for item in payload["results"]] == ["alpha"]


def test_execute_uses_isolated_workspace_and_returns_diff(tmp_path: Path) -> None:
    config = write_config(tmp_path, sys.executable)
    source = tmp_path / "source"
    source.mkdir()
    (source / "existing.txt").write_text("original\n")
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=source, check=True)

    result = run_cli(
        tmp_path,
        [
            "execute",
            "--config",
            str(config),
            "--source",
            str(source),
            "--agents",
            "beta",
            "--task",
            "create beta file",
            "--json",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    beta = payload["results"][0]
    assert beta["workspace_is_copy"] is True
    assert "beta.txt" in beta["git_status"]
    assert "beta output" in beta["diff"]
    assert not (source / "beta.txt").exists()


def test_review_includes_artifact_content_in_prompt(tmp_path: Path) -> None:
    artifact = tmp_path / "change.patch"
    artifact.write_text("diff --git a/a.txt b/a.txt\n+important artifact line\n")
    config = tmp_path / "config.toml"
    reader_code = (
        "import sys; "
        "data=sys.stdin.read(); "
        "print('has artifact', 'important artifact line' in data)"
    )
    reader_command = json.dumps([sys.executable, "-c", reader_code])
    config.write_text(
        f"""
default_agents = ["reader"]

[agents.reader]
command = {reader_command}
stdin = "{{prompt}}"
""".strip()
    )
    result = run_cli(
        tmp_path,
        [
            "review",
            "--config",
            str(config),
            "--artifact",
            str(artifact),
            "--task",
            "review it",
            "--json",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert "has artifact True" in payload["results"][0]["stdout"]
