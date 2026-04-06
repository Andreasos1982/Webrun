from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import os
import tomllib

from .models import ReasoningEffort, WorkspaceWriteStrategy


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _split_origins(raw_value: str | None) -> list[str]:
    if not raw_value:
        return ["*"]
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def _parse_write_strategy(raw_value: str | None) -> WorkspaceWriteStrategy:
    if not raw_value:
        return WorkspaceWriteStrategy.disabled
    return WorkspaceWriteStrategy(raw_value.strip())


def _load_codex_config() -> dict[str, object]:
    config_path = Path.home() / ".codex" / "config.toml"
    if not config_path.exists():
        return {}

    try:
        with config_path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _parse_reasoning_effort(raw_value: str | None, fallback: ReasoningEffort) -> ReasoningEffort:
    if not raw_value:
        return fallback
    try:
        return ReasoningEffort(raw_value.strip())
    except ValueError:
        return fallback


def _parse_available_models(raw_value: str | None, default_model: str) -> list[str]:
    configured = [item.strip() for item in (raw_value or "").split(",") if item.strip()]
    if not configured:
        configured = [
            default_model,
            "gpt-5.3-codex",
            "gpt-5.3-codex-spark",
        ]

    deduped: list[str] = []
    for item in configured:
        if item not in deduped:
            deduped.append(item)

    if default_model not in deduped:
        deduped.insert(0, default_model)
    return deduped


@dataclass(frozen=True)
class Settings:
    project_root: Path
    workspace_root: Path
    data_root: Path
    jobs_root: Path
    frontend_dist_root: Path
    codex_bin: str
    cors_origins: list[str]
    workspace_write_strategy: WorkspaceWriteStrategy
    default_model: str
    available_models: list[str]
    default_reasoning_effort: ReasoningEffort


@lru_cache
def get_settings() -> Settings:
    project_root = PROJECT_ROOT
    workspace_root = Path(os.getenv("WORKSPACE_ROOT", project_root)).expanduser()
    data_root = Path(os.getenv("DATA_ROOT", project_root / "data")).expanduser()
    codex_config = _load_codex_config()
    config_default_model = str(codex_config.get("model") or "gpt-5.4")
    default_model = os.getenv("CODEX_DEFAULT_MODEL", config_default_model).strip() or "gpt-5.4"
    config_reasoning = str(codex_config.get("model_reasoning_effort") or ReasoningEffort.xhigh.value)
    default_reasoning_effort = _parse_reasoning_effort(
        os.getenv("CODEX_DEFAULT_REASONING_EFFORT", config_reasoning),
        fallback=ReasoningEffort.xhigh,
    )

    return Settings(
        project_root=project_root,
        workspace_root=workspace_root,
        data_root=data_root,
        jobs_root=data_root / "jobs",
        frontend_dist_root=project_root / "frontend" / "dist",
        codex_bin=os.getenv("CODEX_BIN", "codex"),
        cors_origins=_split_origins(os.getenv("CORS_ORIGINS")),
        workspace_write_strategy=_parse_write_strategy(os.getenv("WORKSPACE_WRITE_STRATEGY")),
        default_model=default_model,
        available_models=_parse_available_models(os.getenv("CODEX_AVAILABLE_MODELS"), default_model),
        default_reasoning_effort=default_reasoning_effort,
    )
