"""Python client for better-mcp.

Connects to a better-mcp server via HTTP/SSE transport and exposes
all MCP tools as typed, async Python methods.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, List, Optional

from mcp import ClientSession
from mcp.client.sse import sse_client


class BetterMcpClient:
    """Async MCP client for better-mcp.

    Connects to a running better-mcp HTTP server and provides
    typed Python methods for all tools.

    Usage:
        async with BetterMcpClient("http://localhost:3100") as client:
            content = await client.read_file("README.md")
            status = await client.git_status()
    """

    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._session: ClientSession | None = None
        self._streams_ctx = None
        self._session_ctx = None

    async def __aenter__(self) -> BetterMcpClient:
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> None:
        await self.close()

    async def connect(self) -> None:
        """Connect to the better-mcp server via SSE."""
        sse_url = f"{self._base_url}/mcp"
        self._streams_ctx = sse_client(sse_url)
        streams = await self._streams_ctx.__aenter__()
        self._session_ctx = ClientSession(*streams)
        self._session = await self._session_ctx.__aenter__()
        await self._session.initialize()

    async def close(self) -> None:
        """Close the MCP session and SSE connection."""
        if self._session_ctx is not None:
            await self._session_ctx.__aexit__(None, None, None)
            self._session_ctx = None
        if self._streams_ctx is not None:
            await self._streams_ctx.__aexit__(None, None, None)
            self._streams_ctx = None
        self._session = None

    # ── Low-level call ────────────────────────────────────────────────

    async def _call_tool(self, name: str, args: Dict[str, Any] | None = None) -> Any:
        """Call an MCP tool and return the parsed result."""
        if self._session is None:
            raise RuntimeError("Client not connected. Use 'async with' or call connect() first.")
        result = await self._session.call_tool(name, args or {})
        if result.isError:
            text = result.content[0].text if result.content else "Unknown error"
            raise RuntimeError(text)
        # The MCP SDK returns TextContent objects; extract the JSON text
        if result.content and hasattr(result.content[0], "text"):
            import json

            return json.loads(result.content[0].text)
        return result.content

    # ── Filesystem tools ──────────────────────────────────────────────

    async def read_file(
        self,
        path: str,
        offset: int = 1,
        limit: int = 500,
        project: str | None = None,
    ) -> Dict[str, Any]:
        """Read a file with pagination support.

        Args:
            path: File path (absolute or relative to project root).
            offset: Starting line number (1-indexed).
            limit: Maximum number of lines to return (max 2000).
            project: Project name (required for multi-project workspaces).

        Returns:
            Dict with content, totalLines, and fileSize.
        """
        args: Dict[str, Any] = {"path": path, "offset": offset, "limit": limit}
        if project:
            args["project"] = project
        return await self._call_tool("fs_read", args)

    async def write_file(
        self,
        path: str,
        content: str,
        project: str | None = None,
        confirmation_token: str | None = None,
    ) -> Dict[str, Any]:
        """Write content to a file. Creates directories if needed.

        Args:
            path: File path.
            content: File content.
            project: Project name (optional).
            confirmation_token: Required when auth mode is 'token'.

        Returns:
            Dict with path and bytesWritten.
        """
        args: Dict[str, Any] = {"path": path, "content": content}
        if project:
            args["project"] = project
        if confirmation_token:
            args["confirmationToken"] = confirmation_token
        return await self._call_tool("fs_write", args)

    async def search_files(
        self,
        pattern: str,
        file_glob: str | None = None,
        limit: int = 50,
        project: str | None = None,
    ) -> Dict[str, Any]:
        """Search files by regex pattern.

        Args:
            pattern: Regex pattern to search.
            file_glob: Optional file glob filter (e.g., "*.ts", "*.py").
            limit: Maximum number of results.
            project: Project name (optional).

        Returns:
            Dict with a matches list.
        """
        args: Dict[str, Any] = {"pattern": pattern, "limit": limit}
        if file_glob:
            args["fileGlob"] = file_glob
        if project:
            args["project"] = project
        return await self._call_tool("fs_search", args)

    async def list_directory(
        self,
        path: str,
        project: str | None = None,
    ) -> List[Dict[str, Any]]:
        """List directory contents.

        Args:
            path: Directory path.
            project: Project name (optional).

        Returns:
            List of directory entries with name, type, and size.
        """
        args: Dict[str, Any] = {"path": path}
        if project:
            args["project"] = project
        return await self._call_tool("fs_list", args)

    # ── Database tools ────────────────────────────────────────────────

    async def query_db(
        self,
        sql: str,
        project: str | None = None,
        confirmation_token: str | None = None,
    ) -> Dict[str, Any]:
        """Execute a SQL query against the project database.

        Args:
            sql: SQL query (only SELECT/WITH in read-only mode).
            project: Project name (optional).
            confirmation_token: Required when auth mode is 'token'.

        Returns:
            Dict with columns, rows, rowCount, and truncated.
        """
        args: Dict[str, Any] = {"sql": sql}
        if project:
            args["project"] = project
        if confirmation_token:
            args["confirmationToken"] = confirmation_token
        return await self._call_tool("db_query", args)

    async def get_db_schema(
        self,
        schemas: List[str] | None = None,
        project: str | None = None,
    ) -> Dict[str, Any]:
        """Get the complete database schema.

        Args:
            schemas: Optional list of schema names to filter.
            project: Project name (optional).

        Returns:
            Dict with a tables list.
        """
        args: Dict[str, Any] = {}
        if schemas:
            args["schemas"] = schemas
        if project:
            args["project"] = project
        return await self._call_tool("db_schema", args)

    # ── Shell tools ──────────────────────────────────────────────────

    async def run_shell(
        self,
        command: str,
        project: str | None = None,
        confirmation_token: str | None = None,
    ) -> Dict[str, Any]:
        """Run a predefined command from the project config.

        Args:
            command: Name of the predefined command.
            project: Project name (optional).
            confirmation_token: Required when auth mode is 'token'.

        Returns:
            Dict with stdout, stderr, exitCode, and duration.
        """
        args: Dict[str, Any] = {"command": command}
        if project:
            args["project"] = project
        if confirmation_token:
            args["confirmationToken"] = confirmation_token
        return await self._call_tool("shell_run", args)

    async def run_shell_raw(
        self,
        command: str,
        timeout: int = 120,
        project: str | None = None,
        confirmation_token: str | None = None,
    ) -> Dict[str, Any]:
        """Execute an arbitrary shell command.

        Args:
            command: Shell command to execute.
            timeout: Timeout in seconds (max 3600).
            project: Project name (optional).
            confirmation_token: Required when auth mode is 'token'.

        Returns:
            Dict with stdout, stderr, exitCode, and duration.
        """
        args: Dict[str, Any] = {"command": command, "timeout": timeout}
        if project:
            args["project"] = project
        if confirmation_token:
            args["confirmationToken"] = confirmation_token
        return await self._call_tool("shell_raw", args)

    # ── Git tools ────────────────────────────────────────────────────

    async def git_status(self, project: str | None = None) -> Dict[str, Any]:
        """Get the current git status.

        Args:
            project: Project name (optional).

        Returns:
            Dict with branch, isClean, staged, unstaged, untracked, etc.
        """
        args: Dict[str, Any] = {}
        if project:
            args["project"] = project
        return await self._call_tool("git_status", args)

    async def git_log(
        self,
        limit: int = 10,
        project: str | None = None,
    ) -> List[Dict[str, Any]]:
        """Get recent commit history.

        Args:
            limit: Maximum number of commits (default 10, max 1000).
            project: Project name (optional).

        Returns:
            List of commit entries with hash, message, author, date.
        """
        args: Dict[str, Any] = {"limit": limit}
        if project:
            args["project"] = project
        return await self._call_tool("git_log", args)

    async def git_diff(
        self,
        target: str | None = None,
        project: str | None = None,
    ) -> Dict[str, Any]:
        """Get diff of changes.

        Args:
            target: Git ref to diff against (default: HEAD).
            project: Project name (optional).

        Returns:
            Dict with files list and patch string.
        """
        args: Dict[str, Any] = {}
        if target:
            args["target"] = target
        if project:
            args["project"] = project
        return await self._call_tool("git_diff", args)

    # ── Project tools ──────────────────────────────────────────────────

    async def project_info(self, project: str | None = None) -> Dict[str, Any]:
        """Get comprehensive project information.

        Args:
            project: Project name (optional).

        Returns:
            Dict with project metadata, file counts, config detection, etc.
        """
        args: Dict[str, Any] = {}
        if project:
            args["project"] = project
        return await self._call_tool("project_info", args)

    async def read_resource(
        self,
        name: str,
        project: str | None = None,
    ) -> Dict[str, Any]:
        """Read a project resource file (handoff, plan, schema, etc.).

        Args:
            name: Resource name.
            project: Project name (optional).

        Returns:
            Dict with name, content, and path.
        """
        args: Dict[str, Any] = {"name": name}
        if project:
            args["project"] = project
        return await self._call_tool("read_resource", args)

    # ── Workspace tools ──────────────────────────────────────────────

    async def workspace_list_projects(self) -> List[Dict[str, Any]]:
        """List all configured projects.

        Returns:
            List of project objects with name, root, stack, etc.
        """
        return await self._call_tool("workspace_list_projects")

    async def workspace_set_project(self, name: str) -> Dict[str, Any]:
        """Set the active project for subsequent tool calls.

        Args:
            name: Project name to set as active.

        Returns:
            Dict with the activeProject name.
        """
        return await self._call_tool("workspace_set_project", {"name": name})

    # ── Auth tools ───────────────────────────────────────────────────

    async def auth_confirm(self, confirmation_id: str) -> Dict[str, Any]:
        """Approve a pending destructive operation.

        Args:
            confirmation_id: The confirmation ID from a blocked tool response.

        Returns:
            Dict with confirmed status, tool name, and args.
        """
        return await self._call_tool(
            "auth_confirm", {"confirmationId": confirmation_id}
        )

    async def auth_reject(self, confirmation_id: str) -> Dict[str, Any]:
        """Reject/cancel a pending destructive operation.

        Args:
            confirmation_id: The confirmation ID to reject.

        Returns:
            Dict with rejected status.
        """
        return await self._call_tool(
            "auth_reject", {"confirmationId": confirmation_id}
        )

    async def auth_status(self) -> Dict[str, Any]:
        """List all currently pending confirmations.

        Returns:
            Dict with pending list and count.
        """
        return await self._call_tool("auth_status")
