import type { BetterMcpConfig, ProjectConfig } from "./config.js";
import type { AuthConfig } from "./auth.js";
import type { LoadedPlugin } from "./plugins.js";

// ─── Server State ──────────────────────────────────────────────────────────

/**
 * Wraps all module-level mutable state so it's no longer a singleton.
 * Pass an instance through tool handlers instead of relying on module-level
 * variables — critical for concurrent HTTP where one client shouldn't
 * affect another's session.
 */
export class ServerState {
  config: BetterMcpConfig;
  activeProject: string | null = null;
  transportType: "stdio" | "http" = "stdio";
  loadedPlugins: LoadedPlugin[] = [];

  constructor(config: BetterMcpConfig) {
    this.config = config;
  }
}

// ─── Tool Context ──────────────────────────────────────────────────────────

export interface ToolContext {
  /** Full BetterMcpConfig for the resolved project (via projectToConfig). */
  config: BetterMcpConfig;
  /** Resolved project configuration. */
  project: ProjectConfig;
  /** Auth configuration (from top-level config). */
  authConfig: AuthConfig | undefined;
  /** Transport type for auth mode checks. */
  transportType: "stdio" | "http";
  /** Currently loaded plugins. */
  loadedPlugins: LoadedPlugin[];
  /** Optional callback to send SSE events (interactive mode). */
  sendSseEvent?: (event: string, data: unknown) => void;
  /** Server state for stateful operations (e.g., workspace_set_project). */
  state: ServerState;
}

// ─── Tool Definition ───────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Execute the tool.
   * Args are already cleaned of `project` and `confirmationToken` params.
   */
  handler: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  /**
   * Optional auth gate check. If the tool needs auth gates (confirm/token/interactive),
   * return true for the specific args that should trigger it.
   * If not defined, the tool is assumed to never require auth gating.
   */
  requiresAuth?: (args: Record<string, unknown>) => boolean;
}
