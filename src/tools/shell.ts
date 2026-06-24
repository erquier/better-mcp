import { spawnSync } from "child_process";
import type { BetterMcpConfig } from "../config.js";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";

const MAX_COMMAND_LENGTH = 10000;
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024; // 10 MB

/**
 * Run a predefined shell command from config.
 */
export function runCommand(
  name: string,
  config: BetterMcpConfig,
  workdir?: string
): { stdout: string; stderr: string; exitCode: number; duration: number } {
  const shellConfig = config.tools!.shell;
  if (!shellConfig?.commands) {
    throw new Error("No shell commands configured");
  }

  // Validate command name
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Command name must be a non-empty string");
  }
  if (name.length > 100) {
    throw new Error("Command name is too long");
  }

  const command = shellConfig.commands[name];
  if (!command) {
    const available = Object.keys(shellConfig.commands).join(", ");
    throw new Error(
      `Unknown command "${name}". Available commands: ${available}`
    );
  }

  // Validate command string from config
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command configuration is invalid");
  }

  const cwd = workdir || config.root!;
  return runShellCommand(command, cwd, 300);
}

/**
 * Run a raw shell command (if allowed by config).
 */
export function runRaw(
  command: string,
  config: BetterMcpConfig,
  timeout = 120
): { stdout: string; stderr: string; exitCode: number; duration: number } {
  const shellConfig = config.tools!.shell;
  if (!shellConfig?.allowRaw) {
    throw new Error(
      "Raw shell commands not allowed. Set shell.allowRaw: true in better-mcp.json to enable"
    );
  }

  // Validate raw command input
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command must be a non-empty string");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters`);
  }

  // ⚠️  SECURITY NOTE: allowRaw=true grants arbitrary command execution.
  // No sandbox, no filtering, no command-injection protection is applied.
  // Only the trivial backtick/newline blocker exists; $(), ;, &&, |, > all pass.
  // This is by design — raw mode is for power users who accept the risk.
  if (/[`\n\r]/.test(command)) {
    throw new Error("Command contains prohibited shell metacharacters");
  }

  console.error(`⚠️ Raw shell execution: ${command.substring(0, 200)}${command.length > 200 ? "…" : ""}`);

  return runShellCommand(command, config.root!, Math.max(1, Math.min(timeout, 3600)));
}

/**
 * Execute a shell command using spawnSync with shell:true but with input validation.
 * Predefined commands (from config) are trusted; raw commands get additional sanitization.
 *
 * Correctly distinguishes between:
 * - Timeout (signal === "SIGTERM", exitCode -1)
 * - ENOENT / command not found (throw caught, exitCode -1, has specific error message)
 * - maxBuffer exceeded (ERR_CHILD_PROCESS_STDIO_MAXBUFFER, has truncation indicator)
 * - Normal exit (exitCode 0-255)
 */
function runShellCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number
): { stdout: string; stderr: string; exitCode: number; duration: number } {
  const start = Date.now();

  let result;
  try {
    result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf-8",
      timeout: timeoutSeconds * 1000,
      maxBuffer: MAX_COMMAND_OUTPUT,
      env: {
        ...process.env,
        PROJECT_ROOT: cwd,
      },
    });
  } catch (e: unknown) {
    const duration = Date.now() - start;
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };

    // ENOENT: command not found
    if (err.code === "ENOENT") {
      const cmdName = command.split(/\s+/)[0];
      return {
        stdout: "",
        stderr: `Command not found: ${cmdName} — the shell tool requires this command to be installed on the system PATH.`,
        exitCode: -1,
        duration,
      };
    }

    // maxBuffer exceeded: output was truncated
    if ((err as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        stdout: ((err as any).stdout || "").trim() + "\n... (output truncated, exceeded maxBuffer)",
        stderr: ((err as any).stderr || "").trim(),
        exitCode: -1,
        duration,
      };
    }

    // Re-throw any unexpected errors
    throw e;
  }

  const duration = Date.now() - start;
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  // Timeout detection: signal === "SIGTERM" (set by spawnSync when timeout fires)
  if (result.signal === "SIGTERM") {
    return {
      stdout,
      stderr: stderr || `Command timed out after ${timeoutSeconds} seconds`,
      exitCode: -1,
      duration,
    };
  }

  return {
    stdout,
    stderr,
    exitCode: result.status ?? -1,
    duration,
  };
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

/**
 * Get shell tool definitions for the MCP server.
 * Tools are only returned if at least one project has shell tools enabled.
 */
export function getToolDefinitions(config: BetterMcpConfig, hasShell: boolean): ToolDefinition[] {
  if (!hasShell) return [];

  // Collect all available commands across all projects
  const allCmds = new Set<string>();
  const projects = (config as any).projects ?? [];
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (p.tools?.shell?.commands) {
        Object.keys(p.tools.shell.commands).forEach((c: string) => allCmds.add(c));
      }
    }
  }
  if (config.tools?.shell?.commands) {
    Object.keys(config.tools.shell.commands).forEach((c: string) => allCmds.add(c));
  }
  const availableCmds = Array.from(allCmds).join(", ") || "(none configured)";

  const tools: ToolDefinition[] = [
    {
      name: "shell_run",
      description: `Run a predefined command from the project config. Available: ${availableCmds}.`,
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
      requiresAuth: (args) => {
        const command = args.command;
        if (typeof command === "string") {
          const lower = command.toLowerCase();
          return ["deploy", "reset", "drop", "delete", "restart", "migrate"].some(
            (kw) => lower.includes(kw),
          );
        }
        return false;
      },
      handler: async (args, ctx) => {
        const cmd = args.command;
        if (typeof cmd !== "string" || cmd.length === 0) {
          throw new Error("shell_run requires a non-empty string 'command'");
        }
        const result = runCommand(cmd, ctx.config, ctx.project.root);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              duration: result.duration,
            }),
          }],
        };
      },
    },
  ];

  // Only add shell_raw if at least one project allows raw shell
  const hasRawShell = Array.isArray(projects)
    ? projects.some((p: any) => p.tools?.shell?.allowRaw)
    : !!(config.tools?.shell?.allowRaw);

  if (hasRawShell) {
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
      requiresAuth: () => true,
      handler: async (args, ctx) => {
        const rawCmd = args.command;
        if (typeof rawCmd !== "string" || rawCmd.length === 0) {
          throw new Error("shell_raw requires a non-empty string 'command'");
        }
        const timeout = typeof args.timeout === "number" && Number.isFinite(args.timeout)
          ? Math.max(1, Math.floor(args.timeout)) : 120;
        const result = runRaw(rawCmd, ctx.config, timeout);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              duration: result.duration,
            }),
          }],
        };
      },
    });
  }

  return tools;
}
