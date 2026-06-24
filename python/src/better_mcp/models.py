"""Pydantic models for better-mcp tool inputs and outputs."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class FileContent(BaseModel):
    """Result of reading a file."""

    content: str = Field(description="File content (paginated)")
    totalLines: int = Field(description="Total number of lines in the file")
    fileSize: int = Field(description="File size in bytes")


class FileWriteResult(BaseModel):
    """Result of writing to a file."""

    path: str = Field(description="Absolute path of the written file")
    bytesWritten: int = Field(description="Number of bytes written")


class SearchMatch(BaseModel):
    """A single search match."""

    file: str = Field(description="File path")
    line: int = Field(description="Line number")
    content: str = Field(description="Matched line content")


class SearchResult(BaseModel):
    """Result of searching files."""

    matches: List[SearchMatch] = Field(description="List of search matches")


class DirEntry(BaseModel):
    """A directory entry."""

    name: str = Field(description="Entry name")
    type: str = Field(description="Entry type: file, dir, or symlink")
    size: int = Field(description="File size in bytes")


class ShellResult(BaseModel):
    """Result of executing a shell command."""

    stdout: str = Field(description="Standard output")
    stderr: str = Field(description="Standard error")
    exitCode: int = Field(description="Exit code")
    duration: int = Field(description="Execution duration in milliseconds")


class QueryResult(BaseModel):
    """Result of a database query."""

    columns: List[str] = Field(description="Column names")
    rows: List[Dict[str, Any]] = Field(description="Query result rows")
    rowCount: int = Field(description="Number of rows returned")
    truncated: bool = Field(description="Whether results were truncated")


class SchemaColumn(BaseModel):
    """A database column definition."""

    name: str
    type: str
    nullable: bool
    default: Optional[str] = None
    isPrimaryKey: bool = False


class SchemaTable(BaseModel):
    """A database table definition."""

    schema_: str = Field(alias="schema", description="Schema name")
    name: str
    columns: List[SchemaColumn]
    indexes: List[str]
    rowCountEstimate: int

    model_config = {"populate_by_name": True}


class SchemaResult(BaseModel):
    """Result of a database schema query."""

    tables: List[SchemaTable]


class GitLastCommit(BaseModel):
    """Last commit info."""

    hash: str
    message: str
    author: str
    date: str


class GitStatus(BaseModel):
    """Git repository status."""

    branch: str
    isClean: bool
    staged: List[str]
    unstaged: List[str]
    untracked: List[str]
    ahead: int
    behind: int
    lastCommit: Optional[GitLastCommit] = None


class GitLogEntry(BaseModel):
    """A single git log entry."""

    hash: str
    message: str
    author: str
    date: str


class GitDiffResult(BaseModel):
    """Result of a git diff."""

    files: List[str]
    patch: str


class ProjectInfo(BaseModel):
    """Comprehensive project information."""

    project: str
    name: str
    description: str
    root: str
    stack: List[str]
    directoryCount: int
    fileCount: int
    totalSizeBytes: int
    hasConfig: Dict[str, bool]
    enabledTools: List[str]
    availableCommands: List[str]
    resources: Dict[str, str]


class ResourceResult(BaseModel):
    """A read resource result."""

    name: str
    content: str
    path: str


class WorkspaceProject(BaseModel):
    """A project in the workspace."""

    name: str
    root: str
    stack: List[str]
    description: str
    enabledTools: List[str]
    availableCommands: List[str]
    resources: Dict[str, str]


class AuthConfirmation(BaseModel):
    """A pending auth confirmation."""

    id: str
    tool: str
    prompt: str
    args: Dict[str, Any]
    createdAt: str
