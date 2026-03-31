import type { AgentInfo, BrokerDBInterface, InboundMessage, RoutingDecision } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────

/**
 * Extract an agent name mention from message text.
 * Matches patterns like "hey AgentName," or "@AgentName" or just "AgentName"
 * at word boundaries (case-insensitive).
 */
export function findAgentMention(text: string, agents: AgentInfo[]): AgentInfo | null {
  const lower = text.toLowerCase();
  for (const agent of agents) {
    const name = agent.name.toLowerCase();
    if (!name) continue;
    // Match agent name at a word boundary
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    if (pattern.test(lower)) return agent;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── MessageRouter ───────────────────────────────────────

export class MessageRouter {
  private readonly db: BrokerDBInterface;

  constructor(db: BrokerDBInterface) {
    this.db = db;
  }

  /**
   * Route an inbound message to the right agent.
   *
   * Priority order:
   * 1. User allowlist — reject if user not allowed
   * 2. Thread ownership — existing thread with an owner agent
   * 3. Channel assignment — channel mapped to a specific agent
   * 4. Direct address — message mentions an agent by name
   * 5. Unrouted — no match found
   */
  route(msg: InboundMessage): RoutingDecision {
    // 0. Check user allowlist
    const allowedUsers = this.db.getAllowedUsers();
    if (allowedUsers !== null && !allowedUsers.has(msg.userId)) {
      return { action: "reject", reason: "User not in allowlist" };
    }

    const agents = this.db.getAgents();

    // 1. Thread ownership — if thread already has an owner, route there
    const thread = this.db.getThread(msg.threadId);
    if (thread?.ownerAgent) {
      const owner = agents.find((a) => a.id === thread.ownerAgent);
      if (owner) {
        return { action: "deliver", agentId: owner.id };
      }
      // Owner agent is disconnected — still deliver (broker queues in inbox)
      return { action: "deliver", agentId: thread.ownerAgent };
    }

    // 2. Channel assignment — if channel is mapped to a specific agent
    const assignment = this.db.getChannelAssignment(msg.channel);
    if (assignment) {
      return { action: "deliver", agentId: assignment.agentId };
    }

    // 3. Direct address — message mentions an agent by name
    const mentioned = findAgentMention(msg.text, agents);
    if (mentioned) {
      return { action: "deliver", agentId: mentioned.id };
    }

    // 4. No match
    return { action: "unrouted" };
  }

  /**
   * Claim a thread for an agent (first-responder-wins).
   * Returns true if the claim succeeded, false if another agent already owns it.
   */
  claimThread(threadId: string, agentId: string): boolean {
    const existing = this.db.getThread(threadId);

    if (existing) {
      // Already owned by someone else
      if (existing.ownerAgent && existing.ownerAgent !== agentId) {
        return false;
      }
      // Unclaimed or already owned by this agent — claim it
      this.db.updateThread(threadId, { ownerAgent: agentId });
      return true;
    }

    // Thread doesn't exist yet — create and claim
    const now = new Date().toISOString();
    this.db.createThread({
      threadId,
      source: "slack",
      channel: "",
      ownerAgent: agentId,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  /**
   * Get the owner of a thread, or null if unclaimed / nonexistent.
   */
  getThreadOwner(threadId: string): string | null {
    const thread = this.db.getThread(threadId);
    return thread?.ownerAgent ?? null;
  }

  /**
   * List available (connected) agents for routing.
   */
  getAvailableAgents(): AgentInfo[] {
    return this.db.getAgents();
  }
}
