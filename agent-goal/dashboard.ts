import type { AgentGoal, GoalContinuationClaim } from "./domain.js";

export function displayGoalText(value: string, maxLength: number): string {
  const normalized = value
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\u001b", "")
    .trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function formatGoalStatus(goal: AgentGoal): string {
  const iterations = `${goal.usage.iterations}/${goal.budget.maxIterations}`;
  const tokens = goal.budget.maxTokens
    ? ` · ${goal.usage.tokens}/${goal.budget.maxTokens} tok`
    : "";
  return `goal: ${goal.status} · ${iterations} turns${tokens}`;
}

export function formatGoalDashboard(goal: AgentGoal, claim?: GoalContinuationClaim): string[] {
  const usage = [
    `Turns ${goal.usage.iterations}/${goal.budget.maxIterations}`,
    goal.budget.maxTokens === undefined
      ? `Tokens ${goal.usage.tokens}`
      : `Tokens ${goal.usage.tokens}/${goal.budget.maxTokens}`,
    goal.budget.maxRuntimeMs === undefined
      ? undefined
      : `Runtime limit ${Math.round(goal.budget.maxRuntimeMs / 60_000)}m`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const lines = [
    `Goal · ${goal.status} · v${goal.version}`,
    displayGoalText(goal.objective, 120),
    usage,
  ];
  if (goal.lastEvaluation) {
    lines.push(
      `Last ${goal.lastEvaluation.outcome.toUpperCase()}: ${displayGoalText(goal.lastEvaluation.reason, 100)}`,
    );
  }
  if (goal.blockedReason) lines.push(`Reason: ${displayGoalText(goal.blockedReason, 100)}`);
  if (claim) lines.push(`Continuation: ${claim.state} · attempt ${claim.attempt}`);
  lines.push("/goal budget turns=<n> tokens=<n> · pause · resume · complete · clear · hide");
  return lines;
}
