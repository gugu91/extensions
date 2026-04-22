import type { BrowserToolRequest } from "./protocol.ts";

export function buildAgentBrowserModeResult(request: BrowserToolRequest) {
  const result = {
    mode: "agent-browser",
    command: request.action,
    raw_command: request.rawCommand,
    status: "blocked",
    available: false,
    reason:
      "agent-browser SDK mode is scaffolded behind the single browser tool, but this workspace does not yet have a working local agent-browser runtime path.",
    hint:
      "Use mode=playwright in this sandbox, or wire the agent-browser SDK runtime on a host that allows the required browser/socket integration.",
  } as const;

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}
