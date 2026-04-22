import { buildCapabilities, type BrowserToolRequest } from "./protocol.ts";

export function buildAgentBrowserModeResult(request: BrowserToolRequest): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const result: Record<string, unknown> = {
    backend: "agent-browser",
    action: request.action,
    session_id: request.sessionId ?? null,
    page_id: request.pageId ?? null,
    capabilities: buildCapabilities("agent-browser"),
    result: {
      status: "blocked",
      available: false,
      reason:
        "agent-browser is not a supported local browsing path behind this extension in the active sandbox.",
      constraints: {
        packaging:
          "The published `agent-browser` npm package is CLI/bin-oriented and does not expose an importable JS SDK entrypoint for the documented BrowserManager-style API.",
        runtime:
          "The local agent-browser runtime uses a client-daemon architecture. In this Unix sandbox the daemon fails during startup because binding its local session socket returns EPERM (`Failed to bind socket: Operation not permitted`).",
      },
      hint: "Use the default browser tool path in this Anthropic sandbox. Playwright is the supported local backend here; any future agent-browser path would need remote/provider-backed execution rather than local daemon compatibility.",
    },
    artifacts: [],
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}
