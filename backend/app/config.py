from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import os

from .models import WorkspaceWriteStrategy


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _split_origins(raw_value: str | None) -> list[str]:
    if not raw_value:
        return ["*"]
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def _parse_write_strategy(raw_value: str | None) -> WorkspaceWriteStrategy:
    if not raw_value:
        return WorkspaceWriteStrategy.disabled
    return WorkspaceWriteStrategy(raw_value.strip())


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


@lru_cache
def get_settings() -> Settings:
    project_root = PROJECT_ROOT
    workspace_root = Path(os.getenv("WORKSPACE_ROOT", project_root)).expanduser()
    data_root = Path(os.getenv("DATA_ROOT", project_root / "data")).expanduser()

    return Settings(
        project_root=project_root,
        workspace_root=workspace_root,
        data_root=data_root,
        jobs_root=data_root / "jobs",
        frontend_dist_root=project_root / "frontend" / "dist",
        codex_bin=os.getenv("CODEX_BIN", "codex"),
        cors_origins=_split_origins(os.getenv("CORS_ORIGINS")),
        workspace_write_strategy=_parse_write_strategy(os.getenv("WORKSPACE_WRITE_STRATEGY")),
    )
