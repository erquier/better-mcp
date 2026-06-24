import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, relative, isAbsolute, sep } from "path";

/**
 * Read a file with pagination support.
 */
export function readFile(
  filePath: string,
  allowedPaths: string[],
  offset = 1,
  limit = 500
): { content: string; totalLines: number; fileSize: number } {
  const abs = resolvePath(filePath, allowedPaths);
  const content = execSync(`cat "${abs}"`, { encoding: "utf-8" });
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
  const dir = abs.split(sep).slice(0, -1).join(sep);
  execSync(`mkdir -p "${dir}"`, { encoding: "utf-8" });
  execSync(`cat > "${abs}"`, { input: content, encoding: "utf-8" });
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
  const searchPath = allowedPaths.map((p) => `"${p}"`).join(" ");
  const globFilter = fileGlob ? `--glob "${fileGlob}"` : "";
  const cmd = `rg --no-heading --line-number --max-count 5 ${globFilter} -m ${limit} "${pattern}" ${searchPath} 2>/dev/null || true`;

  const output = execSync(cmd, { encoding: "utf-8" });
  const matches = output
    .split("\n")
    .filter(Boolean)
    .slice(0, limit)
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
  const output = execSync(
    `ls -1a "${abs}" 2>/dev/null && echo "---TYPES---" && stat --format="%F:%s:%n" "${abs}"/* "${abs}"/.* 2>/dev/null || true`,
    { encoding: "utf-8" }
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      if (parts.length < 3) return null;
      const type = parts[0].includes("directory")
        ? ("dir" as const)
        : parts[0].includes("symlink")
        ? ("symlink" as const)
        : ("file" as const);
      return {
        name: parts.slice(2).join(":"),
        type,
        size: parseInt(parts[1], 10),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

function resolvePath(filePath: string, allowedPaths: string[]): string {
  const abs = isAbsolute(filePath)
    ? filePath
    : resolve(process.cwd(), filePath);

  const allowed = allowedPaths.some((p) => abs.startsWith(p));
  if (!allowed) {
    throw new Error(
      `Access denied: "${filePath}" is not within allowed paths: ${allowedPaths.join(", ")}`
    );
  }

  return abs;
}
