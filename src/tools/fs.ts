import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, lstatSync, readlinkSync, openSync, readSync, closeSync, type Dirent } from "fs";
import { resolve, isAbsolute, sep, dirname, basename, extname } from "path";
import { execFileSync } from "child_process";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";
import type { BetterMcpConfig } from "../config.js";

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_SEARCH_LIMIT = 500;
const MAX_LIST_DIRECTORY_LIMIT = 10000;
const BINARY_DETECTION_BYTES = 1024;

/**
 * Read a file with pagination support.
 * Detects binary files and returns metadata instead of content for them.
 */
export function readFile(
  filePath: string,
  allowedPaths: string[],
  offset = 1,
  limit = 500,
  maxFileSize?: number
): { content: string; totalLines: number; fileSize: number } | { binary: true; size: number; hint: string } {
  const abs = resolvePath(filePath, allowedPaths);
  const maxSize = maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // Check file size before reading
  const stats = statSync(abs);
  const fileSize = stats.size; // actual bytes on disk
  if (fileSize > maxSize) {
    throw new Error(
      `File too large: ${fileSize} bytes exceeds limit of ${maxSize} bytes`
    );
  }

  // Binary detection: read first 1024 bytes and check for null bytes
  const fd = openSync(abs, "r");
  const buffer = Buffer.alloc(BINARY_DETECTION_BYTES);
  const bytesRead = readSync(fd, buffer, 0, BINARY_DETECTION_BYTES, 0);
  closeSync(fd);

  if (buffer.slice(0, bytesRead).includes(0)) {
    return { binary: true, size: fileSize, hint: "application/octet-stream" };
  }

  const content = readFileSync(abs, { encoding: "utf-8" });
  const lines = content.split("\n");
  const totalLines = lines.length;

  const start = Math.max(0, offset - 1);
  const end = Math.min(start + limit, totalLines);
  const sliced = lines.slice(start, end);

  return {
    content: sliced.join("\n"),
    totalLines,
    fileSize,
  };
}

/**
 * Write content to a file. Creates parent directories if needed.
 */
export function writeFile(
  filePath: string,
  content: string,
  allowedPaths: string[]
): { path: string; bytesWritten: number } {
  const abs = resolvePath(filePath, allowedPaths);

  // Limit total write size to 10MB
  if (Buffer.byteLength(content, "utf-8") > 10 * 1024 * 1024) {
    throw new Error("Write content exceeds maximum allowed size of 10MB");
  }

  // Use path.dirname for correct parent directory resolution
  const dir = dirname(abs);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(abs, content, { encoding: "utf-8" });
  return { path: abs, bytesWritten: Buffer.byteLength(content, "utf-8") };
}

/**
 * Search for a regex pattern in files within allowed paths.
 * Uses ripgrep with --json output for reliable parsing.
 */
export function searchFiles(
  pattern: string,
  allowedPaths: string[],
  fileGlob?: string,
  limit = 50
): { matches: { file: string; line: number; content: string }[] } {
  // Validate and sanitize inputs
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("Search pattern must be a non-empty string");
  }
  if (pattern.length > 500) {
    throw new Error("Search pattern exceeds maximum length of 500 characters");
  }

  const safeLimit = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);

  // Build args array to avoid shell injection
  // Use --json for reliable parsing, --no-config to avoid alias/color issues
  const args: string[] = [
    "--json",
    "--no-config",
    "--color=never",
    "--no-heading",
    "--line-number",
    "--max-count", String(safeLimit),
    pattern,
    ...allowedPaths,
  ];

  if (fileGlob) {
    // Validate fileGlob: only allow safe characters
    if (typeof fileGlob !== "string" || fileGlob.length > 200) {
      throw new Error("Invalid file glob pattern");
    }
    // Only allow alphanumeric, dots, stars, dashes, underscores, slashes, and the extension pattern
    if (!/^[\w.*\-_/?]+$/.test(fileGlob)) {
      throw new Error("File glob contains invalid characters");
    }
    args.push("--glob", fileGlob);
  }

  let output: string;
  try {
    output = execFileSync("rg", args, {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; status?: number; code?: string; signal?: string };
    // rg returns exit code 1 when no matches — not an error.
    if (err.status === 1) {
      return { matches: [] };
    }
    // ripgrep not installed / not in PATH → fall back to a pure-Node search so
    // the tool works in ANY project without extra setup (drop-in).
    if (err.code === "ENOENT") {
      return { matches: nodeSearch(pattern, allowedPaths, fileGlob, safeLimit) };
    }
    if (err.signal === "SIGTERM") throw new Error("Search timed out");
    throw new Error(err.stderr ? `Search failed: ${String(err.stderr).slice(0, 300)}` : "Search failed");
  }

  // Parse JSON lines output from rg --json
  const matches = output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "match") {
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            content: parsed.data.lines.text,
          };
        }
      } catch {
        // skip unparseable lines
      }
      return null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .slice(0, safeLimit);

  return { matches };
}

/**
 * List files in a directory.
 */
export function listDirectory(
  dirPath: string,
  allowedPaths: string[]
): { name: string; type: "file" | "dir" | "symlink"; size: number }[] {
  const abs = resolvePath(dirPath, allowedPaths);

  const entries = readdirSync(abs, { withFileTypes: true });
  const results: { name: string; type: "file" | "dir" | "symlink"; size: number }[] = [];

  for (const entry of entries) {
    if (results.length >= MAX_LIST_DIRECTORY_LIMIT) break;
    try {
      const fullPath = resolve(abs, entry.name);
      const stats = statSync(fullPath);
      let type: "file" | "dir" | "symlink";
      if (entry.isSymbolicLink()) {
        type = "symlink";
      } else if (entry.isDirectory()) {
        type = "dir";
      } else {
        type = "file";
      }
      results.push({ name: entry.name, type, size: stats.size });
    } catch {
      // Skip inaccessible entries
    }
  }

  return results;
}

/**
 * Canonicalize a path even when it (or part of it) does not exist yet.
 *
 * realpathSync only works for existing paths. For a new file (fs_write), the
 * naive fallback to the *lexical* path lets an attacker escape the sandbox: if a
 * parent component is a symlink pointing outside allowedPaths, the lexical path
 * still looks "inside" while the OS write follows the link to the real target.
 *
 * This resolves the deepest existing ancestor with realpathSync and re-appends
 * the non-existing tail, and explicitly follows symlinks (including DANGLING
 * symlinks that realpathSync would throw on) so the returned path reflects where
 * the OS will actually read/write. The allowedPaths check then runs on this
 * canonical path, closing the symlinked-parent escape.
 */
function canonicalize(abs: string, depth = 0): string {
  if (depth > 64) throw new Error("Too many symlink levels");
  let current = abs;
  const tail: string[] = [];

  for (;;) {
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(current);
    } catch {
      st = null;
    }

    if (st) {
      let real: string;
      if (st.isSymbolicLink()) {
        // Follow the link target ourselves so dangling symlinks still resolve to
        // their (non-existing) destination instead of being treated as "inside".
        const link = readlinkSync(current);
        const target = isAbsolute(link) ? link : resolve(dirname(current), link);
        real = canonicalize(target, depth + 1);
      } else {
        try {
          real = realpathSync(current);
        } catch {
          real = resolve(current);
        }
      }
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    }

    const parent = dirname(current);
    if (parent === current) return resolve(abs); // reached filesystem root
    tail.push(basename(current));
    current = parent;
  }
}

function resolvePath(filePath: string, allowedPaths: string[]): string {
  // Validate input type
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("File path must be a non-empty string");
  }

  // Reject null bytes and path traversal sequences
  if (filePath.includes("\0")) {
    throw new Error("File path contains null bytes");
  }

  // Resolve to absolute path (handles ../.. traversal)
  const abs = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(process.cwd(), filePath);

  // Canonical path the OS will actually touch (resolves symlinks even for
  // not-yet-existing files / through symlinked parent dirs).
  const realAbs = canonicalize(abs);

  // Check if the real path is within any of the allowed paths (also canonicalized
  // so a symlinked allowed root still matches).
  const allowed = allowedPaths.some((p) => {
    const resolvedAllowed = canonicalize(resolve(p));
    return realAbs.startsWith(resolvedAllowed + sep) || realAbs === resolvedAllowed;
  });

  if (!allowed) {
    throw new Error("Access denied: path is not within allowed paths");
  }

  // Return the canonical path so reads/writes operate on the real location, never
  // through an unresolved symlink.
  return realAbs;
}

const SEARCH_SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo", "coverage", ".cache", "vendor", "target",
]);
const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Convert a simple glob (*, ?) into a RegExp anchored to the basename. */
function globToRegExp(glob: string): RegExp {
  const re = glob
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : /[.\\+^$()[\]{}|]/.test(c) ? "\\" + c : c))
    .join("");
  return new RegExp("^" + re + "$");
}

/**
 * Pure-Node recursive content search — fallback when ripgrep isn't installed.
 * Walks allowedPaths, skips heavy/binary files, and matches `pattern` (as a
 * RegExp, or literal substring if the pattern isn't a valid RegExp) per line.
 * Exported for tests; production calls it via searchFiles' ripgrep fallback.
 */
export function nodeSearch(
  pattern: string,
  allowedPaths: string[],
  fileGlob: string | undefined,
  limit: number,
): { file: string; line: number; content: string }[] {
  let matcher: (s: string) => boolean;
  try {
    const re = new RegExp(pattern);
    matcher = (s) => re.test(s);
  } catch {
    matcher = (s) => s.includes(pattern);
  }
  const nameRe = fileGlob ? globToRegExp(fileGlob) : null;
  const matches: { file: string; line: number; content: string }[] = [];

  const visit = (dir: string): void => {
    if (matches.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) return;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        visit(full);
      } else if (entry.isFile()) {
        if (nameRe && !nameRe.test(entry.name)) continue;
        if (extname(entry.name) === "") {
          // allow extensionless (configs, scripts) but still size-guard below
        }
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        let content: string;
        try {
          content = readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue; // skip binary
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= limit) return;
          if (matcher(lines[i])) {
            matches.push({ file: full, line: i + 1, content: lines[i].slice(0, 1000) });
          }
        }
      }
    }
  };

  for (const p of allowedPaths) {
    if (matches.length >= limit) break;
    try {
      visit(resolve(p));
    } catch {
      // ignore unreadable root
    }
  }
  return matches.slice(0, limit);
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

/**
 * Get filesystem tool definitions for the MCP server.
 * Tools are only returned if at least one project has fs tools enabled.
 */
export function getToolDefinitions(config: BetterMcpConfig, hasFs: boolean): ToolDefinition[] {
  if (!hasFs) return [];

  return [
    {
      name: "fs_read",
      description: "Read a file with pagination. Returns content, total lines, and file size.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (absolute or relative to project root)" },
          offset: { type: "number", description: "Starting line (1-indexed)", default: 1 },
          limit: { type: "number", description: "Max lines to return (max 2000)", default: 500 },
        },
        required: ["path"],
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const path = args.path;
        if (typeof path !== "string" || path.length === 0) {
          throw new Error("fs_read requires a non-empty string 'path'");
        }
        const offset = typeof args.offset === "number" && Number.isFinite(args.offset)
          ? Math.max(1, Math.floor(args.offset)) : 1;
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(1, Math.floor(args.limit)), 2000) : 500;
        const allowed = ctx.project.tools.fs?.allowedPaths || [ctx.project.root];
        const maxFileSize = ctx.project.tools.fs?.maxFileSize;
        const result = readFile(path, allowed, offset, limit, maxFileSize);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
    {
      name: "fs_write",
      description: `Write content to a file. Creates directories if needed. Handles escaping correctly.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      requiresAuth: () => true,
      handler: async (args, ctx) => {
        const path = args.path;
        if (typeof path !== "string" || path.length === 0) {
          throw new Error("fs_write requires a non-empty string 'path'");
        }
        const content = args.content;
        if (typeof content !== "string") {
          throw new Error("fs_write requires a string 'content'");
        }
        const allowed = ctx.project.tools.fs?.allowedPaths || [ctx.project.root];
        const result = writeFile(path, content, allowed);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
    {
      name: "fs_search",
      description: "Search files by regex pattern within the project.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search" },
          fileGlob: { type: "string", description: "Optional file glob filter (e.g. *.ts, *.py)" },
          limit: { type: "number", description: "Max results", default: 50 },
        },
        required: ["pattern"],
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const pattern = args.pattern;
        if (typeof pattern !== "string" || pattern.length === 0) {
          throw new Error("fs_search requires a non-empty string 'pattern'");
        }
        const fileGlob = typeof args.fileGlob === "string" ? args.fileGlob : undefined;
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.floor(args.limit)) : 50;
        const allowed = ctx.project.tools.fs?.allowedPaths || [ctx.project.root];
        const result = searchFiles(pattern, allowed, fileGlob, limit);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
    {
      name: "fs_list",
      description: "List directory contents.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const path = args.path;
        if (typeof path !== "string" || path.length === 0) {
          throw new Error("fs_list requires a non-empty string 'path'");
        }
        const allowed = ctx.project.tools.fs?.allowedPaths || [ctx.project.root];
        const result = listDirectory(path, allowed);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
  ];
}
