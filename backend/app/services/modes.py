from __future__ import annotations

from dataclasses import dataclass

from ..config import Settings
from ..models import JobMode, ReasoningEffort, WorkspaceWriteStrategy


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
    sandbox_mode: str | None = None
    bypass_sandbox: bool = False


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
            sandbox_mode="read-only",
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
            sandbox_mode="workspace-write",
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
            bypass_sandbox=True,
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
    )


def list_mode_specs(settings: Settings) -> list[ModeSpec]:
    return [
        get_mode_spec(settings, JobMode.read_only),
        get_mode_spec(settings, JobMode.workspace_write),
    ]


def supports_native_resume(settings: Settings, mode: JobMode) -> bool:
    spec = get_mode_spec(settings, mode)
    if not spec.enabled:
        return False
    if mode == JobMode.read_only:
        return True
    return spec.bypass_sandbox


def _base_exec_prefix(settings: Settings, model: str, reasoning_effort: ReasoningEffort) -> list[str]:
    return [
        settings.codex_bin,
        "--config",
        f'model_reasoning_effort="{reasoning_effort.value}"',
        "--model",
        model,
    ]


def build_exec_command(
    settings: Settings,
    mode: JobMode,
    model: str,
    reasoning_effort: ReasoningEffort,
) -> list[str]:
    spec = get_mode_spec(settings, mode)
    if not spec.enabled:
        return []

    command = [
        settings.codex_bin,
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "-m",
        model,
        "-c",
        f'model_reasoning_effort="{reasoning_effort.value}"',
    ]

    if spec.bypass_sandbox:
        command.append("--dangerously-bypass-approvals-and-sandbox")
    elif spec.sandbox_mode:
        command.extend(["--sandbox", spec.sandbox_mode])

    command.append("-")
    return command


def build_resume_command(
    settings: Settings,
    mode: JobMode,
    model: str,
    reasoning_effort: ReasoningEffort,
    thread_id: str,
) -> list[str]:
    if not supports_native_resume(settings, mode):
        return []

    command = [
        settings.codex_bin,
        "exec",
        "resume",
        "--json",
        "-m",
        model,
        "-c",
        f'model_reasoning_effort="{reasoning_effort.value}"',
        "--skip-git-repo-check",
    ]

    spec = get_mode_spec(settings, mode)
    if spec.bypass_sandbox:
        command.append("--dangerously-bypass-approvals-and-sandbox")

    command.extend([thread_id, "-"])
    return command


def build_review_command(
    settings: Settings,
    mode: JobMode,
    model: str,
    reasoning_effort: ReasoningEffort,
) -> list[str]:
    command = [
        settings.codex_bin,
        "exec",
        "review",
        "--json",
        "--skip-git-repo-check",
        "-m",
        model,
        "-c",
        f'model_reasoning_effort="{reasoning_effort.value}"',
    ]

    spec = get_mode_spec(settings, mode)
    if spec.bypass_sandbox:
        command.append("--dangerously-bypass-approvals-and-sandbox")

    command.append("-")
    return command
