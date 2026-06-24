# Contributing to better-mcp

Thanks for your interest in better-mcp! Contributions are welcome and appreciated.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)
- [Adding a New Tool](#adding-a-new-tool)
- [Commit Messages](#commit-messages)

## Code of Conduct

This project follows a simple standard: **be respectful, constructive, and professional.** We're all here to build something useful.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/better-mcp.git
   cd better-mcp
   ```
3. **Add the upstream remote** (optional, for syncing):
   ```bash
   git remote add upstream https://github.com/erquier/better-mcp.git
   ```

## Development Setup

### Prerequisites

- **Node.js 18+** (LTS recommended)
- **pnpm** (install via `corepack enable && corepack prepare pnpm@latest --activate` or `npm install -g pnpm`)
- **ripgrep** (`rg`) — required for `fs_search` tests:
  - macOS: `brew install ripgrep`
  - Debian/Ubuntu: `sudo apt install ripgrep`
  - Alpine: `apk add ripgrep`
  - Windows: `winget install BurntSushi.ripgrep` or `choco install ripgrep`

### Install Dependencies

```bash
pnpm install
```

### Build

```bash
pnpm build
```

### Development Mode (watch)

```bash
pnpm dev
```

This runs `tsc --watch`, recompiling on every file change.

### Run the Server Locally

```bash
# Loads better-mcp.json from the current directory
node dist/index.js

# Or with a custom config path
node dist/index.js path/to/better-mcp.json
```

## Project Structure

```
better-mcp/
├── src/
│   ├── index.ts              # Entry point — CLI argument parsing
│   ├── server.ts             # MCP server — tool/resource registration + request dispatch
│   ├── config.ts             # Config loading, validation, env var resolution
│   ├── tools/
│   │   ├── fs.ts             # Filesystem tools (read, write, search, list)
│   │   ├── db.ts             # Database tools (query, schema)
│   │   ├── shell.ts          # Shell tools (predefined + raw commands)
│   │   ├── git.ts            # Git tools (status, log, diff)
│   │   └── project.ts        # Project info + resource reading
│   └── __tests__/
│       ├── config.test.ts
│       ├── fs.test.ts
│       ├── git.test.ts
│       ├── project.test.ts
│       └── shell.test.ts
├── test-config.json           # Test config fixture
├── better-mcp.schema.json     # JSON Schema for IDE autocompletion
├── Dockerfile                 # Multi-stage Docker build
├── vitest.config.ts           # Test runner configuration
└── tsconfig.json              # TypeScript strict mode config
```

## Running Tests

We use **Vitest** for testing.

```bash
# Run all tests
pnpm test

# Run with watch mode (useful during development)
npx vitest

# Run a specific test file
npx vitest src/__tests__/config.test.ts

# Run tests with coverage
npx vitest --coverage

# Run TypeScript type-check only (no tests)
npx tsc --noEmit
```

Tests are auto-discovered from `src/**/__tests__/**/*.test.ts`. Each test file mirrors the tool module it tests.

Some tests require:
- A **git repository** (git tests skip gracefully if not in a repo).
- **ripgrep** installed (fs_search tests skip if `rg` is not available).

## Code Style

- **Language:** TypeScript (strict mode).
- **Config:** `tsconfig.json` has `"strict": true`.
- **Target:** ES2022, module ES2022.
- **Formatting:** No automatic formatter is configured — keep it clean and consistent.
- **Imports:** Use ES module imports with `.js` extensions (e.g., `import { x } from "./config.js"`).
- **No `any`:** Avoid `any` where possible. Use `unknown` and narrow with type guards.
- **Async:** Use `async/await` over raw promises. Prefer synchronous APIs in tool implementations (they run in a server request handler).
- **Error handling:** Throw descriptive `Error` instances with clear messages. Tool errors are caught in `server.ts` and returned as MCP error responses.
- **Naming:**
  - Files and directories: `kebab-case.ts`
  - Functions: `camelCase`
  - Types/interfaces: `PascalCase`
  - Tool names (used by AI agents): `snake_case` (e.g., `fs_read`, `shell_run`)
- **Comments:** JSDoc-style comments on exported functions.
- **No console.log in production code:** Use `console.error` for server diagnostics (stdout is the MCP transport).
- **Security:** Validate all user-provided inputs (paths, commands, SQL, patterns). Use `execFileSync` with arguments arrays over `execSync` with strings to prevent command injection.

### TypeScript Strict Mode Checklist

All of these are already enforced:
- [x] `strict: true` in tsconfig
- [x] No implicit `any`
- [x] Strict null checks
- [x] Exact `unknown` for catch clauses
- [x] No unchecked indexed access

## Pull Request Process

1. **Create an issue** first (or comment on an existing one) to discuss the change you want to make. This avoids wasted effort on something that might not be accepted.

2. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

3. **Make your changes**:
   - Write tests for new functionality.
   - Ensure all existing tests still pass (`pnpm test`).
   - Ensure `npx tsc --noEmit` reports zero errors.

4. **Commit your changes** (see [Commit Messages](#commit-messages) below).

5. **Push your branch** and open a Pull Request on GitHub.

6. **In the PR description**, include:
   - What the change does.
   - Why it's needed.
   - How to test it (if not obvious from tests).
   - Any breaking changes or migration notes.

7. **CI checks** must pass:
   - TypeScript type-check (`npx tsc --noEmit`)
   - All tests pass (`pnpm test`)
   - No lint warnings (if configured)

8. **Review**: At least one maintainer must approve before merging.

9. **Merge**: Squash-merge into `main` is preferred to keep history clean.

## Adding a New Tool

1. **Create the tool module** in `src/tools/`. Follow the existing pattern:
   - Export functions that accept a config (or specific params) and return typed results.
   - Validate all inputs defensively.
   - Handle errors with descriptive messages.

2. **Register the tool in `server.ts`**:
   - Add the tool definition to `ListToolsRequestSchema` handler (name, description, inputSchema).
   - Add the `case` block to `CallToolRequestSchema` handler with input validation + dispatch.

3. **Update the config type** in `config.ts` if the tool needs new configuration fields.

4. **Update the config validation** in `config.ts` for any new required fields.

5. **Write tests** in `src/__tests__/`:
   - Test valid inputs.
   - Test invalid inputs (empty strings, missing fields, type errors).
   - Test security boundaries (path traversal, injection attempts).

6. **Update `better-mcp.schema.json`** with the new tool's config fields.

7. **Run the full test suite** and type-check.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

Types:
- `feat` — new tool or feature
- `fix` — bug fix
- `docs` — documentation
- `test` — test additions/changes
- `refactor` — code restructuring
- `chore` — build, CI, tooling
- `security` — security improvements

Examples:
```
feat(fs): add fs_delete tool with confirmation gate
fix(shell): clamp timeout to valid range in runRaw
docs: update README with db_query example output
test(git): add coverage for empty repo edge case
security(db): validate schema identifiers to prevent injection
```

## Questions?

Open a [GitHub Discussion](https://github.com/erquier/better-mcp/discussions) or create an issue. We're happy to help!
