import { describe, it, expect, beforeEach } from "vitest";
import { status, log, diff } from "../tools/git.js";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";

const WORKDIR = "/tmp/better-mcp";

/**
 * Helper to check if we're in a git repo.
 */
function isGitRepo(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: WORKDIR,
      encoding: "utf-8",
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper to get initial commit hash for diff tests.
 */
function getFirstCommitHash(): string {
  const result = execFileSync(
    "git",
    ["rev-list", "--max-parents=0", "HEAD"],
    { cwd: WORKDIR, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return result.trim();
}

describe("git.status", () => {
  beforeEach(() => {
    if (!isGitRepo()) {
      console.warn("Not a git repo, skipping git tests...");
    }
  });

  it("should return git status with branch name", () => {
    if (!isGitRepo()) return;
    const result = status(WORKDIR);
    expect(result.branch).toBeTruthy();
    expect(typeof result.branch).toBe("string");
  });

  it("should return isClean boolean", () => {
    if (!isGitRepo()) return;
    const result = status(WORKDIR);
    expect(typeof result.isClean).toBe("boolean");
  });

  it("should return staged, unstaged, untracked arrays", () => {
    if (!isGitRepo()) return;
    const result = status(WORKDIR);
    expect(Array.isArray(result.staged)).toBe(true);
    expect(Array.isArray(result.unstaged)).toBe(true);
    expect(Array.isArray(result.untracked)).toBe(true);
  });

  it("should return ahead and behind as numbers", () => {
    if (!isGitRepo()) return;
    const result = status(WORKDIR);
    expect(typeof result.ahead).toBe("number");
    expect(typeof result.behind).toBe("number");
  });

  it("should return lastCommit info when commits exist", () => {
    if (!isGitRepo()) return;
    const result = status(WORKDIR);
    expect(result.lastCommit).not.toBeNull();
    if (result.lastCommit) {
      expect(result.lastCommit.hash).toBeTruthy();
      expect(result.lastCommit.message).toBeTruthy();
      expect(result.lastCommit.author).toBeTruthy();
      expect(result.lastCommit.date).toBeTruthy();
    }
  });

  it("should throw for non-git directory", () => {
    expect(() => status("/tmp")).toThrow("Not a git repository");
  });
});

describe("git.log", () => {
  beforeEach(() => {
    if (!isGitRepo()) {
      console.warn("Not a git repo, skipping git log tests...");
    }
  });

  it("should return log entries", () => {
    if (!isGitRepo()) return;
    const entries = log(WORKDIR);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("should return entries with hash, message, author, date", () => {
    if (!isGitRepo()) return;
    const entries = log(WORKDIR, 1);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0];
    expect(entry).toHaveProperty("hash");
    expect(entry).toHaveProperty("message");
    expect(entry).toHaveProperty("author");
    expect(entry).toHaveProperty("date");
    expect(typeof entry.hash).toBe("string");
    expect(entry.hash.length).toBeGreaterThan(0);
  });

  it("should respect the limit parameter", () => {
    if (!isGitRepo()) return;
    const entries = log(WORKDIR, 1);
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it("should clamp limit to valid range", () => {
    if (!isGitRepo()) return;
    const entries = log(WORKDIR, 0); // should clamp to 1
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("should throw for non-git directory", () => {
    expect(() => log("/tmp")).toThrow("Not a git repository");
  });
});

describe("git.diff", () => {
  beforeEach(() => {
    if (!isGitRepo()) {
      console.warn("Not a git repo, skipping git diff tests...");
    }
  });

  it("should return diff with files and patch", () => {
    if (!isGitRepo()) return;
    const result = diff(WORKDIR);
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("patch");
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.patch).toBe("string");
  });

  it("should accept a custom diff target", () => {
    if (!isGitRepo()) return;
    const firstHash = getFirstCommitHash();
    const result = diff(WORKDIR, firstHash);
    expect(result).toHaveProperty("files");
    expect(Array.isArray(result.files)).toBe(true);
  });

  it("should throw for invalid diff target with dangerous chars", () => {
    expect(() => diff(WORKDIR, "HEAD; rm -rf /")).toThrow(
      "contains prohibited characters",
    );
  });

  it("should throw for diff target exceeding 500 chars", () => {
    expect(() => diff(WORKDIR, "a".repeat(501))).toThrow(
      "Invalid git diff target",
    );
  });

  it("should throw for non-git directory", () => {
    expect(() => diff("/tmp")).toThrow("Not a git repository");
  });
});
