import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIMessageTools, type RegisterIMessageToolsDeps } from "./imessage-tools.js";
import { registerPinetTools, type RegisterPinetToolsDeps } from "./pinet-tools.js";
import { registerSlackTools, type RegisterSlackToolsDeps } from "./slack-tools.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

const SLACK_TOOL_NAMES = ["slack", "slack_inbox", "slack_send"] as const;
const PINET_TOOL_NAMES = ["pinet"] as const;
const IMESSAGE_TOOL_NAMES = ["imessage_send"] as const;
const MANAGED_TOOL_NAMES = new Set<string>([
  ...SLACK_TOOL_NAMES,
  ...PINET_TOOL_NAMES,
  ...IMESSAGE_TOOL_NAMES,
]);

export interface ToolRegistrationRuntimeDeps {
  slackTools: RegisterSlackToolsDeps;
  pinetTools: RegisterPinetToolsDeps;
  iMessageTools: RegisterIMessageToolsDeps;
  buildPromptGuidelines: () => Promise<string[]>;
}

export interface ToolRegistrationRuntime {
  register: (pi: ExtensionAPI) => void;
  sync: (pi: ExtensionAPI, mode: SlackBridgeRuntimeMode) => Promise<void>;
}

export function createToolRegistrationRuntime(
  deps: ToolRegistrationRuntimeDeps,
): ToolRegistrationRuntime {
  function register(pi: ExtensionAPI): void {
    registerSlackTools(pi, deps.slackTools);
    registerPinetTools(pi, deps.pinetTools);
    registerIMessageTools(pi, deps.iMessageTools);
  }

  async function sync(pi: ExtensionAPI, mode: SlackBridgeRuntimeMode): Promise<void> {
    const activeTools = pi.getActiveTools().filter((name) => !MANAGED_TOOL_NAMES.has(name));
    if (mode === "off") {
      pi.setActiveTools(activeTools);
      return;
    }

    const promptGuidelines = await deps.buildPromptGuidelines();
    registerSlackTools(pi, {
      ...deps.slackTools,
      additionalSendPromptGuidelines: mode === "single" ? promptGuidelines : [],
    });
    activeTools.push(...SLACK_TOOL_NAMES);

    if (mode === "broker" || mode === "follower") {
      registerPinetTools(pi, { ...deps.pinetTools, promptGuidelines });
      activeTools.push(...PINET_TOOL_NAMES, ...IMESSAGE_TOOL_NAMES);
    }
    pi.setActiveTools(activeTools);
  }

  return {
    register,
    sync,
  };
}
