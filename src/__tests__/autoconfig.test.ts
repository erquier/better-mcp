import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { resolve, basename } from "path";
import { buildAutoConfig } from "../config.js";

// Zero-config drop-in: buildAutoConfig should derive a usable config from a repo.

let dir: string;
let savedDbUrl: string | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(resolve(tmpdir(), "bmcp-auto-")));
  // Make detection deterministic: only the per-test .env should drive db detection.
  savedDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("buildAutoConfig", () => {
  it("derives root, stack, commands, db and resources from a Node+Prisma repo", () => {
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({
        name: "my-app",
        description: "demo",
        scripts: { build: "tsc", test: "vitest", lint: "eslint", dev: "next dev", random: "x" },
      }),
      "utf-8",
    );
    writeFileSync(resolve(dir, "tsconfig.json"), "{}", "utf-8");
    mkdirSync(resolve(dir, "prisma"), { recursive: true });
    writeFileSync(resolve(dir, "prisma/schema.prisma"), "// schema", "utf-8");
    writeFileSync(resolve(dir, ".env"), 'DATABASE_URL="postgresql://u:p@localhost:5432/db"\n', "utf-8");
    writeFileSync(resolve(dir, "README.md"), "# readme", "utf-8");
    writeFileSync(resolve(dir, "CUADRE-HANDOFF.md"), "# handoff", "utf-8");

    const cfg = buildAutoConfig(dir);

    expect(cfg.name).toBe("my-app");
    expect(cfg.root).toBe(dir);
    expect(cfg.tools?.fs?.allowedPaths).toEqual([dir]);
    expect(cfg.stack).toContain("node");
    expect(cfg.stack).toContain("typescript");
    expect(cfg.stack).toContain("prisma");

    const cmds = cfg.tools?.shell?.commands ?? {};
    expect(cmds.build).toBe("npm run build");
    expect(cmds.test).toBe("npm run test");
    expect(cmds.lint).toBe("npm run lint");
    expect(cmds.dev).toBe("npm run dev");
    expect(cmds.random).toBeUndefined(); // only the curated set is exposed
    expect(cmds["migrate-status"]).toBe("npx prisma migrate status");

    expect(cfg.tools?.db?.url).toBe("postgresql://u:p@localhost:5432/db");
    expect(cfg.tools?.db?.readOnly).toBe(true);

    expect(cfg.resources?.readme).toBe("README.md");
    expect(cfg.resources?.schema).toBe("prisma/schema.prisma");
    expect(cfg.resources?.handoff).toBe("CUADRE-HANDOFF.md");
  });

  it("uses the pnpm package manager when a pnpm lockfile is present", () => {
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
      "utf-8",
    );
    writeFileSync(resolve(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
    const cfg = buildAutoConfig(dir);
    expect(cfg.tools?.shell?.commands?.build).toBe("pnpm run build");
    // No package.json name → falls back to the directory basename.
    expect(cfg.name).toBe(basename(dir));
  });

  it("does not enable db tools when there's no postgres DATABASE_URL", () => {
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "x" }), "utf-8");
    writeFileSync(resolve(dir, ".env"), "DATABASE_URL=mysql://u:p@localhost/db\n", "utf-8");
    const cfg = buildAutoConfig(dir);
    expect(cfg.tools?.db).toBeUndefined();
  });
});
