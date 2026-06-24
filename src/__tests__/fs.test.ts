import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readFile,
  writeFile,
  searchFiles,
  listDirectory,
} from "../tools/fs.js";
import { mkdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from "fs";
import { resolve, sep } from "path";

const TEST_DIR = "/tmp/better-mcp-test";
const ALLOWED_PATHS = [TEST_DIR];

// Ensure rg is available
function ensureRgAvailable(): boolean {
  try {
    const { execFileSync } = require("child_process");
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  // Create test directory
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Clean up test directory
  try {
    const { rmSync } = require("fs");
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("readFile", () => {
  const testFilePath = resolve(TEST_DIR, "test-read.txt");

  beforeEach(() => {
    const lines: string[] = [];
    for (let i = 1; i <= 50; i++) {
      lines.push(`Line ${i} content`);
    }
    writeFileSync(testFilePath, lines.join("\n"), "utf-8");
  });

  afterEach(() => {
    try {
      unlinkSync(testFilePath);
    } catch {
      // ignore
    }
  });

  it("should read a file and return content, totalLines, fileSize", () => {
    const result = readFile(testFilePath, ALLOWED_PATHS);
    expect(result.totalLines).toBe(50);
    expect(result.content).toContain("Line 1 content");
    expect(result.content).toContain("Line 50 content");
    expect(result.fileSize).toBeGreaterThan(0);
  });

  it("should paginate with offset and limit", () => {
    // offset is 1-indexed
    const result = readFile(testFilePath, ALLOWED_PATHS, 10, 3);
    expect(result.content).toBe("Line 10 content\nLine 11 content\nLine 12 content");
  });

  it("should handle offset beyond total lines", () => {
    const result = readFile(testFilePath, ALLOWED_PATHS, 100, 10);
    expect(result.content).toBe("");
    expect(result.totalLines).toBe(50);
  });

  it("should throw for non-existent file", () => {
    expect(() =>
      readFile("/tmp/better-mcp-test/nonexistent.txt", ALLOWED_PATHS),
    ).toThrow();
  });

  it("should throw for path traversal outside allowed paths", () => {
    expect(() =>
      readFile(TEST_DIR + "/../../etc/passwd", ALLOWED_PATHS),
    ).toThrow("Access denied");
  });

  it("should throw for null bytes in path", () => {
    expect(() =>
      readFile(TEST_DIR + "\0malicious", ALLOWED_PATHS),
    ).toThrow("null bytes");
  });

  it("should throw for empty file path", () => {
    expect(() => readFile("", ALLOWED_PATHS)).toThrow(
      "File path must be a non-empty string",
    );
  });

  it("should throw for files exceeding max size", () => {
    // Create a file larger than 1 byte to test size limits
    const smallLimitPath = resolve(TEST_DIR, "small-limit.txt");
    writeFileSync(smallLimitPath, "hello world", "utf-8");
    expect(() => readFile(smallLimitPath, ALLOWED_PATHS, 1, 10, 1)).toThrow(
      "File too large",
    );
    unlinkSync(smallLimitPath);
  });
});

describe("writeFile", () => {
  it("should write file and return path and bytesWritten", () => {
    const filePath = resolve(TEST_DIR, "subdir", "test-write.txt");
    const result = writeFile(filePath, "hello world", ALLOWED_PATHS);
    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBe(11);
    // Verify file exists
    expect(existsSync(filePath)).toBe(true);
  });

  it("should create parent directories automatically", () => {
    const deepPath = resolve(TEST_DIR, "a", "b", "c", "deep.txt");
    writeFile(deepPath, "deep content", ALLOWED_PATHS);
    expect(existsSync(deepPath)).toBe(true);
  });

  it("should overwrite existing file", () => {
    const filePath = resolve(TEST_DIR, "overwrite.txt");
    writeFile(filePath, "first content", ALLOWED_PATHS);
    writeFile(filePath, "second content", ALLOWED_PATHS);
    const result = readFile(filePath, ALLOWED_PATHS);
    expect(result.content.trim()).toBe("second content");
  });

  it("should throw for content exceeding 10MB", () => {
    const filePath = resolve(TEST_DIR, "large.txt");
    const largeContent = "a".repeat(11 * 1024 * 1024);
    expect(() => writeFile(filePath, largeContent, ALLOWED_PATHS)).toThrow(
      "exceeds maximum allowed size of 10MB",
    );
  });

  it("should throw for path outside allowed paths", () => {
    expect(() =>
      writeFile("/tmp/unauthorized.txt", "content", ALLOWED_PATHS),
    ).toThrow("Access denied");
  });

  it("should throw for empty path", () => {
    expect(() => writeFile("", "content", ALLOWED_PATHS)).toThrow(
      "File path must be a non-empty string",
    );
  });
});

describe("searchFiles", () => {
  beforeEach(() => {
    // Create files with searchable content
    writeFileSync(
      resolve(TEST_DIR, "alpha.txt"),
      "apple\nbanana\ncherry\n",
      "utf-8",
    );
    writeFileSync(
      resolve(TEST_DIR, "beta.txt"),
      "banana\ndate\nelderberry\n",
      "utf-8",
    );
    writeFileSync(
      resolve(TEST_DIR, "numbers.txt"),
      "123\n456\n789\n",
      "utf-8",
    );
  });

  it("should find pattern matches in files", () => {
    const result = searchFiles("banana", [TEST_DIR]);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const foundIn = result.matches.map((m) => m.file);
    expect(
      foundIn.some((f) => f.includes("alpha.txt") || f.includes("beta.txt")),
    ).toBe(true);
  });

  it("should return empty matches when pattern not found", () => {
    const result = searchFiles("zzzNOTFOUNDzzz", [TEST_DIR]);
    expect(result.matches).toEqual([]);
  });

  it("should filter by file glob", () => {
    const result = searchFiles("banana", [TEST_DIR], "*.txt");
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });

  it("should return empty for glob matching no files", () => {
    const result = searchFiles("banana", [TEST_DIR], "*.md");
    expect(result.matches).toEqual([]);
  });

  it("should throw for empty pattern", () => {
    expect(() => searchFiles("", [TEST_DIR])).toThrow(
      "Search pattern must be a non-empty string",
    );
  });

  it("should throw for pattern exceeding 500 chars", () => {
    expect(() => searchFiles("a".repeat(501), [TEST_DIR])).toThrow(
      "exceeds maximum length",
    );
  });

  it("should throw for invalid fileGlob with dangerous chars", () => {
    expect(() => searchFiles("test", [TEST_DIR], "*.txt;rm -rf /")).toThrow(
      "contains invalid characters",
    );
  });

  it("should limit results", () => {
    // Create a file with many matching lines
    writeFileSync(
      resolve(TEST_DIR, "many-matches.txt"),
      Array.from({ length: 20 }, (_, i) => `match line ${i + 1}`).join("\n"),
      "utf-8",
    );
    const result = searchFiles("match", [TEST_DIR], undefined, 3);
    expect(result.matches.length).toBeLessThanOrEqual(3);
  });
});

describe("listDirectory", () => {
  beforeEach(() => {
    mkdirSync(resolve(TEST_DIR, "subdir1"), { recursive: true });
    mkdirSync(resolve(TEST_DIR, "subdir2"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, "file1.txt"), "content1", "utf-8");
    writeFileSync(resolve(TEST_DIR, "file2.txt"), "content2", "utf-8");
  });

  it("should list directory entries with name, type, size", () => {
    const result = listDirectory(TEST_DIR, ALLOWED_PATHS);
    const names = result.map((e) => e.name);
    expect(names).toContain("subdir1");
    expect(names).toContain("subdir2");
    expect(names).toContain("file1.txt");
    expect(names).toContain("file2.txt");

    const file1 = result.find((e) => e.name === "file1.txt");
    expect(file1?.type).toBe("file");
    expect(file1?.size).toBeGreaterThan(0);

    const subdir1 = result.find((e) => e.name === "subdir1");
    expect(subdir1?.type).toBe("dir");
  });

  it("should throw for path outside allowed paths", () => {
    expect(() => listDirectory("/etc", ALLOWED_PATHS)).toThrow(
      "Access denied",
    );
  });

  it("should throw for non-existent directory", () => {
    expect(() =>
      listDirectory("/tmp/better-mcp-test/nonexistent", ALLOWED_PATHS),
    ).toThrow();
  });

  it("should throw for empty path", () => {
    expect(() => listDirectory("", ALLOWED_PATHS)).toThrow(
      "File path must be a non-empty string",
    );
  });
});
