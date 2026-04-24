import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SlackResult } from "./slack-api.js";

const FILETYPE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  htm: "html",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "shell",
};

const DEFAULT_SNIPPET_TYPE = "text";
const MAX_SNIPPET_BYTES = 1_000_000;

export interface SlackUploadParams {
  content?: string;
  path?: string;
  filename?: string;
  filetype?: string;
  title?: string;
}

export interface PreparedSlackUpload {
  bytes: Buffer;
  byteLength: number;
  filename: string;
  title: string;
  filetype?: string;
  snippetType?: string;
  source: "content" | "path";
  resolvedPath?: string;
}

export interface SlackUploadDeps {
  slack: (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>;
  token: string;
  fetchImpl?: (
    url: string,
    init: RequestInit,
  ) => Promise<Pick<Response, "ok" | "status" | "statusText" | "text">>;
}

export interface PerformSlackUploadOptions extends SlackUploadDeps {
  upload: PreparedSlackUpload;
  channelId: string;
  threadTs?: string;
}

export interface CompletedSlackUpload {
  fileId: string;
  response: SlackResult;
}

interface PrepareSlackUploadFs {
  readFileImpl?: typeof readFile;
  realpathImpl?: typeof realpath;
  statImpl?: typeof stat;
}

export function inferSlackUploadFiletype(
  filename: string | undefined,
  explicitFiletype?: string,
): string | undefined {
  const raw = (explicitFiletype ?? path.extname(filename ?? "").slice(1)).trim().toLowerCase();
  if (!raw) return undefined;
  return FILETYPE_ALIASES[raw] ?? raw;
}

export function chooseSlackSnippetType(upload: {
  source: "content" | "path";
  byteLength: number;
  filename: string;
  filetype?: string;
}): string | undefined {
  if (upload.source !== "content") return undefined;
  if (upload.byteLength > MAX_SNIPPET_BYTES) return undefined;
  return inferSlackUploadFiletype(upload.filename, upload.filetype) ?? DEFAULT_SNIPPET_TYPE;
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function resolveSlackUploadPath(
  inputPath: string,
  cwd: string,
  tmpdir: string,
  fsDeps: PrepareSlackUploadFs = {},
): Promise<string> {
  const { realpathImpl = realpath, statImpl = stat } = fsDeps;
  const requestedPath = inputPath.trim();
  if (!requestedPath) {
    throw new Error("path is required when uploading from a local file.");
  }

  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd, requestedPath);

  const [resolvedCandidate, resolvedCwd, resolvedTmpdir] = await Promise.all([
    realpathImpl(candidate),
    realpathImpl(cwd),
    realpathImpl(tmpdir),
  ]);

  if (
    !isWithinRoot(resolvedCandidate, resolvedCwd) &&
    !isWithinRoot(resolvedCandidate, resolvedTmpdir)
  ) {
    throw new Error(
      "For safety, the slack dispatcher upload action only allows local file paths inside the current working directory or the system temp directory. For other files, read the content explicitly and upload it via the content parameter.",
    );
  }

  const fileStats = await statImpl(resolvedCandidate);
  if (!fileStats.isFile()) {
    throw new Error(`Local upload path is not a file: ${requestedPath}`);
  }

  return resolvedCandidate;
}

export async function prepareSlackUpload(
  params: SlackUploadParams,
  cwd: string,
  tmpdir: string,
  fsDeps: PrepareSlackUploadFs = {},
): Promise<PreparedSlackUpload> {
  const { readFileImpl = readFile } = fsDeps;
  const hasContent = typeof params.content === "string";
  const hasPath = typeof params.path === "string" && params.path.trim().length > 0;

  if (hasContent === hasPath) {
    throw new Error("Provide exactly one of content or path.");
  }

  let bytes: Buffer;
  let filename = params.filename?.trim();
  let resolvedPath: string | undefined;
  let source: PreparedSlackUpload["source"];

  if (hasContent) {
    if (!filename) {
      throw new Error("filename is required when uploading inline content.");
    }
    bytes = Buffer.from(params.content ?? "", "utf8");
    source = "content";
  } else {
    resolvedPath = await resolveSlackUploadPath(params.path!, cwd, tmpdir, fsDeps);
    bytes = await readFileImpl(resolvedPath);
    filename = filename || path.basename(resolvedPath);
    source = "path";
  }

  const sanitizedFilename = filename?.trim();
  if (!sanitizedFilename) {
    throw new Error("filename is required.");
  }

  const filetype = inferSlackUploadFiletype(sanitizedFilename, params.filetype);
  const title = params.title?.trim() || sanitizedFilename;

  return {
    bytes,
    byteLength: bytes.byteLength,
    filename: sanitizedFilename,
    title,
    filetype,
    snippetType: chooseSlackSnippetType({
      source,
      byteLength: bytes.byteLength,
      filename: sanitizedFilename,
      filetype,
    }),
    source,
    ...(resolvedPath ? { resolvedPath } : {}),
  };
}

export async function performSlackUpload({
  upload,
  channelId,
  threadTs,
  slack,
  token,
  fetchImpl = fetch,
}: PerformSlackUploadOptions): Promise<CompletedSlackUpload> {
  const getUploadResponse = await slack("files.getUploadURLExternal", token, {
    filename: upload.filename,
    length: upload.byteLength,
    ...(upload.snippetType ? { snippet_type: upload.snippetType } : {}),
  });

  const uploadUrl =
    typeof getUploadResponse.upload_url === "string" ? getUploadResponse.upload_url : null;
  const fileId = typeof getUploadResponse.file_id === "string" ? getUploadResponse.file_id : null;
  if (!uploadUrl || !fileId) {
    throw new Error("Slack files.getUploadURLExternal did not return an upload URL and file ID.");
  }

  const rawBody = new Uint8Array(upload.bytes.byteLength);
  rawBody.set(upload.bytes);

  const rawUploadResponse = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(upload.byteLength),
      "Content-Type":
        upload.source === "content" ? "text/plain; charset=utf-8" : "application/octet-stream",
    },
    body: new Blob([rawBody]),
  });

  if (!rawUploadResponse.ok) {
    const details = (await rawUploadResponse.text()).trim();
    throw new Error(
      `Slack raw upload failed (${rawUploadResponse.status}${rawUploadResponse.statusText ? ` ${rawUploadResponse.statusText}` : ""})${details ? `: ${details}` : ""}`,
    );
  }

  const response = await slack("files.completeUploadExternal", token, {
    files: [{ id: fileId, title: upload.title }],
    channel_id: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  return { fileId, response };
}
