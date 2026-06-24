"""Typed tool wrappers for better-mcp.

Provides convenience functions that wrap BetterMcpClient methods
with proper type annotations using the Pydantic models.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from .client import BetterMcpClient
from .models import (
    DirEntry,
    FileContent,
    FileWriteResult,
    GitDiffResult,
    GitLogEntry,
    GitStatus,
    ProjectInfo,
    QueryResult,
    ResourceResult,
    SchemaResult,
    SearchResult,
    ShellResult,
    WorkspaceProject,
)


class TypedBetterMcpClient(BetterMcpClient):
    """A typed wrapper around BetterMcpClient that returns Pydantic models."""

    async def read_file(
        self,
        path: str,
        offset: int = 1,
        limit: int = 500,
        project: Optional[str] = None,
    ) -> FileContent:
        data = await super().read_file(path, offset, limit, project)
        return FileContent.model_validate(data)

    async def write_file(
        self,
        path: str,
        content: str,
        project: Optional[str] = None,
        confirmation_token: Optional[str] = None,
    ) -> FileWriteResult:
        data = await super().write_file(path, content, project, confirmation_token)
        return FileWriteResult.model_validate(data)

    async def search_files(
        self,
        pattern: str,
        file_glob: Optional[str] = None,
        limit: int = 50,
        project: Optional[str] = None,
    ) -> SearchResult:
        data = await super().search_files(pattern, file_glob, limit, project)
        return SearchResult.model_validate(data)

    async def list_directory(
        self,
        path: str,
        project: Optional[str] = None,
    ) -> List[DirEntry]:
        data = await super().list_directory(path, project)
        return [DirEntry.model_validate(entry) for entry in data]

    async def query_db(
        self,
        sql: str,
        project: Optional[str] = None,
        confirmation_token: Optional[str] = None,
    ) -> QueryResult:
        data = await super().query_db(sql, project, confirmation_token)
        return QueryResult.model_validate(data)

    async def get_db_schema(
        self,
        schemas: Optional[List[str]] = None,
        project: Optional[str] = None,
    ) -> SchemaResult:
        data = await super().get_db_schema(schemas, project)
        return SchemaResult.model_validate(data)

    async def run_shell(
        self,
        command: str,
        project: Optional[str] = None,
        confirmation_token: Optional[str] = None,
    ) -> ShellResult:
        data = await super().run_shell(command, project, confirmation_token)
        return ShellResult.model_validate(data)

    async def run_shell_raw(
        self,
        command: str,
        timeout: int = 120,
        project: Optional[str] = None,
        confirmation_token: Optional[str] = None,
    ) -> ShellResult:
        data = await super().run_shell_raw(command, timeout, project, confirmation_token)
        return ShellResult.model_validate(data)

    async def git_status(
        self,
        project: Optional[str] = None,
    ) -> GitStatus:
        data = await super().git_status(project)
        return GitStatus.model_validate(data)

    async def git_log(
        self,
        limit: int = 10,
        project: Optional[str] = None,
    ) -> List[GitLogEntry]:
        data = await super().git_log(limit, project)
        return [GitLogEntry.model_validate(entry) for entry in data]

    async def git_diff(
        self,
        target: Optional[str] = None,
        project: Optional[str] = None,
    ) -> GitDiffResult:
        data = await super().git_diff(target, project)
        return GitDiffResult.model_validate(data)

    async def project_info(
        self,
        project: Optional[str] = None,
    ) -> ProjectInfo:
        data = await super().project_info(project)
        return ProjectInfo.model_validate(data)

    async def read_resource(
        self,
        name: str,
        project: Optional[str] = None,
    ) -> ResourceResult:
        data = await super().read_resource(name, project)
        return ResourceResult.model_validate(data)

    async def workspace_list_projects(self) -> List[WorkspaceProject]:
        data = await super().workspace_list_projects()
        return [WorkspaceProject.model_validate(p) for p in data]
