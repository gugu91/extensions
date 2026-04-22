import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentCompletionRuntime } from "./agent-completion-runtime.js";
import type { AgentPromptGuidance } from "./agent-prompt-guidance.js";
import {
  createSlackToolPolicyRuntime,
  type SlackToolPolicyRuntime,
  type SlackToolPolicyRuntimeDeps,
} from "./slack-tool-policy-runtime.js";

interface BrokerTurnMessageEndEvent {
  message: {
    role: string;
    stopReason?: string;
    errorMessage?: string;
  };
}

interface BrokerTurnAgentEndEvent {
  messages: readonly {
    role: string;
    stopReason?: string;
    errorMessage?: string;
    provider?: string;
    model?: string;
  }[];
}

export interface AgentEventRuntimeDeps extends SlackToolPolicyRuntimeDeps {
  beforeAgentStart: AgentPromptGuidance["beforeAgentStart"];
  onBrokerTurnMessageEnd: (event: BrokerTurnMessageEndEvent) => Promise<void>;
  onBrokerTurnAgentEnd: (event: BrokerTurnAgentEndEvent, ctx: ExtensionContext) => Promise<void>;
  onCompletionAgentEnd: AgentCompletionRuntime["onAgentEnd"];
  setDeliverTrackedSlackFollowUpMessage: (
    deliver: SlackToolPolicyRuntime["deliverTrackedSlackFollowUpMessage"],
  ) => void;
}

export interface AgentEventRuntime {
  register: (pi: Pick<ExtensionAPI, "on">) => void;
}

export function createAgentEventRuntime(deps: AgentEventRuntimeDeps): AgentEventRuntime {
  const slackToolPolicyRuntime = createSlackToolPolicyRuntime({
    getBrokerRole: deps.getBrokerRole,
    getGuardrails: deps.getGuardrails,
    requireToolPolicy: deps.requireToolPolicy,
    formatAction: deps.formatAction,
    formatError: deps.formatError,
    deliverFollowUpMessage: deps.deliverFollowUpMessage,
  });

  deps.setDeliverTrackedSlackFollowUpMessage(
    slackToolPolicyRuntime.deliverTrackedSlackFollowUpMessage,
  );

  function register(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("input", slackToolPolicyRuntime.onInput);
    pi.on("turn_start", slackToolPolicyRuntime.onTurnStart);
    pi.on("turn_end", slackToolPolicyRuntime.onTurnEnd);
    pi.on("agent_end", slackToolPolicyRuntime.onAgentEnd);
    pi.on("tool_call", slackToolPolicyRuntime.onToolCall);
    pi.on("before_agent_start", deps.beforeAgentStart);
    pi.on("message_end", deps.onBrokerTurnMessageEnd);
    pi.on("agent_end", deps.onBrokerTurnAgentEnd);
    pi.on("agent_end", deps.onCompletionAgentEnd);
  }

  return {
    register,
  };
}
