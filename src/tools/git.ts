import { execFileSync } from "child_process";
import type { BetterMcpConfig } from "../config.js";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";

const MAX_GIT_OUTPUT = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_LIMIT = 1000;

export interface GitStatus {
  branch: string;
  isClean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  lastCommit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  } | null;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Get the current git status of the project.
 * Uses --porcelain=v1 -z for NUL-separated output that handles
 * spaces, special characters, and renames correctly.
 */
export function status(workdir: string): GitStatus {
  ensureGitRepo(workdir);

  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workdir,
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: MAX_GIT_OUTPUT,
  }).trim();

  // Use --porcelain=v1 -z for NUL-separated, machine-parseable output
  // This correctly handles filenames with spaces, special chars, and renames
  const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: workdir,
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: MAX_GIT_OUTPUT,
  });

  const isClean = porcelain.length === 0;

  // Parse staged/unstaged/untracked
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  if (!isClean) {
    // Strip trailing NUL if present, then split on NUL
    const trimmed = porcelain.replace(/\0+$/, "");
    const entries = trimmed.split("\0");

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      // Minimum length: "XY " is 3 chars
      if (entry.length < 3) continue;

      const xy = entry.slice(0, 2);
      const file = entry.slice(3); // skip XY + space separator

      if (xy[0] !== " ") staged.push(file);
      if (xy[1] !== " " && xy[1] !== "?") unstaged.push(file);
      if (xy[1] === "?") untracked.push(file);

      // Handle renames (R) and copies (C): the next NUL-delimited entry
      // is the new filename. Skip it to avoid double-counting.
      if (xy[0] === "R" || xy[0] === "C") {
        i++; // skip the next entry (it's the new/destination filename)
      }
    }
  }

  // Ahead/behind
  let ahead = 0;
  let behind = 0;
  try {
    const revList = execFileSync(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { cwd: workdir, encoding: "utf-8", timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT }
    ).trim();
    if (revList) {
      const parts = revList.split("\t");
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    }
  } catch {
    // No upstream or detached HEAD
  }

  // Last commit
  let lastCommit: GitStatus["lastCommit"] = null;
  try {
    const log = execFileSync(
      "git",
      ["log", "-1", "--format=%H%n%s%n%an%n%ai"],
      { cwd: workdir, encoding: "utf-8", timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT }
    ).trim();
    if (log) {
      const parts = log.split("\n");
      lastCommit = {
        hash: parts[0] || "",
        message: parts[1] || "",
        author: parts[2] || "",
        date: parts[3] || "",
      };
    }
  } catch {
    // No commits yet
  }

  return { branch, isClean, staged, unstaged, untracked, ahead, behind, lastCommit };
}

/**
 * Get git log entries.
 */
export function log(
  workdir: string,
  limit = 10
): GitLogEntry[] {
  ensureGitRepo(workdir);

  // Clamp and validate limit
  const safeLimit = Math.max(1, Math.min(limit, MAX_LOG_LIMIT));

  const output = execFileSync(
    "git",
    ["log", `--max-count=${safeLimit}`, "--format=%H%n%s%n%an%n%ai%n---"],
    { cwd: workdir, encoding: "utf-8", timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT }
  ).trim();

  if (!output) return [];

  const entries: GitLogEntry[] = [];
  const blocks = output.split("\n---\n");

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 4) continue;
    entries.push({
      hash: lines[0],
      message: lines[1],
      author: lines[2],
      date: lines[3],
    });
  }

  return entries;
}

/**
 * Get git diff.
 */
export function diff(
  workdir: string,
  target?: string
): { files: string[]; patch: string } {
  ensureGitRepo(workdir);

  // Validate target: only allow valid git refs (alphanumeric, dots, dashes, underscores, slashes, colons)
  const diffTarget = target || "HEAD";
  if (typeof diffTarget !== "string" || diffTarget.length > 500) {
    throw new Error("Invalid git diff target");
  }

  // Reject dangerous patterns in git refs
  if (/[\x00-\x1f\x7f"';$`|&(){}<>#!]/.test(diffTarget)) {
    throw new Error("Invalid git diff target: contains prohibited characters");
  }

  // Use execFileSync with arguments array to prevent command injection
  const files = execFileSync(
    "git",
    ["diff", "--name-only", diffTarget],
    { cwd: workdir, encoding: "utf-8", timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT }
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const patch = execFileSync(
    "git",
    ["diff", diffTarget],
    { cwd: workdir, encoding: "utf-8", timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT }
  ).trim();

  return { files, patch };
}

function ensureGitRepo(workdir: string): void {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("Not a git repository");
  }
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

/**
 * Get git tool definitions for the MCP server.
 * Tools are only returned if at least one project has git enabled.
 */
export function getToolDefinitions(config: BetterMcpConfig, hasGit: boolean): ToolDefinition[] {
  if (!hasGit) return [];

  return [
    {
      name: "git_status",
      description: "Get the current git status: branch, clean/dirty, staged/unstaged/untracked files, ahead/behind remote, last commit.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const result = status(ctx.project.root);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
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
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.floor(args.limit)) : 10;
        const result = log(ctx.project.root, limit);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const target = typeof args.target === "string" && args.target.length > 0
          ? args.target : undefined;
        const result = diff(ctx.project.root, target);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
  ];
}

// Need to import BetterMcpConfig for the type
