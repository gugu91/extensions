import type { ActivityLogTone } from "./activity-log.js";

export type PinetTrackedAssignmentStatus =
  | "assigned"
  | "branch_pushed"
  | "pr_open"
  | "pr_merged"
  | "pr_closed";

export interface PinetActivityFormattingAgentRecord {
  emoji: string;
  name: string;
}

export interface PinetActivityFormattingBrokerDbPort {
  getAgentById: (agentId: string) => PinetActivityFormattingAgentRecord | null;
}

export interface PinetActivityFormattingDeps {
  getActiveBrokerDb: () => PinetActivityFormattingBrokerDbPort | null;
}

export interface PinetActivityFormatting {
  formatTrackedAgent: (agentId: string) => string;
  summarizeTrackedAssignmentStatus: (
    status: PinetTrackedAssignmentStatus,
    prNumber: number | null,
    branch: string | null,
  ) => { summary: string; tone: ActivityLogTone };
}

export function createPinetActivityFormatting(
  deps: PinetActivityFormattingDeps,
): PinetActivityFormatting {
  function formatTrackedAgent(agentId: string): string {
    const agent = deps.getActiveBrokerDb()?.getAgentById(agentId);
    if (!agent) {
      return agentId;
    }

    return `${agent.emoji} ${agent.name}`.trim();
  }

  function summarizeTrackedAssignmentStatus(
    status: PinetTrackedAssignmentStatus,
    prNumber: number | null,
    branch: string | null,
  ): { summary: string; tone: ActivityLogTone } {
    switch (status) {
      case "pr_merged":
        return {
          summary: `PR #${prNumber ?? "?"} merged`,
          tone: "success",
        };
      case "pr_open":
        return {
          summary: `PR #${prNumber ?? "?"} opened for review`,
          tone: "success",
        };
      case "pr_closed":
        return {
          summary: `PR #${prNumber ?? "?"} closed without merge`,
          tone: "warning",
        };
      case "branch_pushed":
        return {
          summary: `commits pushed on ${branch ?? "tracked branch"}`,
          tone: "info",
        };
      case "assigned":
      default:
        return {
          summary: "assigned",
          tone: "info",
        };
    }
  }

  return {
    formatTrackedAgent,
    summarizeTrackedAssignmentStatus,
  };
}
