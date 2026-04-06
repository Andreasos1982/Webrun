from __future__ import annotations

from pathlib import Path


TEXT_SUFFIXES = {
    ".css",
    ".env",
    ".html",
    ".js",
    ".json",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}

ROOT_PRIORITY = {
    "README.md",
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "vite.config.ts",
    "tsconfig.json",
}

IGNORED_PARTS = {
    ".git",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "data",
    "logs",
}


class WorkspaceSnapshotBuilder:
    def __init__(
        self,
        workspace_root: Path,
        max_files: int = 200,
        max_total_chars: int = 40000,
        max_file_chars: int = 9000,
    ) -> None:
        self.workspace_root = workspace_root
        self.max_files = max_files
        self.max_total_chars = max_total_chars
        self.max_file_chars = max_file_chars

    def build(self, task: str) -> str:
        files = self._collect_files()
        top_level_files, top_level_dirs = self._top_level_entries()
        selected_files = self._select_files(files)

        parts = [
            f"Workspace root: {self.workspace_root}",
            f"User task: {task}",
            "",
            "Top-level files:",
            *(f"- {item}" for item in top_level_files),
            "",
            "Top-level directories:",
            *(f"- {item}" for item in top_level_dirs),
            "",
            f"Visible workspace files ({min(len(files), self.max_files)} shown):",
            *(f"- {item}" for item in files[: self.max_files]),
            "",
            "Selected file excerpts:",
        ]

        remaining = self.max_total_chars
        for relative_path in selected_files:
            excerpt = self._read_excerpt(relative_path)
            if not excerpt:
                continue
            if remaining <= 0:
                break
            excerpt = excerpt[:remaining]
            parts.extend(
                [
                    f"--- {relative_path} ---",
                    excerpt,
                    "",
                ]
            )
            remaining -= len(excerpt)

        return "\n".join(parts).strip()

    def _collect_files(self) -> list[str]:
        files: list[str] = []
        for path in self.workspace_root.rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(self.workspace_root)
            if any(part in IGNORED_PARTS for part in relative.parts):
                continue
            files.append(relative.as_posix())
        return sorted(files)

    def _top_level_entries(self) -> tuple[list[str], list[str]]:
        files: list[str] = []
        directories: list[str] = []
        for path in sorted(self.workspace_root.iterdir(), key=lambda item: item.name):
            if path.name in IGNORED_PARTS:
                continue
            if path.is_dir():
                directories.append(path.name)
            elif path.is_file():
                files.append(path.name)
        return files, directories

    def _select_files(self, files: list[str]) -> list[str]:
        ranked = sorted(files, key=self._sort_key)
        selected: list[str] = []
        total_chars = 0

        for relative_path in ranked:
            excerpt = self._read_excerpt(relative_path)
            if not excerpt:
                continue
            excerpt_length = min(len(excerpt), self.max_file_chars)
            if total_chars + excerpt_length > self.max_total_chars:
                continue
            selected.append(relative_path)
            total_chars += excerpt_length
            if len(selected) >= 18:
                break

        return selected

    def _sort_key(self, relative_path: str) -> tuple[int, str]:
        path = Path(relative_path)
        suffix = path.suffix.lower()
        name = path.name

        if relative_path in ROOT_PRIORITY or name in ROOT_PRIORITY:
            return (0, relative_path)
        if name.lower().startswith("readme"):
            return (1, relative_path)
        if relative_path.startswith("docs/") and suffix == ".md":
            return (2, relative_path)
        if relative_path.startswith("backend/") and suffix == ".py":
            return (3, relative_path)
        if relative_path.startswith("frontend/src/") and suffix in {".ts", ".tsx", ".css"}:
            return (4, relative_path)
        if relative_path.startswith("frontend/") and suffix in {".json", ".ts", ".html"}:
            return (5, relative_path)
        if suffix in TEXT_SUFFIXES:
            return (6, relative_path)
        return (10, relative_path)

    def _read_excerpt(self, relative_path: str) -> str:
        path = self.workspace_root / relative_path
        suffix = path.suffix.lower()
        if suffix not in TEXT_SUFFIXES and path.name not in ROOT_PRIORITY:
            return ""
        try:
            contents = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return ""
        return contents[: self.max_file_chars].strip()
