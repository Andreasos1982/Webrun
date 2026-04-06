from __future__ import annotations

from dataclasses import dataclass

from ..config import Settings
from ..models import JobMode, WorkspaceWriteStrategy


@dataclass(frozen=True)
class ModeSpec:
    mode: JobMode
    label: str
    enabled: bool
    dangerous: bool
    launch_strategy: str
    executor: str
    description: str
    reason: str | None
    command: list[str]


def get_mode_spec(settings: Settings, mode: JobMode) -> ModeSpec:
    if mode == JobMode.read_only:
        return ModeSpec(
            mode=mode,
            label="Read-Only Snapshot",
            enabled=True,
            dangerous=False,
            launch_strategy="snapshot",
            executor="codex-readonly-snapshot",
            description="Builds a bounded workspace snapshot and sends it to Codex in read-only mode.",
            reason=None,
            command=[
                settings.codex_bin,
                "exec",
                "--json",
                "--color",
                "never",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "-",
            ],
        )

    if settings.workspace_write_strategy == WorkspaceWriteStrategy.workspace_write:
        return ModeSpec(
            mode=mode,
            label="Workspace Write",
            enabled=True,
            dangerous=False,
            launch_strategy="live",
            executor="codex-live-workspace-write",
            description="Lets Codex inspect and edit the live workspace using the native workspace-write sandbox.",
            reason=None,
            command=[
                settings.codex_bin,
                "exec",
                "--json",
                "--color",
                "never",
                "--sandbox",
                "workspace-write",
                "--skip-git-repo-check",
                "-",
            ],
        )

    if settings.workspace_write_strategy == WorkspaceWriteStrategy.danger_full_access:
        return ModeSpec(
            mode=mode,
            label="Workspace Write",
            enabled=True,
            dangerous=True,
            launch_strategy="live",
            executor="codex-live-danger-full-access",
            description="Lets Codex inspect and edit the live workspace without the native sandbox. Use only on a trusted internal host.",
            reason="This host cannot use the native Codex workspace-write sandbox, so live writes run with full access.",
            command=[
                settings.codex_bin,
                "exec",
                "--json",
                "--color",
                "never",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "-",
            ],
        )

    return ModeSpec(
        mode=mode,
        label="Workspace Write",
        enabled=False,
        dangerous=False,
        launch_strategy="live",
        executor="disabled",
        description="Lets Codex inspect and edit the live workspace.",
        reason=(
            "Workspace-write jobs are disabled. On this VPS the native Codex sandbox currently fails "
            "with bubblewrap networking errors, so only read-only mode is enabled by default."
        ),
        command=[],
    )


def list_mode_specs(settings: Settings) -> list[ModeSpec]:
    return [
        get_mode_spec(settings, JobMode.read_only),
        get_mode_spec(settings, JobMode.workspace_write),
    ]
