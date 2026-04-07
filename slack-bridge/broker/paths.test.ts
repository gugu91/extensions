import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCKET_PATH,
  getDefaultDbPath,
  getDefaultMeshSecretPath,
  getDefaultSocketPath,
  getPinetConfigDir,
} from "./paths.js";

describe("getPinetConfigDir", () => {
  it("returns ~/.pi", () => {
    expect(getPinetConfigDir()).toBe(path.join(os.homedir(), ".pi"));
  });
});

describe("getDefaultSocketPath", () => {
  it("returns ~/.pi/pinet.sock", () => {
    expect(getDefaultSocketPath()).toBe(path.join(os.homedir(), ".pi", "pinet.sock"));
  });
});

describe("DEFAULT_SOCKET_PATH", () => {
  it("equals getDefaultSocketPath()", () => {
    expect(DEFAULT_SOCKET_PATH).toBe(getDefaultSocketPath());
  });
});

describe("getDefaultDbPath", () => {
  it("returns ~/.pi/pinet-broker.db", () => {
    expect(getDefaultDbPath()).toBe(path.join(os.homedir(), ".pi", "pinet-broker.db"));
  });
});

describe("getDefaultMeshSecretPath", () => {
  it("returns ~/.pi/pinet.secret", () => {
    expect(getDefaultMeshSecretPath()).toBe(path.join(os.homedir(), ".pi", "pinet.secret"));
  });
});

describe("all paths share the same config directory", () => {
  it("socket, db, and secret paths are siblings under ~/.pi", () => {
    const configDir = getPinetConfigDir();
    expect(path.dirname(getDefaultSocketPath())).toBe(configDir);
    expect(path.dirname(getDefaultDbPath())).toBe(configDir);
    expect(path.dirname(getDefaultMeshSecretPath())).toBe(configDir);
  });
});
