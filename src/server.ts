import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type BetterMcpConfig } from "./config.js";
import * as fs from "./tools/fs.js";
import * as db from "./tools/db.js";
import * as shell from "./tools/shell.js";
import * as git from "./tools/git.js";
import * as project from "./tools/project.js";

let config: BetterMcpConfig;

export async function startServer(configPath?: string): Promise<void> {
  config = loadConfig(configPath);
  const root = config.root;

  const server = new Server(
    {
      name: "better-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // ─── List Tools ─────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: any[] = [];

    if (config.tools.fs) {
      tools.push(
        {
          name: "fs_read",
          description: "Read a file with pagination. Returns content, total lines, and file size.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path (absolute or relative to project root)" },
              offset: { type: "number", description: "Starting line (1-indexed)", default: 1 },
              limit: { type: "number", description: "Max lines to return (max 2000)", default: 500 },
            },
            required: ["path"],
          },
        },
        {
          name: "fs_write",
          description: "Write content to a file. Creates directories if needed. Handles escaping correctly.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
              content: { type: "string", description: "File content" },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "fs_search",
          description: "Search files by regex pattern within the project.",
          inputSchema: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Regex pattern to search" },
              fileGlob: { type: "string", description: "Optional file glob filter (e.g. *.ts, *.py)" },
              limit: { type: "number", description: "Max results", default: 50 },
            },
            required: ["pattern"],
          },
        },
        {
          name: "fs_list",
          description: "List directory contents.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path" },
            },
            required: ["path"],
          },
        }
      );
    }

    if (config.tools.db) {
      tools.push(
        {
          name: "db_query",
          description: "Execute a read-only SQL query against the project database. Only SELECT/WITH allowed in read-only mode.",
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "SQL query" },
            },
            required: ["sql"],
          },
        },
        {
          name: "db_schema",
          description: "Get the complete database schema: tables, columns, types, nullable, defaults, primary keys.",
          inputSchema: {
            type: "object",
            properties: {
              schemas: {
                type: "array",
                items: { type: "string" },
                description: "Schema filter (default: from config or public)",
              },
            },
          },
        }
      );
    }

    if (config.tools.shell) {
      const availableCmds = Object.keys(config.tools.shell.commands).join(", ");
      tools.push({
        name: "shell_run",
        description: `Run a predefined command from the project config. Available: ${availableCmds}`,
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: `Command name. Available: ${availableCmds}`,
            },
          },
          required: ["command"],
        },
      });

      if (config.tools.shell.allowRaw) {
        tools.push({
          name: "shell_raw",
          description: "Execute an arbitrary shell command. WARNING: Use with caution.",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "Shell command to execute" },
              timeout: { type: "number", description: "Timeout in seconds (default 120)", default: 120 },
            },
            required: ["command"],
          },
        });
      }
    }

    if (config.tools.git?.enabled !== false) {
      tools.push(
        {
          name: "git_status",
          description: "Get the current git status: branch, clean/dirty, staged/unstaged/untracked files, ahead/behind remote, last commit.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "git_log",
          description: "Get recent commit history.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max commits (default 10)", default: 10 },
            },
          },
        },
        {
          name: "git_diff",
          description: "Get diff of changes. Defaults to diff against HEAD.",
          inputSchema: {
            type: "object",
            properties: {
              target: { type: "string", description: "Git ref to diff against (default: HEAD)" },
            },
          },
        }
      );
    }

    tools.push(
      {
        name: "project_info",
        description: "Get comprehensive info about the project: stack, structure, file counts, config detection, enabled tools.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "read_resource",
        description: "Read a project resource file (handoff, plan, schema, docs).",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: `Resource name. Available: ${config.resources ? Object.keys(config.resources).join(", ") : "(none)"}`,
            },
          },
          required: ["name"],
        },
      }
    );

    return { tools };
  });

  // ─── Call Tool ──────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const root = config.root;

    try {
      // Validate args is an object if present
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        throw new Error("Invalid arguments: expected an object");
      }

      switch (name) {
        // ── Filesystem ──
        case "fs_read": {
          const path = args?.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("fs_read requires a non-empty string 'path'");
          }
          const offset = typeof args?.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1;
          const limit = typeof args?.limit === "number" && Number.isFinite(args.limit) ? Math.min(Math.max(1, Math.floor(args.limit)), 2000) : 500;
          const allowed = config.tools.fs?.allowedPaths || [root];
          const maxFileSize = config.tools.fs?.maxFileSize;
          const result = fs.readFile(path, allowed, offset, limit, maxFileSize);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "fs_write": {
          const path = args?.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("fs_write requires a non-empty string 'path'");
          }
          const content = args?.content;
          if (typeof content !== "string") {
            throw new Error("fs_write requires a string 'content'");
          }
          const allowed = config.tools.fs?.allowedPaths || [root];
          const result = fs.writeFile(path, content, allowed);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "fs_search": {
          const pattern = args?.pattern;
          if (typeof pattern !== "string" || pattern.length === 0) {
            throw new Error("fs_search requires a non-empty string 'pattern'");
          }
          const fileGlob = typeof args?.fileGlob === "string" ? args.fileGlob : undefined;
          const limit = typeof args?.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : 50;
          const allowed = config.tools.fs?.allowedPaths || [root];
          const result = fs.searchFiles(pattern, allowed, fileGlob, limit);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "fs_list": {
          const path = args?.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("fs_list requires a non-empty string 'path'");
          }
          const allowed = config.tools.fs?.allowedPaths || [root];
          const result = fs.listDirectory(path, allowed);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        // ── Database ──
        case "db_query": {
          const sql = args?.sql;
          if (typeof sql !== "string" || sql.length === 0) {
            throw new Error("db_query requires a non-empty string 'sql'");
          }
          const maxRows = config.tools.db?.maxRows ?? 500;
          const result = db.query(sql, config, maxRows);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "db_schema": {
          const rawSchemas = args?.schemas;
          let schemas: string[] | undefined;
          if (rawSchemas !== undefined) {
            if (!Array.isArray(rawSchemas)) {
              throw new Error("db_schema 'schemas' must be an array of strings");
            }
            schemas = rawSchemas.map((s: unknown) => {
              if (typeof s !== "string") {
                throw new Error("db_schema 'schemas' must be an array of strings");
              }
              return s;
            });
          }
          const result = db.schema(config, schemas);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        // ── Shell ──
        case "shell_run": {
          const cmd = args?.command;
          if (typeof cmd !== "string" || cmd.length === 0) {
            throw new Error("shell_run requires a non-empty string 'command'");
          }
          const result = shell.runCommand(cmd, config);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                  duration: result.duration,
                }),
              },
            ],
          };
        }

        case "shell_raw": {
          const rawCmd = args?.command;
          if (typeof rawCmd !== "string" || rawCmd.length === 0) {
            throw new Error("shell_raw requires a non-empty string 'command'");
          }
          const timeout = typeof args?.timeout === "number" && Number.isFinite(args.timeout) ? Math.max(1, Math.floor(args.timeout)) : 120;
          const result = shell.runRaw(rawCmd, config, timeout);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                  duration: result.duration,
                }),
              },
            ],
          };
        }

        // ── Git ──
        case "git_status": {
          const result = git.status(root);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "git_log": {
          const limit = typeof args?.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : 10;
          const result = git.log(root, limit);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "git_diff": {
          const target = typeof args?.target === "string" && args.target.length > 0 ? args.target : undefined;
          const result = git.diff(root, target);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        // ── Project ──
        case "project_info": {
          const result = project.info(config);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "read_resource": {
          const resourceName = args?.name;
          if (typeof resourceName !== "string" || resourceName.length === 0) {
            throw new Error("read_resource requires a non-empty string 'name'");
          }
          const result = project.readResource(resourceName, config);
          return {
            content: [
              { type: "text", text: result.content },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: unknown) {
      const err = error as Error;
      return {
        isError: true,
        content: [{ type: "text", text: err.message }],
      };
    }
  });

  // ─── Resources (for handoff, plans, etc.) ───────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: any[] = [];
    if (config.resources) {
      for (const [name, path] of Object.entries(config.resources)) {
        resources.push({
          uri: `mcp://project/${name}`,
          name,
          description: `Resource: ${name}`,
          mimeType: "text/markdown",
        });
      }
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const name = request.params.uri.replace("mcp://project/", "");
    const result = project.readResource(name, config);
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/markdown",
          text: result.content,
        },
      ],
    };
  });

  // ─── Start Transport ────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`better-mcp started for project: ${config.project}`);
  console.error(`Root: ${config.root}`);
  console.error(`Stack: ${(config.stack || []).join(", ")}`);
}
