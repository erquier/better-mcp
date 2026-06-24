# better-mcp Python Client

A Python client for [better-mcp](https://github.com/erquier/better-mcp) — an MCP server that lets AI agents interact with any project through filesystem, database, shell, git, and project tools.

## Installation

```bash
pip install better-mcp
```

Or with dev dependencies:

```bash
pip install "better-mcp[dev]"
```

## Quick Start

Make sure you have a better-mcp server running first:

```bash
# Start better-mcp in HTTP mode
npx better-mcp --http
```

Then connect from Python:

```python
import asyncio
from better_mcp import BetterMcpClient


async def main():
    async with BetterMcpClient("http://localhost:3100") as client:
        # Read a file
        content = await client.read_file("README.md")
        print(f"File has {content['totalLines']} lines")

        # Git status
        status = await client.git_status()
        print(f"On branch: {status['branch']}")

        # Search files
        results = await client.search_files("TODO", file_glob="*.py")
        print(f"Found {len(results['matches'])} matches")

        # List projects
        projects = await client.workspace_list_projects()
        print(f"Projects: {[p['name'] for p in projects]}")


asyncio.run(main())
```

## Using Typed Models

For type-safe access with Pydantic models:

```python
import asyncio
from better_mcp.tools import TypedBetterMcpClient
from better_mcp.models import FileContent, GitStatus


async def main():
    async with TypedBetterMcpClient("http://localhost:3100") as client:
        content: FileContent = await client.read_file("README.md")
        print(f"File has {content.totalLines} lines, size: {content.fileSize} bytes")

        status: GitStatus = await client.git_status()
        print(f"Branch: {status.branch}, clean: {status.isClean}")


asyncio.run(main())
```

## Available Methods

### Filesystem
| Method | Description |
|--------|-------------|
| `read_file(path, offset=1, limit=500)` | Read a file with pagination |
| `write_file(path, content)` | Write content to a file |
| `search_files(pattern, file_glob=None, limit=50)` | Search files by regex |
| `list_directory(path)` | List directory contents |

### Database
| Method | Description |
|--------|-------------|
| `query_db(sql)` | Execute a SQL query |
| `get_db_schema(schemas=None)` | Get database schema |

### Shell
| Method | Description |
|--------|-------------|
| `run_shell(command)` | Run a predefined command |
| `run_shell_raw(command, timeout=120)` | Execute arbitrary shell command |

### Git
| Method | Description |
|--------|-------------|
| `git_status()` | Get repository status |
| `git_log(limit=10)` | Get commit history |
| `git_diff(target=None)` | Get diff of changes |

### Project & Workspace
| Method | Description |
|--------|-------------|
| `project_info()` | Get project information |
| `read_resource(name)` | Read a project resource |
| `workspace_list_projects()` | List all configured projects |
| `workspace_set_project(name)` | Set active project |

### Auth
| Method | Description |
|--------|-------------|
| `auth_confirm(confirmation_id)` | Approve pending operation |
| `auth_reject(confirmation_id)` | Reject pending operation |
| `auth_status()` | List pending confirmations |

## Multi-Project Workspaces

When the server has multiple projects configured, pass the `project` parameter:

```python
await client.read_file("src/main.ts", project="backend")
await client.query_db("SELECT * FROM users", project="backend")
```

## Error Handling

All methods raise `RuntimeError` on server errors:

```python
try:
    result = await client.read_file("nonexistent.txt")
except RuntimeError as e:
    print(f"Error: {e}")
```

## Auth Modes

When better-mcp is configured with auth (token or interactive mode), pass the `confirmation_token` parameter for destructive operations:

```python
await client.write_file("path/to/file", "content", confirmation_token="your-token")
```

## Development

```bash
# Install with dev dependencies
pip install "better-mcp[dev]"

# Run tests
cd python
pytest -v

# Run tests with coverage
pytest --cov=better_mcp
```
