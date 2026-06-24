# better-mcp v0.2 — Release Plan

## What's done (v0.1)
- Server base with MCP protocol (initialize, list_tools, call_tool, resources)
- `fs_read`, `fs_write`, `fs_search`, `fs_list`
- `shell_run` (whitelist commands)
- `shell_raw` (restricted)
- `git_status`, `git_log`, `git_diff`
- `project_info`, `read_resource`
- `db_query`, `db_schema`
- Config loading from `better-mcp.json` with env var resolution
- Path safety for filesystem tools
- SQL injection protection via read-only mode

## What needs to happen for v0.2

### Phase 1 — Security & Hardening (Worker A)
- Sanitize all tool inputs (path traversal, command injection)
- Add file size limits
- Add proper error handling for edge cases
- Add db connection retry/fallback

### Phase 2 — Distribution (Worker B)
- Create Dockerfile (multi-stage, slim)
- Create docker-compose.yml for easy start
- Add .dockerignore
- Create npm publish config (package.json final)
- Add CHANGELOG.md

### Phase 3 — Testing (Worker C)
- Write vitest tests for config.ts
- Write vitest tests for tools/fs.ts
- Write vitest tests for tools/shell.ts
- Write vitest tests for tools/git.ts
- Write vitest tests for tools/project.ts
- Verify all pass

### Phase 4 — Documentation (Worker D)
- Update README with actual implemented features
- Add full CLI reference
- Add migration guide from older MCP setups
- Add `better-mcp.schema.json` for IDE autocompletion
