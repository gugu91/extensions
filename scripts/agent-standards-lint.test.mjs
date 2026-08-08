import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiffArgsForEntry,
  countTypeEscapeHatches,
  findForbiddenIsRecordDeclarations,
  findSingleUseAddedHelpers,
  parseNameStatusEntries,
} from "./agent-standards-lint.mjs";

test("parseNameStatusEntries preserves base paths for renames", () => {
  assert.deepEqual(
    parseNameStatusEntries(
      [
        "M\tslack-bridge/pinet-tools.ts",
        "A\tslack-bridge/new-file.ts",
        "R100\tslack-bridge/old-name.ts\tslack-bridge/new-name.ts",
        "C100\tslack-bridge/template.ts\tslack-bridge/copied.ts",
        "M\ttypes/pi-coding-agent.d.ts",
      ].join("\n"),
    ),
    [
      { path: "slack-bridge/pinet-tools.ts", basePath: "slack-bridge/pinet-tools.ts" },
      { path: "slack-bridge/new-file.ts", basePath: null },
      { path: "slack-bridge/new-name.ts", basePath: "slack-bridge/old-name.ts" },
      { path: "slack-bridge/copied.ts", basePath: null },
    ],
  );
});

test("buildDiffArgsForEntry includes old and new paths for renames", () => {
  assert.deepEqual(
    buildDiffArgsForEntry("base", {
      path: "slack-bridge/new-name.ts",
      basePath: "slack-bridge/old-name.ts",
    }),
    [
      "diff",
      "--unified=0",
      "-M",
      "base",
      "--",
      "slack-bridge/old-name.ts",
      "slack-bridge/new-name.ts",
    ],
  );
});

test("countTypeEscapeHatches counts TypeScript type escapes but not runtime words", () => {
  const counts = countTypeEscapeHatches(
    `
      const label = "unknown";
      expect.any(String);
      type Raw = Record<string, unknown>;
      const parse = (value: unknown): value is { id: string } => true;
      type Unsafe = (...args: any[]) => any;
    `,
    "sample.ts",
  );

  assert.deepEqual(counts, { unknown: 2, any: 2 });
});

test("findForbiddenIsRecordDeclarations matches function and variable declarations only", () => {
  const declarations = findForbiddenIsRecordDeclarations(
    `
      function isRecord(value: object): boolean {
        return Boolean(value);
      }
      const isRecord = (value: object): boolean => Boolean(value);
      const result = helpers.isRecord({});
      class Parser { isRecord(): boolean { return true; } }
    `,
    "sample.ts",
  );

  assert.deepEqual(declarations, [
    { line: 2, column: 16 },
    { line: 5, column: 13 },
  ]);
});

test("findSingleUseAddedHelpers ignores existing helpers whose declaration line changed", () => {
  const source = `
    function existing(value: string | null): string {
      return value?.trim() ?? "";
    }

    const a = existing("a");
  `;
  const baseSource = `
    function existing(value: string): string {
      return value.trim();
    }

    const a = existing("a");
  `;

  const helpers = findSingleUseAddedHelpers(
    source,
    "sample.ts",
    [{ start: 2, end: 2 }],
    baseSource,
  );

  assert.deepEqual(helpers, []);
});

test("findSingleUseAddedHelpers flags only newly added one-use top-level helpers", () => {
  const source = `
    function oneUse(value: string): string {
      return value.trim();
    }

    function twoUse(value: string): string {
      return value.trim();
    }

    export function exportedOneUse(value: string): string {
      return value.trim();
    }

    const arrowOneUse = (value: string): string => value.trim();

    const a = oneUse("a");
    const b = twoUse("b") + twoUse("c");
    const c = exportedOneUse("d");
    const d = arrowOneUse("e");
  `;

  const helpers = findSingleUseAddedHelpers(source, "sample.ts", [{ start: 2, end: 14 }]).map(
    (helper) => helper.name,
  );

  assert.deepEqual(helpers, ["oneUse", "arrowOneUse"]);
});

test("findSingleUseAddedHelpers flags nested one-use helpers", () => {
  const source = `
    export function run(): string {
      function normalize(value: string): string {
        return value.trim();
      }

      return normalize("value");
    }
  `;

  const helpers = findSingleUseAddedHelpers(source, "sample.ts", [{ start: 3, end: 5 }]);

  assert.deepEqual(
    helpers.map((helper) => helper.name),
    ["normalize"],
  );
});

test("findSingleUseAddedHelpers resolves same-named nested helpers by symbol", () => {
  const source = `
    export function first(): string {
      function normalize(value: string): string {
        return value.trim();
      }
      return normalize("first");
    }

    export function second(): string {
      function normalize(value: string): string {
        return value.trim();
      }
      return normalize("second");
    }
  `;

  const helpers = findSingleUseAddedHelpers(source, "sample.ts", [{ start: 3, end: 12 }]);

  assert.deepEqual(
    helpers.map((helper) => helper.name),
    ["normalize", "normalize"],
  );
});

test("findSingleUseAddedHelpers ignores exported arrow functions", () => {
  const source = `
    export const normalize = (value: string): string => value.trim();
    const result = normalize("value");
  `;

  const helpers = findSingleUseAddedHelpers(source, "sample.ts", [{ start: 2, end: 2 }]);

  assert.deepEqual(helpers, []);
});

test("findSingleUseAddedHelpers resolves indirect exports by symbol", () => {
  const source = `
    function normalize(value: string): string {
      return value.trim();
    }
    export { normalize };
    const result = normalize("value");

    export function run(): string {
      function normalize(value: string): string {
        return value.trim();
      }
      return normalize("nested");
    }
  `;

  const helpers = findSingleUseAddedHelpers(source, "sample.ts", [{ start: 2, end: 11 }]);

  assert.deepEqual(
    helpers.map((helper) => helper.name),
    ["normalize"],
  );
});

test("findSingleUseAddedHelpers distinguishes new nested helpers from base helpers", () => {
  const baseSource = `
    function normalize(value: string): string {
      return value.trim();
    }
    const result = normalize("base");
  `;
  const source = `${baseSource}
    export function run(): string {
      function normalize(value: string): string {
        return value.trim();
      }
      return normalize("nested");
    }
  `;

  const helpers = findSingleUseAddedHelpers(
    source,
    "sample.ts",
    [{ start: 7, end: 9 }],
    baseSource,
  );

  assert.deepEqual(
    helpers.map((helper) => helper.name),
    ["normalize"],
  );
});

test("findSingleUseAddedHelpers honors the explicit semantic-seam ignore", () => {
  const source = `
    // agent-standards-ignore prefer-inline-single-use-helper: documents a protocol seam
    function seam(value: string): string {
      return value.trim();
    }

    const a = seam("a");
  `;

  const helpers = findSingleUseAddedHelpers(source, "sample.ts", [{ start: 3, end: 5 }]);

  assert.deepEqual(helpers, []);
});
