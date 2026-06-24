"""Tests for the better-mcp Python client.

Uses mocked HTTP responses to test client methods without a running server.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def mock_mcp_session():
    """Create a mocked MCP ClientSession."""
    session = AsyncMock()
    session.initialize = AsyncMock()
    session.call_tool = AsyncMock()
    return session


@pytest.fixture
def mock_sse_client():
    """Mock the sse_client context manager."""
    mock_streams = (MagicMock(), MagicMock())
    with patch("better_mcp.client.sse_client", autospec=True) as mock:
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_streams)
        mock.return_value = mock_ctx
        yield mock


@pytest.fixture
def mock_client_session():
    """Mock the ClientSession context manager."""
    with patch("better_mcp.client.ClientSession", autospec=True) as mock:
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session.call_tool = AsyncMock()

        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock.return_value = mock_ctx
        yield mock, mock_session


@pytest.mark.asyncio
async def test_read_file(mock_sse_client, mock_client_session):
    """Test reading a file via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"content": "hello world", "totalLines": 1, "fileSize": 11}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.read_file("test.txt")
        assert result["content"] == "hello world"
        assert result["totalLines"] == 1
        assert result["fileSize"] == 11

    mock_session.call_tool.assert_called_once_with("fs_read", {
        "path": "test.txt",
        "offset": 1,
        "limit": 500,
    })


@pytest.mark.asyncio
async def test_write_file(mock_sse_client, mock_client_session):
    """Test writing a file via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"path": "/tmp/test.txt", "bytesWritten": 11}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.write_file("test.txt", "hello world")
        assert result["path"] == "/tmp/test.txt"
        assert result["bytesWritten"] == 11

    mock_session.call_tool.assert_called_once_with("fs_write", {
        "path": "test.txt",
        "content": "hello world",
    })


@pytest.mark.asyncio
async def test_search_files(mock_sse_client, mock_client_session):
    """Test searching files via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"matches": [{"file": "test.txt", "line": 1, "content": "hello"}]}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.search_files("hello", file_glob="*.txt")
        assert len(result["matches"]) == 1
        assert result["matches"][0]["file"] == "test.txt"

    mock_session.call_tool.assert_called_once_with("fs_search", {
        "pattern": "hello",
        "fileGlob": "*.txt",
        "limit": 50,
    })


@pytest.mark.asyncio
async def test_list_directory(mock_sse_client, mock_client_session):
    """Test listing a directory via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='[{"name": "test.txt", "type": "file", "size": 100}]')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.list_directory("/tmp")
        assert len(result) == 1
        assert result[0]["name"] == "test.txt"

    mock_session.call_tool.assert_called_once_with("fs_list", {"path": "/tmp"})


@pytest.mark.asyncio
async def test_run_shell(mock_sse_client, mock_client_session):
    """Test running a shell command via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"stdout": "hello", "stderr": "", "exitCode": 0, "duration": 10}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.run_shell("build")
        assert result["stdout"] == "hello"
        assert result["exitCode"] == 0

    mock_session.call_tool.assert_called_once_with("shell_run", {"command": "build"})


@pytest.mark.asyncio
async def test_run_shell_raw(mock_sse_client, mock_client_session):
    """Test running a raw shell command."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"stdout": "done", "stderr": "", "exitCode": 0, "duration": 50}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.run_shell_raw("echo hello", timeout=30)
        assert result["stdout"] == "done"

    mock_session.call_tool.assert_called_once_with("shell_raw", {
        "command": "echo hello",
        "timeout": 30,
    })


@pytest.mark.asyncio
async def test_query_db(mock_sse_client, mock_client_session):
    """Test database query via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"columns": ["id", "name"], "rows": [{"id": 1, "name": "test"}], "rowCount": 1, "truncated": false}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.query_db("SELECT * FROM users")
        assert result["columns"] == ["id", "name"]
        assert result["rowCount"] == 1

    mock_session.call_tool.assert_called_once_with("db_query", {"sql": "SELECT * FROM users"})


@pytest.mark.asyncio
async def test_git_status(mock_sse_client, mock_client_session):
    """Test git status via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"branch": "main", "isClean": true, "staged": [], "unstaged": [], "untracked": [], "ahead": 0, "behind": 0, "lastCommit": null}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.git_status()
        assert result["branch"] == "main"
        assert result["isClean"] is True


@pytest.mark.asyncio
async def test_project_info(mock_sse_client, mock_client_session):
    """Test project info via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"project": "default", "name": "my-project", "description": "", "root": "/tmp", "stack": [], "directoryCount": 0, "fileCount": 0, "totalSizeBytes": 0, "hasConfig": {}, "enabledTools": [], "availableCommands": [], "resources": {}}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.project_info()
        assert result["project"] == "default"
        assert result["name"] == "my-project"


@pytest.mark.asyncio
async def test_workspace_tools(mock_sse_client, mock_client_session):
    """Test workspace tools via the client."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='[{"name": "default", "root": "/tmp", "stack": [], "description": "", "enabledTools": [], "availableCommands": [], "resources": {}}]')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.workspace_list_projects()
        assert len(result) == 1
        assert result[0]["name"] == "default"


@pytest.mark.asyncio
async def test_set_project(mock_sse_client, mock_client_session):
    """Test setting active project."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"activeProject": "default"}')],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.workspace_set_project("default")
        assert result["activeProject"] == "default"


@pytest.mark.asyncio
async def test_error_handling(mock_sse_client, mock_client_session):
    """Test that errors are properly raised."""
    mock_ctx, mock_session = mock_client_session
    mock_session.call_tool.return_value = MagicMock(
        isError=True,
        content=[MagicMock(text="File not found")],
    )

    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        with pytest.raises(RuntimeError, match="File not found"):
            await client.read_file("nonexistent.txt")


@pytest.mark.asyncio
async def test_not_connected_error():
    """Test that calling methods before connect raises RuntimeError."""
    from better_mcp.client import BetterMcpClient

    client = BetterMcpClient("http://localhost:3100")
    with pytest.raises(RuntimeError, match="not connected"):
        await client.read_file("test.txt")


@pytest.mark.asyncio
async def test_auth_tools(mock_sse_client, mock_client_session):
    """Test auth-related tools."""
    mock_ctx, mock_session = mock_client_session

    # auth_status
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"pending": [], "count": 0}')],
    )
    from better_mcp.client import BetterMcpClient

    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.auth_status()
        assert result["count"] == 0

    # auth_confirm
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"confirmed": true, "tool": "fs_write", "args": {"path": "test.txt"}}')],
    )
    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.auth_confirm("abc-123")
        assert result["confirmed"] is True

    # auth_reject
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        content=[MagicMock(text='{"rejected": true, "existed": true}')],
    )
    async with BetterMcpClient("http://localhost:3100") as client:
        result = await client.auth_reject("abc-123")
        assert result["rejected"] is True
