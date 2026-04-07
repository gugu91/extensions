import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadOrCreateMeshSecret, readMeshSecret, resolveMeshSecret } from "./auth.js";

describe("broker mesh auth helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-auth-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a secret on first use and reuses it on later reads", () => {
    const secretPath = path.join(dir, "pinet.secret");

    const first = loadOrCreateMeshSecret(secretPath);
    const second = loadOrCreateMeshSecret(secretPath);

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
    expect(readMeshSecret(secretPath)).toBe(first);
  });

  it("resolveMeshSecret prefers an explicit secret over the file", () => {
    const secretPath = path.join(dir, "pinet.secret");
    fs.writeFileSync(secretPath, "from-file\n", "utf-8");

    expect(resolveMeshSecret({ meshSecret: "  from-option  ", meshSecretPath: secretPath })).toBe(
      "from-option",
    );
  });

  it("resolveMeshSecret reads from a secret file when no explicit secret is provided", () => {
    const secretPath = path.join(dir, "pinet.secret");
    fs.writeFileSync(secretPath, "from-file\n", "utf-8");

    expect(resolveMeshSecret({ meshSecretPath: secretPath })).toBe("from-file");
  });

  it("readMeshSecret rejects empty secret files", () => {
    const secretPath = path.join(dir, "pinet.secret");
    fs.writeFileSync(secretPath, "\n", "utf-8");

    expect(() => readMeshSecret(secretPath)).toThrow("empty");
  });
});
