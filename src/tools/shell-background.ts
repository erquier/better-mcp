import { spawn, ChildProcess } from "child_process";
import type { BetterMcpConfig } from "../config.js";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface JobState {
  id: string;
  command: string;
  args: string[];
  startTime: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  running: boolean;
  process: ChildProcess | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface BackgroundJobResult {
  jobId: string;
  pid: number | null;
  command: string;
}

interface JobStatusResult {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
}

interface JobLogResult {
  jobId: string;
  stdout: string;
  stderr: string;
  running: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────

const jobs = new Map<string, JobState>();
const MAX_JOB_AGE_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let jobCounter = 0;

// ─── Helpers ────────────────────────────────────────────────────────────

function generateJobId(): string {
  jobCounter++;
  return `bg-${Date.now()}-${jobCounter}`;
}

function scheduleCleanup(jobId: string): void {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job && !job.running) {
      jobs.delete(jobId);
    }
  }, MAX_JOB_AGE_MS);
}

function getShellArgs(command: string): string[] {
  return ["-c", command];
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Start a command in the background.
 * Returns a job ID that can be used to check status, get logs, or stop the process.
 */
export function startBackground(
  command: string,
  cwd?: string,
  timeoutSeconds?: number,
): BackgroundJobResult {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command must be a non-empty string");
  }

  const jobId = generateJobId();
  const timeoutMs = (timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;

  const job: JobState = {
    id: jobId,
    command,
    args: getShellArgs(command),
    startTime: Date.now(),
    stdout: "",
    stderr: "",
    exitCode: null,
    running: true,
    process: null,
    timeoutId: null,
  };

  const child = spawn("/bin/sh", getShellArgs(command), {
    cwd: cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PROJECT_ROOT: cwd || process.cwd() },
  });

  job.process = child;

  child.stdout!.on("data", (data: Buffer) => {
    job.stdout += data.toString();
  });

  child.stderr!.on("data", (data: Buffer) => {
    job.stderr += data.toString();
  });

  child.on("close", (code: number | null) => {
    job.running = false;
    job.exitCode = code;
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }
    scheduleCleanup(jobId);
  });

  child.on("error", (err: Error) => {
    job.stderr += `\nProcess error: ${err.message}`;
    job.running = false;
    job.exitCode = -1;
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }
    scheduleCleanup(jobId);
  });

  // Timeout enforcement
  if (timeoutMs > 0 && timeoutMs < Infinity) {
    job.timeoutId = setTimeout(() => {
      const j = jobs.get(jobId);
      if (j && j.running && j.process) {
        j.process.kill("SIGTERM");
        j.stderr += `\nCommand timed out after ${timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000} seconds`;
        // Don't set running=false here; the 'close' event will fire
      }
    }, timeoutMs);
  }

  jobs.set(jobId, job);

  return {
    jobId,
    pid: child.pid ?? null,
    command,
  };
}

/**
 * Check the status of a background job.
 */
export function getJobStatus(jobId: string): JobStatusResult {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  return {
    jobId: job.id,
    running: job.running,
    exitCode: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr,
    duration: Date.now() - job.startTime,
  };
}

/**
 * Get the log output of a background job, optionally limited to the last N lines.
 */
export function getJobLog(
  jobId: string,
  tail?: number,
): JobLogResult {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  let stdout = job.stdout;
  let stderr = job.stderr;

  if (tail !== undefined && tail > 0) {
    const stdoutLines = stdout.split("\n");
    const stderrLines = stderr.split("\n");
    stdout = stdoutLines.slice(-tail).join("\n");
    stderr = stderrLines.slice(-tail).join("\n");
  }

  return {
    jobId: job.id,
    stdout,
    stderr,
    running: job.running,
  };
}

/**
 * Stop a background job by sending SIGTERM (and SIGKILL after 5s if still running).
 */
export function stopJob(jobId: string): { jobId: string; stopped: boolean; exitCode: number | null } {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  if (!job.running || !job.process) {
    return { jobId, stopped: false, exitCode: job.exitCode };
  }

  job.process.kill("SIGTERM");

  // Force kill after 5 seconds if still alive
  setTimeout(() => {
    const j = jobs.get(jobId);
    if (j && j.running && j.process) {
      try {
        j.process.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
    }
  }, 5000);

  return { jobId, stopped: true, exitCode: null };
}

/**
 * List all active (running or recently finished) background jobs.
 */
export function listJobs(): Array<{
  jobId: string;
  command: string;
  running: boolean;
  duration: number;
}> {
  const result: Array<{
    jobId: string;
    command: string;
    running: boolean;
    duration: number;
  }> = [];

  for (const [id, job] of jobs) {
    result.push({
      jobId: id,
      command: job.command.substring(0, 100),
      running: job.running,
      duration: Date.now() - job.startTime,
    });
  }

  return result;
}

// ─── Tool Definitions ──────────────────────────────────────────────────

export function getToolDefinitions(
  config: BetterMcpConfig,
  _hasShell: boolean,
): ToolDefinition[] {
  return [
    {
      name: "shell_bg_start",
      description:
        "Start a command in the background and return immediately with a job ID. " +
        "Use shell_bg_status, shell_bg_log, and shell_bg_stop to manage the job. " +
        "Default timeout is 30 minutes. Commands run in /bin/sh.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run in the background",
          },
          timeout: {
            type: "number",
            description:
              "Timeout in seconds (default: 1800 / 30 min, max: 86400 / 24h)",
            default: 1800,
          },
        },
        required: ["command"],
      },
      requiresAuth: () => true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const command = args.command;
        if (typeof command !== "string" || command.length === 0) {
          throw new Error("shell_bg_start requires a non-empty string 'command'");
        }
        const timeout =
          typeof args.timeout === "number" && Number.isFinite(args.timeout)
            ? Math.max(1, Math.min(args.timeout, 86400))
            : 1800;
        const result = startBackground(command, ctx.project.root, timeout);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    },
    {
      name: "shell_bg_status",
      description:
        "Check the status of a background job. Returns running state, exit code (if done), stdout/stderr so far, and duration.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "Job ID returned by shell_bg_start",
          },
        },
        required: ["jobId"],
      },
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const jobId = args.jobId;
        if (typeof jobId !== "string" || jobId.length === 0) {
          throw new Error("shell_bg_status requires a non-empty string 'jobId'");
        }
        const result = getJobStatus(jobId);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    },
    {
      name: "shell_bg_log",
      description:
        "Get the log output of a background job. Optionally limit to the last N lines.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "Job ID returned by shell_bg_start",
          },
          tail: {
            type: "number",
            description: "Only return the last N lines of output",
          },
        },
        required: ["jobId"],
      },
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const jobId = args.jobId;
        if (typeof jobId !== "string" || jobId.length === 0) {
          throw new Error("shell_bg_log requires a non-empty string 'jobId'");
        }
        const tail =
          typeof args.tail === "number" && Number.isFinite(args.tail)
            ? Math.max(1, Math.floor(args.tail))
            : undefined;
        const result = getJobLog(jobId, tail);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    },
    {
      name: "shell_bg_stop",
      description:
        "Stop a running background job by sending SIGTERM (then SIGKILL after 5s if needed).",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "Job ID returned by shell_bg_start",
          },
        },
        required: ["jobId"],
      },
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const jobId = args.jobId;
        if (typeof jobId !== "string" || jobId.length === 0) {
          throw new Error("shell_bg_stop requires a non-empty string 'jobId'");
        }
        const result = stopJob(jobId);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    },
    {
      name: "shell_bg_list",
      description:
        "List all active or recently finished background jobs.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args: Record<string, unknown>, _ctx: ToolContext) => {
        const result = listJobs();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    },
  ];
}
