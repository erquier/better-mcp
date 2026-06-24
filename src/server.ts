import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  loadConfig,
  setActiveProject,
  getActiveProjectName,
  getDefaultProject,
  getProject,
  getAllProjects,
  projectToConfig,
  type BetterMcpConfig,
  type ProjectConfig,
} from "./config.js";
import * as fs from "./tools/fs.js";
import * as db from "./tools/db.js";
import * as shell from "./tools/shell.js";
import * as git from "./tools/git.js";
import * as project from "./tools/project.js";
import { createHttpServer, HttpServerTransport } from "./http-server.js";
import {
  checkAuth,
  confirmOperation,
  rejectOperation,
  getPendingConfirmations,
  requiresAuth,
  getAuthDescription,
  type AuthConfig,
} from "./auth.js";
import {
  discoverPlugins,
  getPluginTools,
  getPluginSummary,
  type LoadedPlugin,
  type PluginTool as PluginToolType,
} from "./plugins.js";

let config: BetterMcpConfig;
let _transportType: "stdio" | "http" = "stdio";
let _sendSseEvent: ((event: string, data: unknown) => void) | null = null;
let _loadedPlugins: LoadedPlugin[] = [];

/**
 * Set the transport type for auth mode detection.
 */
function setTransportType(t: "stdio" | "http"): void {
  _transportType = t;
}

/**
 * Get the transport type.
 */
function getTransportType(): "stdio" | "http" {
  return _transportType;
}

/**
 * Register a callback to send SSE events (used in interactive mode).
 */
function setSseEventHandler(handler: ((event: string, data: unknown) => void) | null): void {
  _sendSseEvent = handler;
}

/**
 * Send an SSE event if we're in interactive HTTP mode.
 */
function sendConfirmationSseEvent(confirmationId: string, toolName: string, args: Record<string, unknown>): void {
  if (_sendSseEvent) {
    _sendSseEvent("confirmation", {
      id: confirmationId,
      tool: toolName,
      prompt: `Confirm ${toolName} with args: ${JSON.stringify(args)}`,
    });
  }
}

/**
 * Resolve the project config for a tool call.
 * If the tool args contain a `project` parameter, use that.
 * Otherwise use the active project (set via workspace_set_project) or the default.
 */
function resolveProject(args: Record<string, unknown> | undefined): ProjectConfig {
  const projectName = args?.project;
  if (typeof projectName === "string" && projectName.length > 0) {
    return getProject(projectName, config);
  }
  return getDefaultProject(config);
}

/**
 * Build the `project` parameter schema that gets added to every tool.
 */
function projectParameter(): { type: string; description: string } {
  const projects = getAllProjects(config);
  const names = projects.map((p) => p.name).join(", ");
  return {
    type: "string",
    description: `Project name to operate on. Available: ${names || "(single project)"}`,
  };
}

/**
 * Creates and configures an MCP Server with all tool/resource handlers.
 * Does NOT connect to a transport — callers must connect after.
 */
function createConfiguredServer(): Server {
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
    },
  );

  // ─── List Tools ─────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: any[] = [];
    const projectParam = projectParameter();
    const projects = getAllProjects(config);
    const isMultiProject = projects.length > 1;

    // Check if any project has fs tools
    const hasFsTool = projects.some((p) => p.tools.fs);
    if (hasFsTool) {
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
              ...(isMultiProject ? { project: projectParam } : {}),
            },
            required: ["path"],
          },
        },
        {
          name: "fs_write",
          description: `Write content to a file. Creates directories if needed. Handles escaping correctly.${getAuthDescription("fs_write", config.auth)}`,
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
              content: { type: "string", description: "File content" },
              ...(isMultiProject ? { project: projectParam } : {}),
              ...(config.auth?.mode === "token" ? { confirmationToken: { type: "string", description: "Confirmation token for destructive operations" } } : {}),
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
              ...(isMultiProject ? { project: projectParam } : {}),
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
              ...(isMultiProject ? { project: projectParam } : {}),
            },
            required: ["path"],
          },
        },
      );
    }

    // Check if any project has db tools
    const hasDbTool = projects.some((p) => p.tools.db);
    if (hasDbTool) {
      tools.push(
        {
          name: "db_query",
          description: `Execute a SQL query against the project database. Only SELECT/WITH allowed in read-only mode.${getAuthDescription("db_query", config.auth)}`,
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "SQL query" },
              ...(isMultiProject ? { project: projectParam } : {}),
              ...(config.auth?.mode === "token" ? { confirmationToken: { type: "string", description: "Confirmation token for destructive operations" } } : {}),
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
              ...(isMultiProject ? { project: projectParam } : {}),
            },
          },
        },
      );
    }

    // Check if any project has shell tools
    const hasShellTool = projects.some((p) => p.tools.shell);
    if (hasShellTool) {
      // Collect all available commands across all projects
      const allCmds = new Set<string>();
      for (const p of projects) {
        if (p.tools.shell?.commands) {
          Object.keys(p.tools.shell.commands).forEach((c) => allCmds.add(c));
        }
      }
      const availableCmds = Array.from(allCmds).join(", ") || "(none configured)";

      tools.push({
        name: "shell_run",
        description: `Run a predefined command from the project config. Available: ${availableCmds}.${getAuthDescription("shell_run", config.auth)}`,
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: `Command name. Available: ${availableCmds}`,
            },
            ...(isMultiProject ? { project: projectParam } : {}),
            ...(config.auth?.mode === "token" ? { confirmationToken: { type: "string", description: "Confirmation token for destructive operations" } } : {}),
          },
          required: ["command"],
        },
      });

      const hasRawShell = projects.some((p) => p.tools.shell?.allowRaw);
      if (hasRawShell) {
        tools.push({
          name: "shell_raw",
          description: `Execute an arbitrary shell command. WARNING: Use with caution.${getAuthDescription("shell_raw", config.auth)}`,
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "Shell command to execute" },
              timeout: { type: "number", description: "Timeout in seconds (default 120)", default: 120 },
              ...(isMultiProject ? { project: projectParam } : {}),
              ...(config.auth?.mode === "token" ? { confirmationToken: { type: "string", description: "Confirmation token for destructive operations" } } : {}),
            },
            required: ["command"],
          },
        });
      }
    }

    // Check if any project has git tools
    const hasGitTool = projects.some((p) => p.tools.git?.enabled !== false);
    if (hasGitTool) {
      tools.push(
        {
          name: "git_status",
          description: "Get the current git status: branch, clean/dirty, staged/unstaged/untracked files, ahead/behind remote, last commit.",
          inputSchema: {
            type: "object",
            properties: {
              ...(isMultiProject ? { project: projectParam } : {}),
            },
          },
        },
        {
          name: "git_log",
          description: "Get recent commit history.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max commits (default 10)", default: 10 },
              ...(isMultiProject ? { project: projectParam } : {}),
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
              ...(isMultiProject ? { project: projectParam } : {}),
            },
          },
        },
      );
    }

    tools.push(
      {
        name: "project_info",
        description: "Get comprehensive info about a project: stack, structure, file counts, config detection, enabled tools.",
        inputSchema: {
          type: "object",
          properties: {
            ...(isMultiProject ? { project: projectParam } : {}),
          },
        },
      },
      {
        name: "read_resource",
        description: "Read a project resource file (handoff, plan, schema, docs).",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: `Resource name. Available: ${
                projects
                  .flatMap((p) => (p.resources ? Object.keys(p.resources) : []))
                  .join(", ") || "(none)"
              }`,
            },
            ...(isMultiProject ? { project: projectParam } : {}),
          },
          required: ["name"],
        },
      },
    );

    // Workspace tools (always available)
    tools.push(
      {
        name: "workspace_list_projects",
        description: "List all configured projects with their name, root, stack, and enabled tools.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "workspace_set_project",
        description: "Set the active project for subsequent tool calls that don't specify a project explicitly.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: `Project name to set as active. Available: ${projects.map((p) => p.name).join(", ")}`,
            },
          },
          required: ["name"],
        },
      },
    );

    // Auth tools (only when auth is configured)
    const authConfig = config.auth;
    if (authConfig && authConfig.mode !== "auto") {
      const authConfirmSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          confirmationId: { type: "string", description: "The confirmation ID from a blocked tool response" },
        },
        required: ["confirmationId"],
      };
      const authRejectSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          confirmationId: { type: "string", description: "The confirmation ID to reject" },
        },
        required: ["confirmationId"],
      };
      const authStatusSchema: Record<string, unknown> = {
        type: "object",
        properties: {},
      };

      tools.push(
        {
          name: "auth_confirm",
          description: "Approve a pending destructive operation that requires confirmation.",
          inputSchema: authConfirmSchema,
        },
        {
          name: "auth_reject",
          description: "Reject/cancel a pending destructive operation.",
          inputSchema: authRejectSchema,
        },
        {
          name: "auth_status",
          description: "List all currently pending confirmations.",
          inputSchema: authStatusSchema,
        },
      );
    }

    // Add plugin tools
    const pluginTools = getPluginTools(_loadedPlugins);
    for (const pt of pluginTools) {
      tools.push({
        name: pt.name,
        description: pt.description,
        inputSchema: pt.inputSchema,
      });
    }

    return { tools };
  });

  // ─── Call Tool ──────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Remove the `project` and `confirmationToken` parameters from args before passing to tool functions
    const cleanArgs: Record<string, unknown> | undefined =
      args !== undefined && typeof args === "object" && !Array.isArray(args)
        ? Object.fromEntries(
            Object.entries(args).filter(([k]) => k !== "project" && k !== "confirmationToken"),
          )
        : undefined;

    try {
      // Validate args is an object if present
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        throw new Error("Invalid arguments: expected an object");
      }

      switch (name) {
        // ── Auth tools ──
        case "auth_confirm": {
          const authConfig = config.auth;
          if (!authConfig || authConfig.mode === "auto") {
            throw new Error("Auth is not enabled (mode is 'auto')");
          }
          const confirmationId = cleanArgs?.confirmationId;
          if (typeof confirmationId !== "string" || confirmationId.length === 0) {
            throw new Error("auth_confirm requires a non-empty string 'confirmationId'");
          }
          const confirmed = confirmOperation(confirmationId);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  confirmed: true,
                  tool: confirmed.tool,
                  args: confirmed.args,
                }),
              },
            ],
          };
        }

        case "auth_reject": {
          const authConfig = config.auth;
          if (!authConfig || authConfig.mode === "auto") {
            throw new Error("Auth is not enabled (mode is 'auto')");
          }
          const confirmationId = cleanArgs?.confirmationId;
          if (typeof confirmationId !== "string" || confirmationId.length === 0) {
            throw new Error("auth_reject requires a non-empty string 'confirmationId'");
          }
          const existed = rejectOperation(confirmationId);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  rejected: true,
                  existed,
                }),
              },
            ],
          };
        }

        case "auth_status": {
          const pending = getPendingConfirmations();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  pending,
                  count: pending.length,
                }),
              },
            ],
          };
        }

        // ── Workspace tools (no project needed) ──
        case "workspace_list_projects": {
          const allProjects = getAllProjects(config);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  allProjects.map((p) => ({
                    name: p.name,
                    root: p.root,
                    stack: p.stack || [],
                    description: p.description || "",
                    enabledTools: getEnabledTools(p),
                    availableCommands: p.tools.shell?.commands
                      ? Object.keys(p.tools.shell.commands)
                      : [],
                    resources: p.resources || {},
                  })),
                ),
              },
            ],
          };
        }

        case "workspace_set_project": {
          const projectName = args?.name;
          if (typeof projectName !== "string" || projectName.length === 0) {
            throw new Error("workspace_set_project requires a non-empty string 'name'");
          }
          // Verify the project exists
          getProject(projectName, config);
          setActiveProject(projectName);
          return {
            content: [
              { type: "text", text: JSON.stringify({ activeProject: projectName }) },
            ],
          };
        }

        // ── Filesystem ──
        case "fs_read": {
          const projectConfig = resolveProject(args);
          const path = cleanArgs?.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("fs_read requires a non-empty string 'path'");
          }
          const offset = typeof cleanArgs?.offset === "number" && Number.isFinite(cleanArgs.offset) ? Math.max(1, Math.floor(cleanArgs.offset)) : 1;
          const limit = typeof cleanArgs?.limit === "number" && Number.isFinite(cleanArgs.limit) ? Math.min(Math.max(1, Math.floor(cleanArgs.limit)), 2000) : 500;
          const allowed = projectConfig.tools.fs?.allowedPaths || [projectConfig.root];
          const maxFileSize = projectConfig.tools.fs?.maxFileSize;
          const result = fs.readFile(path, allowed, offset, limit, maxFileSize);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "fs_write": {
          const projectConfig = resolveProject(args);
          const path = cleanArgs?.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("fs_write requires a non-empty string 'path'");
          }
          const content = cleanArgs?.content;
          if (typeof content !== "string") {
            throw new Error("fs_write requires a string 'content'");
          }
          // Auth gate check
          const authResult = checkAuth("fs_write", cleanArgs || {}, config.auth, getTransportType());
          if (!authResult.allowed) {
            if (config.auth?.mode === "interactive" && getTransportType() === "http") {
              sendConfirmationSseEvent(authResult.confirmationId!, authResult.tool!, authResult.args!);
            }
            return {
              isError: false,
              content: [{ type: "text", text: JSON.stringify(authResult) }],
            };
          }
          const allowed = projectConfig.tools.fs?.allowedPaths || [projectConfig.root];
          const result = fs.writeFile(path, content, allowed);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "fs_search": {
          const projectConfig = resolveProject(args);
          const pattern = cleanArgs?.pattern;
          if (typeof pattern !== "string" || pattern.length === 0) {
            throw new Error("fs_search requires a non-empty string 'pattern'");
          }
          const fileGlob = typeof cleanArgs?.fileGlob === "string" ? cleanArgs.fileGlob : undefined;
          const limit = typeof cleanArgs?.limit === "number" && Number.isFinite(cleanArgs.limit) ? Math.max(1, Math.floor(cleanArgs.limit)) : 50;
          const allowed = projectConfig.tools.fs?.allowedPaths || [projectConfig.root];
          const result = fs.searchFiles(pattern, allowed, fileGlob, limit);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "fs_list": {
          const projectConfig = resolveProject(args);
          const path = cleanArgs?.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("fs_list requires a non-empty string 'path'");
          }
          const allowed = projectConfig.tools.fs?.allowedPaths || [projectConfig.root];
          const result = fs.listDirectory(path, allowed);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        // ── Database ──
        case "db_query": {
          const projectConfig = resolveProject(args);
          const pc = projectToConfig(projectConfig);
          const sql = cleanArgs?.sql;
          if (typeof sql !== "string" || sql.length === 0) {
            throw new Error("db_query requires a non-empty string 'sql'");
          }
          // Auth gate check for destructive queries
          const authResult = checkAuth("db_query", cleanArgs || {}, config.auth, getTransportType());
          if (!authResult.allowed) {
            if (config.auth?.mode === "interactive" && getTransportType() === "http") {
              sendConfirmationSseEvent(authResult.confirmationId!, authResult.tool!, authResult.args!);
            }
            return {
              isError: false,
              content: [{ type: "text", text: JSON.stringify(authResult) }],
            };
          }
          const maxRows = projectConfig.tools.db?.maxRows ?? 500;
          const result = db.query(sql, pc, maxRows);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "db_schema": {
          const projectConfig = resolveProject(args);
          const pc = projectToConfig(projectConfig);
          const rawSchemas = cleanArgs?.schemas;
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
          const result = db.schema(pc, schemas);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        // ── Shell ──
        case "shell_run": {
          const projectConfig = resolveProject(args);
          const pc = projectToConfig(projectConfig);
          const cmd = cleanArgs?.command;
          if (typeof cmd !== "string" || cmd.length === 0) {
            throw new Error("shell_run requires a non-empty string 'command'");
          }
          // Auth gate check for dangerous commands
          const authResult = checkAuth("shell_run", cleanArgs || {}, config.auth, getTransportType());
          if (!authResult.allowed) {
            if (config.auth?.mode === "interactive" && getTransportType() === "http") {
              sendConfirmationSseEvent(authResult.confirmationId!, authResult.tool!, authResult.args!);
            }
            return {
              isError: false,
              content: [{ type: "text", text: JSON.stringify(authResult) }],
            };
          }
          const result = shell.runCommand(cmd, pc, projectConfig.root);
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
          const projectConfig = resolveProject(args);
          const pc = projectToConfig(projectConfig);
          const rawCmd = cleanArgs?.command;
          if (typeof rawCmd !== "string" || rawCmd.length === 0) {
            throw new Error("shell_raw requires a non-empty string 'command'");
          }
          // Auth gate check
          const authResult = checkAuth("shell_raw", cleanArgs || {}, config.auth, getTransportType());
          if (!authResult.allowed) {
            if (config.auth?.mode === "interactive" && getTransportType() === "http") {
              sendConfirmationSseEvent(authResult.confirmationId!, authResult.tool!, authResult.args!);
            }
            return {
              isError: false,
              content: [{ type: "text", text: JSON.stringify(authResult) }],
            };
          }
          const timeout = typeof cleanArgs?.timeout === "number" && Number.isFinite(cleanArgs.timeout) ? Math.max(1, Math.floor(cleanArgs.timeout)) : 120;
          const result = shell.runRaw(rawCmd, pc, timeout);
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
          const projectConfig = resolveProject(args);
          const result = git.status(projectConfig.root);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "git_log": {
          const projectConfig = resolveProject(args);
          const limit = typeof cleanArgs?.limit === "number" && Number.isFinite(cleanArgs.limit) ? Math.max(1, Math.floor(cleanArgs.limit)) : 10;
          const result = git.log(projectConfig.root, limit);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "git_diff": {
          const projectConfig = resolveProject(args);
          const target = typeof cleanArgs?.target === "string" && cleanArgs.target.length > 0 ? cleanArgs.target : undefined;
          const result = git.diff(projectConfig.root, target);
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        // ── Project ──
        case "project_info": {
          const projectConfig = resolveProject(args);
          const pc = projectToConfig(projectConfig);
          const result = project.info(pc, getPluginSummary(_loadedPlugins));
          return {
            content: [
              { type: "text", text: JSON.stringify(result) },
            ],
          };
        }

        case "read_resource": {
          const projectConfig = resolveProject(args);
          const pc = projectToConfig(projectConfig);
          const resourceName = cleanArgs?.name;
          if (typeof resourceName !== "string" || resourceName.length === 0) {
            throw new Error("read_resource requires a non-empty string 'name'");
          }
          const result = project.readResource(resourceName, pc);
          return {
            content: [
              { type: "text", text: result.content },
            ],
          };
        }

        // ── Plugin tools ──
        default: {
          // Check if this is a plugin tool (prefix: plugin_<plugin_name>_<tool_name>)
          if (name.startsWith("plugin_")) {
            const pluginTools = getPluginTools(_loadedPlugins);
            const matchingTool = pluginTools.find((t) => t.name === name);
            if (!matchingTool) {
              throw new Error(`Unknown plugin tool: ${name}`);
            }

            // Build context
            const projectConfig = resolveProject(args);
            const result = await matchingTool.handler(
              cleanArgs ?? {},
              { config: projectToConfig(projectConfig), project: projectConfig.name },
            );
            return result;
          }
          throw new Error(`Unknown tool: ${name}`);
        }
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
    const projects = getAllProjects(config);

    for (const p of projects) {
      if (p.resources) {
        for (const [name, path] of Object.entries(p.resources)) {
          resources.push({
            uri: `mcp://project/${p.name}/${name}`,
            name: `${p.name}:${name}`,
            description: `Resource: ${name} (project: ${p.name})`,
            mimeType: "text/markdown",
          });
        }
      }
    }

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    // Parse the URI to extract project name and resource name
    const match = uri.match(/^mcp:\/\/project\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const projectName = match[1];
    const resourceName = match[2];

    const projectConfig = getProject(projectName, config);
    const pc = projectToConfig(projectConfig);
    const result = project.readResource(resourceName, pc);

    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: result.content,
        },
      ],
    };
  });

  return server;
}

function getEnabledTools(projectConfig: ProjectConfig): string[] {
  const tools: string[] = [];
  if (projectConfig.tools.fs) tools.push("filesystem");
  if (projectConfig.tools.db) tools.push("database");
  if (projectConfig.tools.shell) tools.push("shell");
  if (projectConfig.tools.git?.enabled !== false) tools.push("git");
  return tools;
}

/**
 * Load config and start the server with the configured transport.
 *
 * Transport selection (in priority order):
 * 1. Config file: transport: "http"
 * 2. Default: stdio
 */
export async function startServer(
  configPath?: string,
  overrides?: { transport?: "stdio" | "http"; port?: number },
): Promise<void> {
  config = loadConfig(configPath);

  // Apply CLI overrides on top of config
  if (overrides?.transport) {
    config.transport = overrides.transport;
  }
  if (overrides?.port !== undefined) {
    config.port = overrides.port;
  }

  // Discover and load plugins
  const rootDir = config.root || process.cwd();
  _loadedPlugins = await discoverPlugins(config, rootDir);
  if (_loadedPlugins.length > 0) {
    const summary = getPluginSummary(_loadedPlugins);
    console.error(`better-mcp loaded ${_loadedPlugins.length} plugin(s):`);
    for (const p of summary) {
      console.error(`  ${p.name} v${p.version} — ${p.toolCount} tool(s)`);
    }
  } else {
    console.error("better-mcp: no plugins loaded");
  }

  if (config.transport === "http") {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}

/**
 * Start the MCP server with stdio transport (default).
 */
async function startStdioServer(): Promise<void> {
  const server = createConfiguredServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  setTransportType("stdio");

  const projects = getAllProjects(config);
  if (projects.length > 1) {
    console.error(`better-mcp started with ${projects.length} projects`);
    for (const p of projects) {
      console.error(`  ${p.name}: ${p.root}`);
    }
  } else {
    const defaultP = getDefaultProject(config);
    console.error(`better-mcp started for project: ${defaultP.name}`);
    console.error(`Root: ${defaultP.root}`);
    console.error(`Stack: ${(defaultP.stack || []).join(", ")}`);
  }
}

/**
 * Start the MCP server with HTTP/SSE transport.
 */
async function startHttpServer(): Promise<void> {
  const port = config.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3100);
  const httpTransport = new HttpServerTransport("/mcp");
  const server = createConfiguredServer();

  setTransportType("http");

  // In interactive mode, set up the SSE event handler
  if (config.auth?.mode === "interactive") {
    setSseEventHandler((event: string, data: unknown) => {
      try {
        httpTransport.sendEvent(event, data);
      } catch {
        // ignore — SSE connection may not be established yet
      }
    });
  }

  // Connect the MCP server to the HTTP transport
  await server.connect(httpTransport);

  // Start the HTTP server (this will handle incoming GET/POST requests)
  createHttpServer({ port, transport: httpTransport });

  const projects = getAllProjects(config);
  if (projects.length > 1) {
    console.error(`better-mcp started with ${projects.length} projects (HTTP mode)`);
    for (const p of projects) {
      console.error(`  ${p.name}: ${p.root}`);
    }
  } else {
    const defaultP = getDefaultProject(config);
    console.error(`better-mcp started for project: ${defaultP.name} (HTTP mode)`);
    console.error(`Root: ${defaultP.root}`);
    console.error(`Stack: ${(defaultP.stack || []).join(", ")}`);
  }
  console.error(`Listening on http://localhost:${port}`);
}
