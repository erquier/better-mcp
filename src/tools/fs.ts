import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync } from "fs";
import { resolve, isAbsolute, sep, relative } from "path";
import { execFileSync } from "child_process";

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_SEARCH_LIMIT = 500;
const MAX_LIST_DIRECTORY_LIMIT = 10000;

/**
 * Read a file with pagination support.
 */
export function readFile(
  filePath: string,
  allowedPaths: string[],
  offset = 1,
  limit = 500,
  maxFileSize?: number
): { content: string; totalLines: number; fileSize: number } {
  const abs = resolvePath(filePath, allowedPaths);
  const maxSize = maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // Check file size before reading
  const stats = statSync(abs);
  if (stats.size > maxSize) {
    throw new Error(
      `File too large: ${stats.size} bytes exceeds limit of ${maxSize} bytes`
    );
  }

  const content = readFileSync(abs, { encoding: "utf-8" });
  const lines = content.split("\n");
  const totalLines = lines.length;
  const fileSize = Buffer.byteLength(content, "utf-8");

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

  const dir = abs.split(sep).slice(0, -1).join(sep);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(abs, content, { encoding: "utf-8" });
  return { path: abs, bytesWritten: Buffer.byteLength(content, "utf-8") };
}

/**
 * Search for a regex pattern in files within allowed paths.
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
  const args: string[] = [
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
    // rg returns exit code 1 when no matches — not an error
    const err = e as { stderr?: string; stdout?: string; status?: number; message?: string };
    if (err.status === 1) {
      return { matches: [] };
    }
    throw new Error("Search failed");
  }

  const matches = output
    .split("\n")
    .filter(Boolean)
    .slice(0, safeLimit)
    .map((line) => {
      const sepIdx = line.indexOf(":");
      const sepIdx2 = line.indexOf(":", sepIdx + 1);
      if (sepIdx === -1 || sepIdx2 === -1) return null;
      return {
        file: line.slice(0, sepIdx),
        line: parseInt(line.slice(sepIdx + 1, sepIdx2), 10),
        content: line.slice(sepIdx2 + 1),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

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

  // Ensure the resolved path doesn't escape via symlinks
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    // If realpath fails (e.g., file doesn't exist), use the resolved path
    realAbs = abs;
  }

  // Check if the real path is within any of the allowed paths
  const allowed = allowedPaths.some((p) => {
    const resolvedAllowed = resolve(p);
    return realAbs.startsWith(resolvedAllowed + sep) || realAbs === resolvedAllowed;
  });

  if (!allowed) {
    throw new Error("Access denied: path is not within allowed paths");
  }

  return abs;
}
