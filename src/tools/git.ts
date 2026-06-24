import { execSync } from "child_process";

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
 */
export function status(workdir: string): GitStatus {
  ensureGitRepo(workdir);

  const branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
    cwd: workdir,
    encoding: "utf-8",
  }).trim();

  // Check if clean
  const porcelain = execSync("git status --porcelain", {
    cwd: workdir,
    encoding: "utf-8",
  }).trim();
  const isClean = porcelain.length === 0;

  // Parse staged/unstaged/untracked
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  if (!isClean) {
    for (const line of porcelain.split("\n")) {
      const status = line.slice(0, 2);
      const file = line.slice(3);
      if (status[0] !== " ") staged.push(file);
      if (status[1] !== " " && status[1] !== "?") unstaged.push(file);
      if (status[1] === "?") untracked.push(file);
    }
  }

  // Ahead/behind
  let ahead = 0;
  let behind = 0;
  try {
    const revList = execSync(
      "git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null",
      { cwd: workdir, encoding: "utf-8" }
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
    const log = execSync(
      'git log -1 --format="%H%n%s%n%an%n%ai" 2>/dev/null',
      { cwd: workdir, encoding: "utf-8" }
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

  const output = execSync(
    `git log --max-count=${limit} --format="%H%n%s%n%an%n%ai%n---" 2>/dev/null`,
    { cwd: workdir, encoding: "utf-8" }
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

  const diffTarget = target || "HEAD";
  const filesCmd = `git diff --name-only ${diffTarget} 2>/dev/null`;
  const patchCmd = `git diff ${diffTarget} 2>/dev/null`;

  const files = execSync(filesCmd, { cwd: workdir, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  const patch = execSync(patchCmd, { cwd: workdir, encoding: "utf-8" }).trim();

  return { files, patch };
}

function ensureGitRepo(workdir: string): void {
  try {
    execSync("git rev-parse --git-dir 2>/dev/null", {
      cwd: workdir,
      encoding: "utf-8",
    });
  } catch {
    throw new Error("Not a git repository");
  }
}
