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
import * as shellBg from "./tools/shell-background.js";
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
} from "./plugins.js";
import {
  ServerState,
  type ToolContext,
  type ToolDefinition,
} from "./tool-registry.js";

// ─── Server State (wraps all module-level mutable state) ────────────────

let _sendSseEvent: ((event: string, data: unknown) => void) | null = null;

// Keep a global ServerState — initialized in startServer
let _state: ServerState;

// ─── Helper Functions ───────────────────────────────────────────────────

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
function resolveProject(args: Record<string, unknown> | undefined, state: ServerState): ProjectConfig {
  const projectName = args?.project;
  if (typeof projectName === "string" && projectName.length > 0) {
    return getProject(projectName, state.config);
  }
  // Check active project from state
  if (state.activeProject) {
    try {
      return getProject(state.activeProject, state.config);
    } catch {
      // Active project no longer valid — fall through to default
    }
  }
  return getDefaultProject(state.config);
}

/**
 * Build the `project` parameter schema that gets added to every tool.
 */
function projectParameter(config: BetterMcpConfig): { type: string; description: string } | null {
  const projects = getAllProjects(config);
  if (projects.length <= 1) return null;
  const names = projects.map((p) => p.name).join(", ");
  return {
    type: "string",
    description: `Project name to operate on. Available: ${names}`,
  };
}

/**
 * Clean args by removing MCP-internal parameters.
 */
function cleanToolArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return args !== undefined && typeof args === "object" && !Array.isArray(args)
    ? Object.fromEntries(
        Object.entries(args).filter(([k]) => k !== "project" && k !== "confirmationToken"),
      )
    : undefined;
}

/**
 * Collect all tool definitions from all tool modules.
 */
function collectToolDefinitions(state: ServerState): ToolDefinition[] {
  const config = state.config;
  const projects = getAllProjects(config);
  const hasFs = projects.some((p) => p.tools.fs);
  const hasDb = projects.some((p) => p.tools.db);
  const hasShell = projects.some((p) => p.tools.shell);
  const hasGit = projects.some((p) => p.tools.git?.enabled !== false);

  const projectParam = projectParameter(config);
  const isMultiProject = projectParam !== null;
  const authMode = config.auth?.mode;
  const needsConfirmationToken = authMode === "token";

  // Collect from all tool modules
  const allDefs: ToolDefinition[] = [
    ...fs.getToolDefinitions(config, hasFs),
    ...db.getToolDefinitions(config, hasDb),
    ...shell.getToolDefinitions(config, hasShell),
    ...shellBg.getToolDefinitions(config, hasShell),
    ...git.getToolDefinitions(config, hasGit),
    ...project.getToolDefinitions(config, state),
  ];

  // Add project parameter and confirmationToken to schemas where needed
  for (const def of allDefs) {
    if (isMultiProject) {
      def.inputSchema = {
        ...def.inputSchema,
        properties: {
          ...(def.inputSchema.properties as Record<string, unknown> || {}),
          project: projectParam!,
        },
      };
    }
    if (needsConfirmationToken && def.requiresAuth?.(def.name === "fs_write" ? { path: "dummy", content: "dummy" } : {})) {
      def.inputSchema = {
        ...def.inputSchema,
        properties: {
          ...(def.inputSchema.properties as Record<string, unknown> || {}),
          confirmationToken: { type: "string", description: "Confirmation token for destructive operations" },
        },
      };
    }
  }

  // Auth tools (always added when auth is configured)
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

    allDefs.push({
      name: "auth_confirm",
      description: "Approve a pending destructive operation that requires confirmation.",
      inputSchema: authConfirmSchema,
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const confirmationId = args.confirmationId;
        if (typeof confirmationId !== "string" || confirmationId.length === 0) {
          throw new Error("auth_confirm requires a non-empty string 'confirmationId'");
        }
        const confirmed = confirmOperation(confirmationId, undefined);
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
      },
    });

    allDefs.push({
      name: "auth_reject",
      description: "Reject/cancel a pending destructive operation.",
      inputSchema: authRejectSchema,
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const confirmationId = args.confirmationId;
        if (typeof confirmationId !== "string" || confirmationId.length === 0) {
          throw new Error("auth_reject requires a non-empty string 'confirmationId'");
        }
        const existed = rejectOperation(confirmationId, undefined);
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
      },
    });

    allDefs.push({
      name: "auth_status",
      description: "List all currently pending confirmations.",
      inputSchema: authStatusSchema,
      requiresAuth: () => false,
      handler: async (args, ctx) => {
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
      },
    });
  }

  // Plugin tools
  const pluginTools = getPluginTools(state.loadedPlugins);
  for (const pt of pluginTools) {
    allDefs.push({
      name: pt.name,
      description: pt.description,
      inputSchema: pt.inputSchema,
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        return await pt.handler(args, { config: ctx.config, project: ctx.project.name });
      },
    });
  }

  return allDefs;
}

// ─── MCP Server Creation ───────────────────────────────────────────────

/**
 * Creates and configures an MCP Server with all tool/resource handlers.
 * Does NOT connect to a transport — callers must connect after.
 */
function createConfiguredServer(state: ServerState): Server {
  const server = new Server(
    {
      name: "better-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Collect all tool definitions once
  const toolDefs = collectToolDefinitions(state);
  const toolMap = new Map(toolDefs.map((d) => [d.name, d]));

  // ─── List Tools ─────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = toolDefs.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    }));

    // Add auth descriptions to tool descriptions
    const authConfig = state.config.auth;
    if (authConfig && authConfig.mode !== "auto") {
      for (const tool of tools) {
        const authDesc = getAuthDescription(tool.name, authConfig);
        if (authDesc) {
          tool.description += authDesc;
        }
      }
    }

    return { tools };
  });

  // ─── Call Tool ──────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Validate args is an object if present
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        throw new Error("Invalid arguments: expected an object");
      }

      // Look up the tool definition
      const def = toolMap.get(name);
      if (!def) {
        throw new Error(`Unknown tool: ${name}`);
      }

      // Clean args (remove project, confirmationToken)
      const cleanArgs: Record<string, unknown> | undefined = cleanToolArgs(args);

      // Resolve project config
      const projectConfig = resolveProject(args, state);
      const pc = projectToConfig(projectConfig);

      // Build tool context
      const ctx: ToolContext = {
        config: pc,
        project: projectConfig,
        authConfig: state.config.auth,
        transportType: state.transportType,
        loadedPlugins: state.loadedPlugins,
        sendSseEvent: _sendSseEvent || undefined,
        state,
      };

      // Auth gating check (only for tools that declare requiresAuth)
      if (def.requiresAuth && def.requiresAuth(cleanArgs ?? {})) {
        const authResult = checkAuth(name, cleanArgs ?? {}, state.config.auth, state.transportType);
        if (!authResult.allowed) {
          if (state.config.auth?.mode === "interactive" && state.transportType === "http") {
            sendConfirmationSseEvent(authResult.confirmationId!, authResult.tool!, authResult.args!);
          }
          return {
            isError: false,
            content: [{ type: "text", text: JSON.stringify(authResult) }],
          };
        }
      }

      // Execute the tool handler
      return await def.handler(cleanArgs ?? {}, ctx);
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
    const projects = getAllProjects(state.config);

    for (const p of projects) {
      if (p.resources) {
        for (const [resName, resPath] of Object.entries(p.resources)) {
          resources.push({
            uri: `mcp://project/${p.name}/${resName}`,
            name: `${p.name}:${resName}`,
            description: `Resource: ${resName} (project: ${p.name})`,
            mimeType: "text/markdown",
          });
        }
      }
    }

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const match = uri.match(/^mcp:\/\/project\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const projectName = match[1];
    const resourceName = match[2];

    const projectConfig = getProject(projectName, state.config);
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

// ─── Server Start ──────────────────────────────────────────────────────

/**
 * Load config and start the server with the configured transport.
 */
export async function startServer(
  configPath?: string,
  overrides?: { transport?: "stdio" | "http"; port?: number; host?: string },
): Promise<void> {
  // Global exception handlers
  process.on("uncaughtException", (err) => {
    console.error("better-mcp uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("better-mcp unhandled rejection:", reason);
  });

  const config = loadConfig(configPath);

  // Apply CLI overrides on top of config
  if (overrides?.transport) {
    config.transport = overrides.transport;
  }
  if (overrides?.port !== undefined) {
    config.port = overrides.port;
  }
  if (overrides?.host !== undefined) {
    if (!config.http) config.http = {};
    config.http.host = overrides.host;
  }

  // Initialize ServerState
  _state = new ServerState(config);

  // Discover and load plugins
  const rootDir = config.root || process.cwd();
  _state.loadedPlugins = await discoverPlugins(config, rootDir);
  if (_state.loadedPlugins.length > 0) {
    const summary = getPluginSummary(_state.loadedPlugins);
    console.error(`better-mcp loaded ${_state.loadedPlugins.length} plugin(s):`);
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
  const server = createConfiguredServer(_state);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  _state.transportType = "stdio";

  const projects = getAllProjects(_state.config);
  if (projects.length > 1) {
    console.error(`better-mcp started with ${projects.length} projects`);
    for (const p of projects) {
      console.error(`  ${p.name}: ${p.root}`);
    }
  } else {
    const defaultP = getDefaultProject(_state.config);
    console.error(`better-mcp started for project: ${defaultP.name}`);
    console.error(`Root: ${defaultP.root}`);
    console.error(`Stack: ${(defaultP.stack || []).join(", ")}`);
  }
}

/**
 * Start the MCP server with HTTP/SSE transport.
 */
async function startHttpServer(): Promise<void> {
  const port = _state.config.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3100);
  const httpTransport = new HttpServerTransport("/mcp");
  const server = createConfiguredServer(_state);

  _state.transportType = "http";

  // In interactive mode, set up the SSE event handler
  if (_state.config.auth?.mode === "interactive") {
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

  // Start the HTTP server
  createHttpServer({
    port,
    host: _state.config.http?.host,
    transport: httpTransport,
    httpConfig: _state.config.http,
  });

  const projects = getAllProjects(_state.config);
  if (projects.length > 1) {
    console.error(`better-mcp started with ${projects.length} projects (HTTP mode)`);
    for (const p of projects) {
      console.error(`  ${p.name}: ${p.root}`);
    }
  } else {
    const defaultP = getDefaultProject(_state.config);
    console.error(`better-mcp started for project: ${defaultP.name} (HTTP mode)`);
    console.error(`Root: ${defaultP.root}`);
    console.error(`Stack: ${(defaultP.stack || []).join(", ")}`);
  }
  console.error(`Listening on http://localhost:${port}`);
}
