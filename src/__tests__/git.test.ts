import { describe, it, expect, beforeAll } from "vitest";
import { status, log, diff } from "../tools/git.js";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const WORKDIR = mkdtempSync(join(tmpdir(), "better-mcp-git-test-"));

beforeAll(() => {
  // Initialize a git repo in the temp directory
  execFileSync("git", ["init"], { cwd: WORKDIR, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: WORKDIR, encoding: "utf-8", stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: WORKDIR, encoding: "utf-8", stdio: "pipe",
  });
  // Create an initial file and commit
  writeFileSync(join(WORKDIR, "README.md"), "# Test Repo\n");
  execFileSync("git", ["add", "README.md"], {
    cwd: WORKDIR, encoding: "utf-8", stdio: "pipe",
  });
  execFileSync("git", ["commit", "-m", "initial commit"], {
    cwd: WORKDIR, encoding: "utf-8", stdio: "pipe",
  });
});

describe("git.status", () => {
  it("should return git status with branch name", () => {
    const result = status(WORKDIR);
    expect(result.branch).toBeTruthy();
    expect(typeof result.branch).toBe("string");
  });

  it("should return isClean boolean", () => {
    const result = status(WORKDIR);
    expect(typeof result.isClean).toBe("boolean");
  });

  it("should return staged, unstaged, untracked arrays", () => {
    const result = status(WORKDIR);
    expect(Array.isArray(result.staged)).toBe(true);
    expect(Array.isArray(result.unstaged)).toBe(true);
    expect(Array.isArray(result.untracked)).toBe(true);
  });

  it("should return ahead and behind as numbers", () => {
    const result = status(WORKDIR);
    expect(typeof result.ahead).toBe("number");
    expect(typeof result.behind).toBe("number");
  });

  it("should return lastCommit info when commits exist", () => {
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
  it("should return log entries", () => {
    const entries = log(WORKDIR);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("should return entries with hash, message, author, date", () => {
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
    const entries = log(WORKDIR, 1);
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it("should clamp limit to valid range", () => {
    const entries = log(WORKDIR, 0); // should clamp to 1
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("should throw for non-git directory", () => {
    expect(() => log("/tmp")).toThrow("Not a git repository");
  });
});

describe("git.diff", () => {
  it("should return diff with files and patch", () => {
    const result = diff(WORKDIR);
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("patch");
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.patch).toBe("string");
  });

  it("should accept a custom diff target", () => {
    const result = diff(WORKDIR, "HEAD");
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
