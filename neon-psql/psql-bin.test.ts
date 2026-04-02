import { describe, expect, it } from "vitest";

import { DEFAULT_PSQL_FALLBACK_PATHS, findExecutableOnPath, resolvePsqlBin } from "./psql-bin.js";

describe("findExecutableOnPath", () => {
  it("returns the first executable found on PATH", () => {
    const result = findExecutableOnPath(
      "psql",
      { PATH: "/bin:/custom/bin:/usr/bin" },
      (candidatePath) => candidatePath === "/custom/bin/psql",
    );

    expect(result).toBe("/custom/bin/psql");
  });

  it("returns null when PATH is empty", () => {
    expect(findExecutableOnPath("psql", { PATH: "" }, () => true)).toBeNull();
  });
});

describe("resolvePsqlBin", () => {
  it("uses the configured path when it is executable", () => {
    const result = resolvePsqlBin({
      configuredPath: " /custom/psql ",
      isExecutable: (candidatePath) => candidatePath === "/custom/psql",
    });

    expect(result).toBe("/custom/psql");
  });

  it("throws when the configured path is not executable", () => {
    expect(() =>
      resolvePsqlBin({
        configuredPath: "/missing/psql",
        isExecutable: () => false,
      }),
    ).toThrow("Configured psql binary is not executable: /missing/psql");
  });

  it("prefers PATH before fallback locations", () => {
    const result = resolvePsqlBin({
      env: { PATH: "/bin:/usr/local/bin" },
      isExecutable: (candidatePath) => candidatePath === "/usr/local/bin/psql",
      fallbackPaths: ["/opt/homebrew/opt/libpq/bin/psql"],
    });

    expect(result).toBe("/usr/local/bin/psql");
  });

  it("falls back to known install locations when PATH lookup fails", () => {
    const result = resolvePsqlBin({
      env: { PATH: "/bin:/usr/local/bin" },
      isExecutable: (candidatePath) => candidatePath === DEFAULT_PSQL_FALLBACK_PATHS[1],
    });

    expect(result).toBe(DEFAULT_PSQL_FALLBACK_PATHS[1]);
  });

  it("throws a helpful error when no binary can be found", () => {
    expect(() =>
      resolvePsqlBin({
        env: { PATH: "/bin:/usr/local/bin" },
        isExecutable: () => false,
        fallbackPaths: ["/custom/fallback/psql"],
      }),
    ).toThrow(
      "Unable to find a psql binary. Checked PATH and fallback paths: /custom/fallback/psql. Configure neon-psql.psqlBin if psql is installed elsewhere.",
    );
  });
});
