import { describe, expect, it } from "vitest";

import {
  buildInjectedValues,
  deriveEndpoint,
  encodeConnectionUrl,
  isReadOnlyQuery,
  mergePathValue,
  needsSsl,
  type InjectedValuesState,
  type SourceValues,
} from "./helpers.js";

const source: SourceValues = {
  host: "ep-cool-river.us-east-1.aws.neon.tech",
  port: "5432",
  user: "user@example.com",
  password: "pa:ss/word?",
  database: "db/name",
};

const state: InjectedValuesState = {
  port: 6543,
  endpoint: "ep-cool-river",
  logPath: "/tmp/neon.log",
  source,
  requiresSsl: true,
};

describe("needsSsl", () => {
  it("disables ssl for local hosts", () => {
    expect(needsSsl("localhost")).toBe(false);
    expect(needsSsl("127.0.0.1")).toBe(false);
    expect(needsSsl("::1")).toBe(false);
  });

  it("requires ssl for remote hosts", () => {
    expect(needsSsl("example.neon.tech")).toBe(true);
  });
});

describe("deriveEndpoint", () => {
  it("derives the neon endpoint from remote hosts", () => {
    expect(deriveEndpoint("ep-cool-river.us-east-1.aws.neon.tech")).toBe("ep-cool-river");
  });

  it("returns empty string for local hosts", () => {
    expect(deriveEndpoint("localhost")).toBe("");
  });
});

describe("mergePathValue", () => {
  it("prepends values to an existing PATH-like value", () => {
    expect(mergePathValue("/shim", "/usr/bin:/bin")).toBe("/shim:/usr/bin:/bin");
  });

  it("returns the new value when there is no existing path", () => {
    expect(mergePathValue("/shim", undefined)).toBe("/shim");
  });
});

describe("encodeConnectionUrl", () => {
  it("encodes credentials, database names, sslmode, and endpoint", () => {
    expect(encodeConnectionUrl("postgresql", source, 6543, "require", "ep-cool-river")).toBe(
      "postgresql://user%40example.com:pa%3Ass%2Fword%3F@127.0.0.1:6543/db%2Fname?sslmode=require&options=endpoint%3Dep-cool-river",
    );
  });

  it("omits query parameters when ssl and endpoint are absent", () => {
    expect(encodeConnectionUrl("postgresql", source, 6543, null, "")).toBe(
      "postgresql://user%40example.com:pa%3Ass%2Fword%3F@127.0.0.1:6543/db%2Fname",
    );
  });
});

describe("buildInjectedValues", () => {
  it("builds the injected connection env values", () => {
    const result = buildInjectedValues(
      {
        path: "/tmp/config.json",
        injectPythonShim: true,
        injectEnv: {
          DATABASE_URL: "postgres_url",
          ASYNCPG_DSN: "asyncpg_dsn",
          PGOPTIONS: "pgoptions",
          PGSSLMODE: "sslmode",
          SOURCE_COPY: "source:CUSTOM_ENV",
        },
      },
      state,
      {
        pythonShimDir: "/opt/pi/python",
        env: { PYTHONPATH: "/workspace/site-packages", CUSTOM_ENV: "from-env" },
      },
    );

    expect(result.DATABASE_URL).toBe(
      "postgresql://user%40example.com:pa%3Ass%2Fword%3F@127.0.0.1:6543/db%2Fname?sslmode=require&options=endpoint%3Dep-cool-river",
    );
    expect(result.ASYNCPG_DSN).toBe(
      "postgresql://user%40example.com:pa%3Ass%2Fword%3F@127.0.0.1:6543/db%2Fname?ssl=require&options=endpoint%3Dep-cool-river",
    );
    expect(result.PGOPTIONS).toBe("endpoint=ep-cool-river");
    expect(result.PGSSLMODE).toBe("require");
    expect(result.SOURCE_COPY).toBe("from-env");
    expect(result.PYTHONPATH).toBe("/opt/pi/python:/workspace/site-packages");
  });

  it("uses disable ssl mode for local tunnels", () => {
    const result = buildInjectedValues(
      {
        path: "/tmp/config.json",
        injectPythonShim: false,
        injectEnv: { PGSSLMODE: "sslmode", PGOPTIONS: "pgoptions" },
      },
      { ...state, endpoint: "", requiresSsl: false },
    );

    expect(result.PGSSLMODE).toBe("disable");
    expect(result.PGOPTIONS).toBe("");
  });
});

describe("isReadOnlyQuery", () => {
  it("allows basic read-only statements", () => {
    expect(isReadOnlyQuery("SELECT * FROM users")).toBe(true);
    expect(isReadOnlyQuery("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
    expect(isReadOnlyQuery("SHOW search_path")).toBe(true);
    expect(isReadOnlyQuery("VALUES (1), (2)")).toBe(true);
    expect(isReadOnlyQuery("TABLE pg_tables")).toBe(true);
  });

  it("allows explain for read-only statements", () => {
    expect(isReadOnlyQuery("EXPLAIN SELECT 1")).toBe(true);
    expect(isReadOnlyQuery("EXPLAIN ANALYZE SELECT 1")).toBe(true);
    expect(isReadOnlyQuery("EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1")).toBe(true);
  });

  it("allows read-only psql inspection meta commands", () => {
    expect(isReadOnlyQuery("\\d users")).toBe(true);
    expect(isReadOnlyQuery("/* comment */ \\dt+")).toBe(true);
    expect(isReadOnlyQuery("\\conninfo")).toBe(true);
  });

  it("rejects empty and comment-only queries", () => {
    expect(isReadOnlyQuery("")).toBe(false);
    expect(isReadOnlyQuery("   ")).toBe(false);
    expect(isReadOnlyQuery("-- just a comment")).toBe(false);
  });

  it("rejects write statements", () => {
    expect(isReadOnlyQuery("INSERT INTO users VALUES (1)")).toBe(false);
    expect(isReadOnlyQuery("UPDATE users SET admin = true")).toBe(false);
    expect(isReadOnlyQuery("DELETE FROM users")).toBe(false);
    expect(isReadOnlyQuery("CREATE TABLE users(id int)")).toBe(false);
    expect(isReadOnlyQuery("ALTER TABLE users ADD COLUMN name text")).toBe(false);
    expect(isReadOnlyQuery("DROP TABLE users")).toBe(false);
    expect(isReadOnlyQuery("TRUNCATE users")).toBe(false);
  });

  it("rejects known read-only guard bypasses", () => {
    expect(isReadOnlyQuery("SELECT 1; DELETE FROM users")).toBe(false);
    expect(isReadOnlyQuery("WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone")).toBe(
      false,
    );
    expect(isReadOnlyQuery("EXPLAIN ANALYZE DELETE FROM users")).toBe(false);
    expect(isReadOnlyQuery("SELECT * INTO backup_users FROM users")).toBe(false);
    expect(isReadOnlyQuery("SELECT * FROM users FOR UPDATE")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1 \\gexec")).toBe(false);
    expect(isReadOnlyQuery("\\d users\nDELETE FROM users")).toBe(false);
    expect(isReadOnlyQuery("\\gexec")).toBe(false);
    expect(isReadOnlyQuery("\\! echo hacked")).toBe(false);
    expect(isReadOnlyQuery("\\copy users to '/tmp/users.csv'")).toBe(false);
  });

  it("ignores comments and quoted content while validating", () => {
    expect(isReadOnlyQuery("/* outer /* nested */ still comment */ SELECT ';' AS value")).toBe(
      true,
    );
    expect(isReadOnlyQuery('SELECT "delete" FROM users')).toBe(true);
    expect(isReadOnlyQuery("SELECT $$; DELETE FROM users$$")).toBe(true);
  });
});
