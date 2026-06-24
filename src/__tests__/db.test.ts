import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BetterMcpConfig } from "../config.js";

// We need to mock spawnSync BEFORE importing the db module
const mockSpawnSync = vi.fn();

vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// Now import after the mock is set up
// eslint-disable-next-line import/first
import { query, schema, getToolDefinitions } from "../tools/db.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function makeDbConfig(overrides: Record<string, unknown> = {}): BetterMcpConfig {
  return {
    project: "test",
    root: "/tmp",
    tools: {
      db: {
        url: "postgresql://user:pass@localhost:5432/testdb",
        readOnly: true,
        schemas: ["public"],
        maxRows: 500,
        ...overrides,
      },
    },
  };
}

function makeNoDbConfig(): BetterMcpConfig {
  return {
    project: "test",
    root: "/tmp",
    tools: {},
  };
}

function makeReadWriteConfig(): BetterMcpConfig {
  return {
    project: "test",
    root: "/tmp",
    tools: {
      db: {
        url: "postgresql://user:pass@localhost:5432/testdb",
        readOnly: false,
      },
    },
  };
}

/**
 * Simulate a successful psql JSON output.
 * psql with -t flag returns tuples-only, wrapping the SQL in json_agg(row_to_json(...)).
 */
function mockPsqlSuccess(jsonOutput: string): void {
  mockSpawnSync.mockReturnValueOnce({
    stdout: jsonOutput,
    stderr: "",
    status: 0,
    error: undefined,
    signal: null,
  });
}

function mockPsqlError(stderr: string, status: number = 1): void {
  mockSpawnSync.mockReturnValueOnce({
    stdout: "",
    stderr,
    status,
    error: undefined,
    signal: null,
  });
}

function mockPsqlNotFound(): void {
  mockSpawnSync.mockReturnValueOnce({
    stdout: "",
    stderr: "",
    status: null,
    error: { code: "ENOENT", message: "spawn psql ENOENT" },
    signal: null,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("parsePgConnectionString", () => {
  // parsePgConnectionString is not exported, but we test through query's behavior
  // which uses it internally. We test what it does by checking how psql is called.

  beforeEach(() => {
    mockSpawnSync.mockClear();
  });

  it("should pass connection URL to psql without password in args", () => {
    mockPsqlSuccess('[{"id":1}]');
    const cfg = makeDbConfig();
    query("SELECT 1", cfg);
    // The psql args should contain the clean URL (password removed)
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    expect(Array.isArray(psqlArgs)).toBe(true);
    const urlArg = psqlArgs!.find((a: string) => a.startsWith("postgresql://"));
    expect(urlArg).toBeTruthy();
    // Password should NOT appear in any arg (passed via env)
    if (urlArg) {
      expect(urlArg).not.toContain(":pass@");
    }
  });

  it("should pass PGPASSWORD in env when URL has a password", () => {
    mockPsqlSuccess('[{"id":1}]');
    const cfg = makeDbConfig();
    query("SELECT 1", cfg);
    const psqlOptions = mockSpawnSync.mock.calls[0][2];
    expect(psqlOptions).toBeTruthy();
    const env = psqlOptions!.env as Record<string, string | undefined>;
    expect(env!.PGPASSWORD).toBe("pass");
  });

  it("should not set PGPASSWORD when URL has no password", () => {
    mockPsqlSuccess('[{"id":1}]');
    // URL with username but no password
    const cfg = makeDbConfig({ url: "postgresql://user@localhost:5432/testdb" });
    query("SELECT 1", cfg);
    const psqlOptions = mockSpawnSync.mock.calls[0][2];
    const env = psqlOptions!.env as Record<string, string | undefined>;
    expect(env!.PGPASSWORD).toBeUndefined();
  });
});

describe("query", () => {
  beforeEach(() => {
    mockSpawnSync.mockClear();
  });

  it("should return columns and rows from psql JSON output", () => {
    mockPsqlSuccess('[{"id":1,"name":"test"}]');
    const result = query("SELECT id, name FROM users", makeDbConfig());
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([{ id: 1, name: "test" }]);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("should return empty arrays when no rows", () => {
    mockPsqlSuccess("[]");
    const result = query("SELECT * FROM empty_table", makeDbConfig());
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("should truncate rows beyond maxRows", () => {
    // Return 3 rows but maxRows=2
    mockPsqlSuccess('[{"id":1},{"id":2},{"id":3}]');
    const result = query("SELECT id FROM numbers", makeDbConfig(), 2);
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("should throw for empty SQL", () => {
    expect(() => query("", makeDbConfig())).toThrow(
      "SQL query must be a non-empty string",
    );
  });

  it("should throw for non-string SQL", () => {
    expect(() => query(123 as any, makeDbConfig())).toThrow(
      "SQL query must be a non-empty string",
    );
  });

  it("should throw for SQL exceeding 100K characters", () => {
    const longSql = "SELECT 1" + "a".repeat(100_000);
    expect(() => query(longSql, makeDbConfig())).toThrow(
      "SQL query exceeds maximum length",
    );
  });

  it("should throw for non-SELECT/WITH/EXPLAIN in readOnly mode", () => {
    expect(() => query("DROP TABLE users", makeDbConfig())).toThrow(
      "Only SELECT, WITH, and EXPLAIN queries are allowed in read-only mode",
    );
  });

  it("should throw for INSERT in readOnly mode", () => {
    expect(() => query("INSERT INTO users VALUES (1)", makeDbConfig())).toThrow(
      "Only SELECT, WITH, and EXPLAIN queries are allowed in read-only mode",
    );
  });

  it("should allow non-SELECT queries when readOnly is false", () => {
    mockPsqlSuccess('[{"ok":true}]');
    const cfg = makeReadWriteConfig();
    const result = query("INSERT INTO users VALUES (1)", cfg);
    expect(result.rowCount).toBe(1);
  });

  it("should throw when db not configured", () => {
    expect(() => query("SELECT 1", makeNoDbConfig())).toThrow(
      "Database not configured",
    );
  });

  it("should throw when psql not found", () => {
    mockPsqlNotFound();
    expect(() => query("SELECT 1", makeDbConfig())).toThrow(
      "psql not found",
    );
  });

  it("should throw on psql error", () => {
    mockPsqlError('ERROR:  relation "nonexistent" does not exist');
    expect(() => query("SELECT * FROM nonexistent", makeDbConfig())).toThrow(
      "Query failed",
    );
  });

  it("should throw on JSON parse failure", () => {
    mockPsqlSuccess("not-json");
    expect(() => query("SELECT 1", makeDbConfig())).toThrow(
      "could not parse JSON output from psql",
    );
  });

  it("should handle EXPLAIN queries in readOnly mode", () => {
    mockPsqlSuccess('[{"QUERY PLAN":"Seq Scan on users"}]');
    const result = query("EXPLAIN SELECT * FROM users", makeDbConfig());
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("should handle WITH (CTE) queries in readOnly mode", () => {
    mockPsqlSuccess('[{"count":5}]');
    const result = query("WITH cte AS (SELECT 1) SELECT count(*) FROM cte", makeDbConfig());
    expect(result.rows).toHaveLength(1);
  });

  it("should wrap query with LIMIT for non-zero maxRows", () => {
    mockPsqlSuccess('[{"id":1}]');
    query("SELECT id FROM users", makeDbConfig(), 10);
    // The SQL passed to psql should include LIMIT
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    const sqlArg = psqlArgs!.find((a: string) => a.includes("SELECT"));
    expect(sqlArg).toBeTruthy();
    expect(sqlArg).toContain("LIMIT");
  });

  it("should not wrap with LIMIT when maxRows is 0", () => {
    mockPsqlSuccess('[{"id":1}]');
    query("SELECT id FROM users", makeDbConfig(), 0);
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    const sqlArg = psqlArgs!.find((a: string) => a.includes("SELECT"));
    expect(sqlArg).toBeTruthy();
    expect(sqlArg).not.toContain("LIMIT");
  });

  it("should read readOnlyMode from config", () => {
    mockPsqlSuccess('[{"id":1}]');
    const cfg = makeDbConfig({ readOnlyMode: "none" });
    query("SELECT 1", cfg);
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    // With readOnlyMode=none, there should be no SET TRANSACTION READ ONLY
    const setArg = psqlArgs!.find((a: string) => a.includes("SET SESSION"));
    expect(setArg).toBeUndefined();
  });

  it("should reject non-postgres URLs", () => {
    const cfg = makeDbConfig({ url: "mysql://user:pass@localhost:3306/db" });
    expect(() => query("SELECT 1", cfg)).toThrow("Invalid database URL scheme");
  });
});

describe("schema", () => {
  beforeEach(() => {
    mockSpawnSync.mockClear();
  });

  it("should return tables with columns from psql schema query", () => {
    mockPsqlSuccess(
      JSON.stringify([
        {
          table_schema: "public",
          table_name: "users",
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "nextval('users_id_seq')",
          constraint_type: "PRIMARY KEY",
        },
        {
          table_schema: "public",
          table_name: "users",
          column_name: "name",
          data_type: "character varying",
          is_nullable: "YES",
          column_default: null,
          constraint_type: null,
        },
      ]),
    );
    const result = schema(makeDbConfig());
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.schema).toBe("public");
    expect(table.name).toBe("users");
    expect(table.columns).toHaveLength(2);
    expect(table.columns[0].name).toBe("id");
    expect(table.columns[0].isPrimaryKey).toBe(true);
    expect(table.columns[1].name).toBe("name");
    expect(table.columns[1].isPrimaryKey).toBe(false);
    expect(table.columns[1].nullable).toBe(true);
  });

  it("should filter by custom schemas", () => {
    mockPsqlSuccess("[]");
    schema(makeDbConfig(), ["custom_schema"]);
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    const sqlArg = psqlArgs!.find((a: string) => a.includes("table_schema IN"));
    expect(sqlArg).toBeTruthy();
    expect(sqlArg).toContain("'custom_schema'");
  });

  it("should fall back to config schemas when none provided", () => {
    mockPsqlSuccess("[]");
    const cfg = makeDbConfig({ schemas: ["public", "analytics"] });
    schema(cfg);
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    const sqlArg = psqlArgs!.find((a: string) => a.includes("table_schema IN"));
    expect(sqlArg).toBeTruthy();
    expect(sqlArg).toContain("'public'");
    expect(sqlArg).toContain("'analytics'");
  });

  it("should default to public when no schemas in config or args", () => {
    mockPsqlSuccess("[]");
    schema(makeDbConfig());
    const psqlArgs = mockSpawnSync.mock.calls[0][1];
    const sqlArg = psqlArgs!.find((a: string) => a.includes("table_schema IN"));
    expect(sqlArg).toBeTruthy();
    expect(sqlArg).toContain("'public'");
  });

  it("should throw for invalid schema name", () => {
    expect(() => schema(makeDbConfig(), ["invalid schema!"])).toThrow(
      'Invalid schema name: "invalid schema!"',
    );
  });

  it("should throw for empty schema name", () => {
    expect(() => schema(makeDbConfig(), [""])).toThrow(
      "Schema names must be non-empty strings",
    );
  });

  it("should throw when db not configured", () => {
    expect(() => schema(makeNoDbConfig())).toThrow(
      "Database not configured",
    );
  });

  it("should handle empty result from psql", () => {
    mockPsqlSuccess("[]");
    const result = schema(makeDbConfig());
    expect(result.tables).toHaveLength(0);
  });

  it("should include rowCountEstimate as number", () => {
    mockPsqlSuccess(
      JSON.stringify([
        {
          table_schema: "public",
          table_name: "products",
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: null,
          constraint_type: "PRIMARY KEY",
        },
      ]),
    );
    const result = schema(makeDbConfig());
    expect(result.tables[0].rowCountEstimate).toBe(0);
  });
});

describe("getToolDefinitions", () => {
  it("should return empty array when hasDb is false", () => {
    const tools = getToolDefinitions(makeDbConfig(), false);
    expect(tools).toHaveLength(0);
  });

  it("should return db_query and db_schema when hasDb is true", () => {
    const tools = getToolDefinitions(makeDbConfig(), true);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("db_query");
    expect(toolNames).toContain("db_schema");
  });

  it("should mark destructive SQL for auth in requiresAuth", () => {
    const tools = getToolDefinitions(makeDbConfig(), true);
    const queryTool = tools.find((t) => t.name === "db_query")!;
    expect(queryTool.requiresAuth).toBeDefined();
    // SELECT should NOT require auth
    expect(queryTool.requiresAuth!({ sql: "SELECT 1" })).toBe(false);
    // DROP should require auth
    expect(queryTool.requiresAuth!({ sql: "DROP TABLE users" })).toBe(true);
  });
});

describe("error handling", () => {
  beforeEach(() => {
    mockSpawnSync.mockClear();
  });

  it("should handle psql timeout via spawnSync timeout", () => {
    mockSpawnSync.mockReturnValueOnce({
      stdout: "",
      stderr: "",
      status: null,
      error: undefined,
      signal: "SIGTERM",
    });
    // The query function's runPsqlRaw will throw because status !== 0
    // (null status with signal means timeout)
    expect(() => query("SELECT pg_sleep(100)", makeDbConfig())).toThrow();
  });

  it("should reject URL longer than 2000 characters", () => {
    const longUrl = "postgresql://user:pass@localhost:5432/" + "a".repeat(2000);
    const cfg = makeDbConfig({ url: longUrl });
    expect(() => query("SELECT 1", cfg)).toThrow("Database URL exceeds maximum length");
  });
});
