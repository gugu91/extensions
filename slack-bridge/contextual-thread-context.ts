import {
  parseContextualThreadMetadata,
  type ContextJsonValue,
  type ContextualThreadMetadata,
} from "./code-anchor.js";
import type { ThreadInfo } from "./broker/types.js";

export interface ContextualThreadContextMessage {
  sender: string;
  body: string;
}

export interface ContextualThreadContextRepository {
  repository: string;
  worktree: string;
  headOid: string;
  baseOid: string | null;
}

interface OpenContextualThread {
  thread: ThreadInfo;
  metadata: ContextualThreadMetadata;
}

export function selectOpenContextualThreads(
  threads: readonly ThreadInfo[],
  repository: ContextualThreadContextRepository,
  limit = 5,
): OpenContextualThread[] {
  return threads
    .map((thread) => ({
      thread,
      metadata: parseContextualThreadMetadata(thread.metadata as ContextJsonValue),
    }))
    .filter(
      (item): item is OpenContextualThread =>
        item.metadata !== null &&
        !item.metadata.state.resolved &&
        item.metadata.codeAnchor.repository === repository.repository &&
        item.metadata.codeAnchor.worktree === repository.worktree &&
        item.metadata.codeAnchor.headOid === repository.headOid &&
        item.metadata.codeAnchor.baseOid === repository.baseOid,
    )
    .sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt))
    .slice(0, Math.max(0, limit));
}

export function formatContextualThreadContext(
  items: readonly OpenContextualThread[],
  messagesByThread: ReadonlyMap<string, readonly ContextualThreadContextMessage[]>,
  maxCharacters = 5000,
): string {
  if (items.length === 0) return "";
  const lines = [
    "Open persisted Pinet code threads relevant to this worktree and revision:",
    "Reply with `pinet action=reply args.thread_id=<id> args.message=<text>`; resolved threads are omitted.",
  ];

  for (const { thread, metadata } of items) {
    const anchor = metadata.codeAnchor;
    const range =
      anchor.startLine === anchor.endLine
        ? `${anchor.path}:${anchor.startLine}`
        : `${anchor.path}:${anchor.startLine}-${anchor.endLine}`;
    lines.push(`- ${thread.threadId} — ${range} (${anchor.side})`);
    for (const message of (messagesByThread.get(thread.threadId) ?? []).slice(-3)) {
      const compactBody = message.body.replace(/\s+/g, " ").trim().slice(0, 600);
      if (compactBody) lines.push(`  ${message.sender}: ${compactBody}`);
    }
    if (lines.join("\n").length >= maxCharacters) break;
  }

  return lines.join("\n").slice(0, maxCharacters);
}
