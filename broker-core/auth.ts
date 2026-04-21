import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultMeshSecretPath } from "./paths.js";

export interface MeshSecretOptions {
  meshSecret?: string | null;
  meshSecretPath?: string | null;
}

function normalizeMeshSecret(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function getErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err == null || !("code" in err)) {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function readMeshSecret(secretPath = getDefaultMeshSecretPath()): string {
  const secret = normalizeMeshSecret(fs.readFileSync(secretPath, "utf-8"));
  if (!secret) {
    throw new Error(`Pinet mesh secret file is empty: ${secretPath}`);
  }
  return secret;
}

export function loadOrCreateMeshSecret(secretPath = getDefaultMeshSecretPath()): string {
  try {
    return readMeshSecret(secretPath);
  } catch (err) {
    if (getErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }

  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  const meshSecret = crypto.randomBytes(32).toString("hex");

  try {
    fs.writeFileSync(secretPath, `${meshSecret}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return meshSecret;
  } catch (err) {
    if (getErrorCode(err) !== "EEXIST") {
      throw err;
    }
    return readMeshSecret(secretPath);
  }
}

export function resolveMeshSecret(options: MeshSecretOptions = {}): string | null {
  const explicitSecret = normalizeMeshSecret(options.meshSecret);
  if (explicitSecret) {
    return explicitSecret;
  }

  const meshSecretPath = options.meshSecretPath?.trim();
  if (!meshSecretPath) {
    return null;
  }

  return readMeshSecret(meshSecretPath);
}
