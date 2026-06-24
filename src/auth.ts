import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────

export type AuthMode = "auto" | "confirm" | "token" | "interactive";

export interface AuthConfig {
  mode: AuthMode;
  /** Required when mode is "token" — the secret token clients must provide. */
  token?: string;
  /** How long (in ms) a pending confirmation stays valid. Default: 5 minutes. */
  confirmTimeout?: number;
}

export interface PendingConfirmation {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
  timeout: number;
}

export type AuthResult =
  | { allowed: true }
  | {
      allowed: false;
      blocked: true;
      reason: string;
      confirmationId?: string;
      tool?: string;
      args?: Record<string, unknown>;
    };

// ─── Pending Confirmations Map ────────────────────────────────────────────

const pendingConfirmations = new Map<string, PendingConfirmation>();

// ─── Cleanup interval (runs every 30 seconds) ─────────────────────────────

const CLEANUP_INTERVAL = 30_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, pending] of pendingConfirmations) {
      if (now - pending.timestamp > pending.timeout) {
        pendingConfirmations.delete(id);
      }
    }
  }, CLEANUP_INTERVAL);
  // Allow the process to exit even if the timer is still running
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// ─── Danger / Destructive Checks ──────────────────────────────────────────

/** Tool names that are always considered destructive. */
const DESTRUCTIVE_TOOLS = new Set([
  "fs_write",
  "fs_delete",
  "shell_raw",
  "db_query_write",
]);

/** Commands (in shell_run) that trigger auth gates. */
const DANGEROUS_COMMAND_KEYWORDS = [
  "deploy",
  "reset",
  "drop",
  "delete",
  "restart",
  "migrate",
];

/** SQL keywords that indicate a write/alter operation. */
const DESTRUCTIVE_SQL_KEYWORDS = ["DROP ", "ALTER ", "TRUNCATE ", "DELETE "];

/**
 * Check if a tool is always destructive.
 */
export function isDestructiveTool(toolName: string): boolean {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

/**
 * Check if a shell_run command name looks dangerous.
 */
export function isDangerousShellCommand(commandName: string): boolean {
  const lower = commandName.toLowerCase();
  return DANGEROUS_COMMAND_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Check if a SQL query is destructive (non-read-only).
 */
export function isDestructiveSql(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  return DESTRUCTIVE_SQL_KEYWORDS.some((kw) => upper.includes(kw));
}

/**
 * Determine if a specific tool call requires auth gates.
 */
export function requiresAuth(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName === "fs_write") return true;
  if (toolName === "fs_delete") return true;
  if (toolName === "shell_raw") return true;
  if (toolName === "shell_run") {
    const command = args.command;
    if (typeof command === "string") {
      return isDangerousShellCommand(command);
    }
    return false;
  }
  if (toolName === "db_query") {
    const sql = args.sql;
    if (typeof sql === "string") {
      return isDestructiveSql(sql);
    }
    return false;
  }
  return false;
}

// ─── Auth Check ───────────────────────────────────────────────────────────

/**
 * Check whether a tool call is authorized.
 *
 * @param toolName - The MCP tool name being called.
 * @param args - The tool arguments (already cleaned of project param).
 * @param authConfig - The auth configuration from the project config.
 * @param transportType - "stdio" | "http" (used for interactive mode fallback).
 * @returns AuthResult — either allowed or blocked with details.
 */
export function checkAuth(
  toolName: string,
  args: Record<string, unknown>,
  authConfig: AuthConfig | undefined,
  transportType: "stdio" | "http" = "stdio",
): AuthResult {
  // No auth config → auto mode (backward compatible)
  if (!authConfig || authConfig.mode === "auto") {
    return { allowed: true };
  }

  // Check if this tool actually requires auth
  if (!requiresAuth(toolName, args)) {
    return { allowed: true };
  }

  const mode = authConfig.mode;

  // ── Token mode ────────────────────────────────────────────────────
  if (mode === "token") {
    const providedToken = args.confirmationToken;
    if (typeof providedToken !== "string" || providedToken !== authConfig.token) {
      return {
        allowed: false,
        blocked: true,
        reason: "Invalid confirmation token",
      };
    }
    return { allowed: true };
  }

  // ── Confirm mode ──────────────────────────────────────────────────
  if (mode === "confirm") {
    const timeout = authConfig.confirmTimeout ?? 5 * 60 * 1000; // 5 min default
    const id = randomUUID();
    const pending: PendingConfirmation = {
      id,
      tool: toolName,
      args: { ...args },
      timestamp: Date.now(),
      timeout,
    };
    pendingConfirmations.set(id, pending);
    startCleanup();

    return {
      allowed: false,
      blocked: true,
      reason: "Confirmation required",
      confirmationId: id,
      tool: toolName,
      args: { ...args },
    };
  }

  // ── Interactive mode ──────────────────────────────────────────────
  if (mode === "interactive") {
    if (transportType === "stdio") {
      // Fall back to "confirm" mode for stdio
      const timeout = authConfig.confirmTimeout ?? 5 * 60 * 1000;
      const id = randomUUID();
      const pending: PendingConfirmation = {
        id,
        tool: toolName,
        args: { ...args },
        timestamp: Date.now(),
        timeout,
      };
      pendingConfirmations.set(id, pending);
      startCleanup();

      return {
        allowed: false,
        blocked: true,
        reason: "Confirmation required",
        confirmationId: id,
        tool: toolName,
        args: { ...args },
      };
    }
    // For HTTP, interactive mode is handled by sending an SSE event
    // and the tool call returns a blocked response. The actual SSE push
    // is done by the caller (server.ts) after checkAuth returns.
    const timeout = authConfig.confirmTimeout ?? 5 * 60 * 1000;
    const id = randomUUID();
    const pending: PendingConfirmation = {
      id,
      tool: toolName,
      args: { ...args },
      timestamp: Date.now(),
      timeout,
    };
    pendingConfirmations.set(id, pending);
    startCleanup();

    return {
      allowed: false,
      blocked: true,
      reason: "Confirmation required",
      confirmationId: id,
      tool: toolName,
      args: { ...args },
    };
  }

  // Fallback: auto mode
  return { allowed: true };
}

// ─── Confirmation Management ──────────────────────────────────────────────

/**
 * Approve a pending confirmation and return the stored args.
 * Throws if the confirmation doesn't exist or has expired.
 */
export function confirmOperation(confirmationId: string): {
  tool: string;
  args: Record<string, unknown>;
} {
  const pending = pendingConfirmations.get(confirmationId);
  if (!pending) {
    throw new Error(
      `Confirmation "${confirmationId}" not found or has expired`,
    );
  }

  // Check expiry
  const now = Date.now();
  if (now - pending.timestamp > pending.timeout) {
    pendingConfirmations.delete(confirmationId);
    throw new Error(
      `Confirmation "${confirmationId}" has expired`,
    );
  }

  pendingConfirmations.delete(confirmationId);
  return { tool: pending.tool, args: pending.args };
}

/**
 * Reject (remove) a pending confirmation.
 * Returns true if it existed, false otherwise.
 */
export function rejectOperation(confirmationId: string): boolean {
  const existed = pendingConfirmations.has(confirmationId);
  pendingConfirmations.delete(confirmationId);
  return existed;
}

/**
 * Get all currently pending confirmations.
 */
export function getPendingConfirmations(): PendingConfirmation[] {
  const now = Date.now();
  const result: PendingConfirmation[] = [];
  for (const [, pending] of pendingConfirmations) {
    if (now - pending.timestamp <= pending.timeout) {
      result.push({ ...pending });
    }
  }
  return result;
}

/**
 * Get the auth description for a tool's input schema.
 */
export function getAuthDescription(
  toolName: string,
  authConfig: AuthConfig | undefined,
): string {
  if (!authConfig || authConfig.mode === "auto") {
    return "";
  }
  if (authConfig.mode === "confirm") {
    if (toolName === "fs_write") {
      return "⚠️ Requires human confirmation before writing.";
    }
    if (toolName === "fs_delete") {
      return "⚠️ Requires human confirmation before deleting.";
    }
    if (toolName === "shell_raw") {
      return "⚠️ Requires human confirmation before executing arbitrary commands.";
    }
    if (toolName === "shell_run") {
      return "⚠️ Destructive commands (deploy, reset, drop, delete, restart, migrate) require human confirmation.";
    }
    if (toolName === "db_query") {
      return "⚠️ Destructive queries (DROP, ALTER, TRUNCATE, DELETE) require human confirmation.";
    }
    return "";
  }
  if (authConfig.mode === "token") {
    return "Requires `confirmationToken` parameter with a valid token for destructive operations.";
  }
  if (authConfig.mode === "interactive") {
    return "⚠️ Requires confirmation via SSE prompt for destructive operations.";
  }
  return "";
}

/**
 * Get schema for the confirmationToken parameter (used in token mode).
 */
export function getConfirmationTokenSchema(): Record<string, unknown> | null {
  return null; // added dynamically in server.ts
}
