# Changelog

## 1.0.0 — Full Release 🚀

### 🆕 v1.0 — New Features
- **Auth gates**: 4 security modes — `auto` (default), `confirm` (soft-block), `token` (confirmation token), `interactive` (SSE events)
  - `auth_confirm`, `auth_reject`, `auth_status` tools for managing pending confirmations
  - Destructive operations (fs_write, shell_raw, deploy commands) require approval
- **Workspace mode**: `workspace_list_projects`, `workspace_set_project` tools
- **Python SDK**: `pip install better-mcp` — async client with typed Pydantic models
  - `BetterMcpClient` and `TypedBetterMcpClient` wrappers
  - Full test suite (15 tests)
- **Plugin system**: Custom tool plugins without modifying core
  - Plugin discovery from `plugins/` directory
  - Allowlist-based loading
  - `plugin_<name>_<tool>` naming convention
  - Example plugin (echo, greet)
- **Multi-project config**: `projects[]` array in config for monorepo support
  - Each project has independent tools, paths, and resources
  - Tools accept optional `project` parameter

### 🔧 v0.3 — Improvements
- **HTTP/SSE transport**: Zero external dependencies (Node.js built-in `http` module)
  - `GET /health`, `GET /mcp` (SSE), `POST /mcp` (messages)
  - CORS headers, configurable port (default 3100)
  - `--http` and `--port` CLI flags
- **CI/CD**: GitHub Actions workflow
  - Matrix test across Node 18/20/22
  - Automatic npm publish on master push
  - Dependabot auto-updates

### 🛡️ v0.2 — Security & Distribution
- Security hardening: path traversal protection, command injection prevention, SQL injection prevention
- Docker multi-stage build (node:20-alpine)
- 101 vitest tests (5 test files)
- JSON Schema for IDE autocomplete
- CONTRIBUTING.md

### 🎯 v0.1 — Initial Release
- Config `better-mcp.json` with env var resolution
- MCP server with stdio transport
- Filesystem tools: read, write, search, list
- Shell tools: run commands, raw shell (configurable)
- Git tools: status, log, diff
- Project tools: info, read resource
