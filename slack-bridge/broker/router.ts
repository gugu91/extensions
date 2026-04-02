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

function isRoutableOwner(agent: AgentInfo, now = new Date().toISOString()): boolean {
  if (!agent.disconnectedAt) return true;
  return agent.resumableUntil != null && agent.resumableUntil > now;
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

    // 1. Thread ownership — if thread already has an owner, route there.
    //    Disconnected owners are only routable during an explicit resumable
    //    window; graceful unregister should release ownership immediately.
    let thread = this.db.getThread(msg.threadId);
    if (thread?.ownerAgent) {
      const owner = this.db.getAgentById(thread.ownerAgent);
      if (owner && isRoutableOwner(owner)) {
        return { action: "deliver", agentId: owner.id };
      }
      // Owner is gone or no longer routable — clear ownership and fall through.
      this.db.updateThread(msg.threadId, { ownerAgent: null });
      thread = this.db.getThread(msg.threadId);
    }

    // 2. Channel assignment — if channel is mapped to a connected agent
    const assignment = this.db.getChannelAssignment(msg.channel);
    if (assignment) {
      const assigned = agents.find((agent) => agent.id === assignment.agentId);
      if (assigned) {
        return { action: "deliver", agentId: assigned.id };
      }
    }

    // 3. Direct address — message mentions an agent by name.
    //    If the thread is new or currently unclaimed, bind it to the
    //    mentioned agent so follow-up replies keep routing there.
    if (!thread?.ownerAgent) {
      const mentioned = findAgentMention(msg.text, agents);
      if (mentioned) {
        const claimed = this.db.claimThread(msg.threadId, mentioned.id, msg.source, msg.channel);
        if (claimed) {
          return { action: "deliver", agentId: mentioned.id };
        }

        const claimedThread = this.db.getThread(msg.threadId);
        const claimedOwner = claimedThread?.ownerAgent
          ? this.db.getAgentById(claimedThread.ownerAgent)
          : null;
        if (claimedOwner && isRoutableOwner(claimedOwner)) {
          return { action: "deliver", agentId: claimedOwner.id };
        }
      }
    }

    // 4. No match
    return { action: "unrouted" };
  }

  /**
   * Claim a thread for an agent (first-responder-wins).
   * Optionally provide a channel to set when creating a new thread.
   * Returns true if the claim succeeded, false if another agent already owns it.
   *
   * Delegates to the DB layer which performs the claim atomically
   * (single SQL statement) to avoid TOCTOU races. (#125)
   */
  claimThread(threadId: string, agentId: string, channel?: string): boolean {
    return this.db.claimThread(threadId, agentId, "slack", channel ?? "");
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
