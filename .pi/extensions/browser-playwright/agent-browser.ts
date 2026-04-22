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
        "agent-browser SDK mode is scaffolded behind the single browser tool, but this workspace does not yet have a working local agent-browser runtime path.",
      hint:
        "Use backend=playwright in this sandbox, or wire the agent-browser SDK/runtime on a host that allows the required browser and socket integration.",
    },
    artifacts: [],
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}
