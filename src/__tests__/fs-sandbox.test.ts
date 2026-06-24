import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { writeFile, readFile, nodeSearch } from "../tools/fs.js";

// Sandbox-escape regression tests (Frente seguridad v0.2) + Node search fallback.

let root: string; // allowed sandbox
let outside: string; // forbidden area

beforeEach(() => {
  // realpathSync because macOS/CI tmpdirs can themselves be symlinks.
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), "bmcp-sandbox-")));
  root = resolve(base, "allowed");
  outside = resolve(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(resolve(root, ".."), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("fs_write sandbox", () => {
  it("writes to a legit nested path inside the sandbox", () => {
    const target = resolve(root, "sub/deep/file.txt");
    const res = writeFile(target, "ok", [root]);
    expect(existsSync(target)).toBe(true);
    expect(res.path).toBe(target);
  });

  it("DENIES writing through a symlinked parent that points outside (existing target)", () => {
    // allowed/link -> outside ; writing allowed/link/evil.txt must NOT land in outside
    symlinkSync(outside, resolve(root, "link"), "dir");
    expect(() => writeFile(resolve(root, "link/evil.txt"), "pwned", [root])).toThrow(
      /Access denied/,
    );
    expect(existsSync(resolve(outside, "evil.txt"))).toBe(false);
  });

  it("DENIES writing through a DANGLING symlink that points outside", () => {
    const danglingTarget = resolve(outside, "ghost");
    symlinkSync(danglingTarget, resolve(root, "badlink"), "dir");
    expect(() => writeFile(resolve(root, "badlink/x.txt"), "pwned", [root])).toThrow(
      /Access denied/,
    );
    expect(existsSync(resolve(danglingTarget, "x.txt"))).toBe(false);
  });

  it("DENIES reading a file outside via a symlinked parent", () => {
    writeFileSync(resolve(outside, "secret.txt"), "top-secret", "utf-8");
    symlinkSync(outside, resolve(root, "peek"), "dir");
    expect(() => readFile(resolve(root, "peek/secret.txt"), [root])).toThrow(/Access denied/);
  });

  it("still blocks classic ../ traversal", () => {
    expect(() => readFile(resolve(root, "../../etc/passwd"), [root])).toThrow(/Access denied/);
  });
});

describe("nodeSearch (ripgrep fallback)", () => {
  it("finds matches recursively and respects the file glob", () => {
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src/a.ts"), "const x = 1;\nTODO: fix\n", "utf-8");
    writeFileSync(resolve(root, "src/b.js"), "TODO: other\n", "utf-8");
    writeFileSync(resolve(root, "notes.md"), "TODO: doc\n", "utf-8");

    const all = nodeSearch("TODO", [root], undefined, 50);
    expect(all.length).toBe(3);

    const tsOnly = nodeSearch("TODO", [root], "*.ts", 50);
    expect(tsOnly.length).toBe(1);
    expect(tsOnly[0].file).toBe(resolve(root, "src/a.ts"));
    expect(tsOnly[0].line).toBe(2);
  });

  it("skips node_modules and binary files", () => {
    mkdirSync(resolve(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(resolve(root, "node_modules/pkg/index.js"), "MATCHME\n", "utf-8");
    writeFileSync(resolve(root, "bin.dat"), "before\0MATCHME\0after", "utf-8");
    writeFileSync(resolve(root, "real.txt"), "MATCHME\n", "utf-8");

    const res = nodeSearch("MATCHME", [root], undefined, 50);
    expect(res.length).toBe(1);
    expect(res[0].file).toBe(resolve(root, "real.txt"));
  });
});
