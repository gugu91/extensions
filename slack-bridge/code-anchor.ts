import { createHash, randomUUID } from "node:crypto";

export type ContextJsonValue =
  | string
  | number
  | boolean
  | null
  | ContextJsonObject
  | ContextJsonValue[];
export interface ContextJsonObject {
  [key: string]: ContextJsonValue | undefined;
}

export type CodeAnchorSide = "old" | "new";

export interface CodeRevisionIdentity extends ContextJsonObject {
  repository: string;
  worktree: string;
  path: string;
  baseOid: string | null;
  headOid: string;
  blobOid: string;
  side: CodeAnchorSide;
}

export interface CodeAnchor extends CodeRevisionIdentity {
  startLine: number;
  endLine: number;
  selectedTextSha256: string | null;
  contextSha256: string | null;
}

export interface ContextualThreadState extends ContextJsonObject {
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface ContextualThreadMetadata extends ContextJsonObject {
  pinetKind: "contextual_thread";
  schemaVersion: 1;
  codeAnchor: CodeAnchor;
  state: ContextualThreadState;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildNvimThreadId(repoSocketHash: string): string {
  return `nvim:${repoSocketHash}:${randomUUID()}`;
}

export function buildContextualThreadMetadata(input: {
  repository: string;
  worktree: string;
  path: string;
  baseOid?: string | null;
  headOid: string;
  blobOid: string;
  side: CodeAnchorSide;
  startLine: number;
  endLine?: number;
  selectedText?: string | null;
  contextText?: string | null;
}): ContextualThreadMetadata {
  const startLine = Math.max(1, Math.floor(input.startLine));
  const endLine = Math.max(startLine, Math.floor(input.endLine ?? startLine));
  return {
    pinetKind: "contextual_thread",
    schemaVersion: 1,
    codeAnchor: {
      repository: input.repository,
      worktree: input.worktree,
      path: input.path,
      baseOid: input.baseOid ?? null,
      headOid: input.headOid,
      blobOid: input.blobOid,
      side: input.side,
      startLine,
      endLine,
      selectedTextSha256: input.selectedText ? sha256Text(input.selectedText) : null,
      contextSha256: input.contextText ? sha256Text(input.contextText) : null,
    },
    state: { resolved: false },
  };
}

function readRecord(value: ContextJsonValue | undefined): ContextJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function readString(record: ContextJsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPositiveInteger(record: ContextJsonObject, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
}

export function parseContextualThreadMetadata(
  value: ContextJsonValue | undefined,
): ContextualThreadMetadata | null {
  const metadata = readRecord(value);
  if (!metadata || metadata.pinetKind !== "contextual_thread" || metadata.schemaVersion !== 1) {
    return null;
  }

  const anchorRecord = readRecord(metadata.codeAnchor);
  const stateRecord = readRecord(metadata.state);
  if (!anchorRecord || !stateRecord || typeof stateRecord.resolved !== "boolean") return null;

  const repository = readString(anchorRecord, "repository");
  const worktree = readString(anchorRecord, "worktree");
  const path = readString(anchorRecord, "path");
  const headOid = readString(anchorRecord, "headOid");
  const blobOid = readString(anchorRecord, "blobOid");
  const side =
    anchorRecord.side === "old" || anchorRecord.side === "new" ? anchorRecord.side : null;
  const startLine = readPositiveInteger(anchorRecord, "startLine");
  const endLine = readPositiveInteger(anchorRecord, "endLine");
  if (
    !repository ||
    !worktree ||
    !path ||
    !headOid ||
    !blobOid ||
    !side ||
    startLine == null ||
    endLine == null
  ) {
    return null;
  }

  const resolvedAt = readString(stateRecord, "resolvedAt");
  const resolvedBy = readString(stateRecord, "resolvedBy");
  return {
    pinetKind: "contextual_thread",
    schemaVersion: 1,
    codeAnchor: {
      repository,
      worktree,
      path,
      baseOid: readString(anchorRecord, "baseOid"),
      headOid,
      blobOid,
      side,
      startLine,
      endLine,
      selectedTextSha256: readString(anchorRecord, "selectedTextSha256"),
      contextSha256: readString(anchorRecord, "contextSha256"),
    },
    state: {
      resolved: stateRecord.resolved,
      ...(resolvedAt ? { resolvedAt } : {}),
      ...(resolvedBy ? { resolvedBy } : {}),
    },
  };
}

export function updateContextualThreadResolvedState(
  metadata: ContextualThreadMetadata,
  resolved: boolean,
  actor: string,
  now = new Date().toISOString(),
): ContextualThreadMetadata {
  return {
    ...metadata,
    state: resolved ? { resolved: true, resolvedAt: now, resolvedBy: actor } : { resolved: false },
  };
}

export function hasSameCodeRevision(anchor: CodeAnchor, candidate: CodeRevisionIdentity): boolean {
  return (
    anchor.repository === candidate.repository &&
    anchor.worktree === candidate.worktree &&
    anchor.path === candidate.path &&
    anchor.baseOid === candidate.baseOid &&
    anchor.headOid === candidate.headOid &&
    anchor.blobOid === candidate.blobOid &&
    anchor.side === candidate.side
  );
}

export function formatAnchorForMessage(metadata: ContextualThreadMetadata): string {
  const anchor = metadata.codeAnchor;
  const range =
    anchor.startLine === anchor.endLine
      ? `${anchor.path}:${anchor.startLine}`
      : `${anchor.path}:${anchor.startLine}-${anchor.endLine}`;
  const base = anchor.baseOid ? ` base=${anchor.baseOid}` : "";
  return `[code-anchor ${range} side=${anchor.side} head=${anchor.headOid} blob=${anchor.blobOid}${base}]`;
}
