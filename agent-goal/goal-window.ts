import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { displayGoalText } from "./dashboard.js";
import type { AgentGoal, GoalContinuationClaim } from "./domain.js";

function progressBar(value: number, maximum: number, width: number): string {
  const ratio = Math.min(1, Math.max(0, value / maximum));
  const filled = Math.round(ratio * width);
  return `${"━".repeat(filled)}${"─".repeat(width - filled)}`;
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = value < 1_000_000 ? "k" : "m";
  const scaled = value / divisor;
  return `${scaled.toFixed(scaled < 100 ? 1 : 0).replace(/\.0$/, "")}${suffix}`;
}

export type GoalWindowLifecycleAction = "pause" | "resume" | "complete" | "clear" | "close";
export type GoalWindowAction =
  | GoalWindowLifecycleAction
  | { type: "budget"; maxIterations: number; maxTokens?: number };

type ConfirmableGoalWindowAction = Extract<GoalWindowLifecycleAction, "complete" | "clear">;
type BudgetField = "turns" | "tokens";

export class GoalWindow implements Component {
  private pendingConfirmation: ConfirmableGoalWindowAction | undefined;
  private budgetField: BudgetField | undefined;
  private budgetTurns = "";
  private budgetTokens = "";
  private replaceBudgetValue = false;
  private budgetInputError: string | undefined;

  constructor(
    private readonly goal: AgentGoal | undefined,
    private readonly claim: GoalContinuationClaim | undefined,
    private readonly theme: Theme,
    private readonly onAction: (action: GoalWindowAction) => void,
    private readonly requestRender: () => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly actionError?: string,
  ) {}

  handleInput(data: string): void {
    const key = data.toLowerCase();
    if (matchesKey(data, "ctrl+c") || key === "q") {
      this.onAction("close");
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.pendingConfirmation) {
        this.pendingConfirmation = undefined;
        this.requestRender();
      } else if (this.budgetField) {
        this.budgetField = undefined;
        this.budgetInputError = undefined;
        this.requestRender();
      } else {
        this.onAction("close");
      }
      return;
    }
    if (!this.goal) return;

    if (this.budgetField) {
      if (matchesKey(data, "tab") || matchesKey(data, "up") || matchesKey(data, "down")) {
        this.budgetField = this.budgetField === "turns" ? "tokens" : "turns";
        this.replaceBudgetValue = true;
        this.budgetInputError = undefined;
      } else if (matchesKey(data, "backspace")) {
        const value = this.budgetField === "turns" ? this.budgetTurns : this.budgetTokens;
        if (this.budgetField === "turns") this.budgetTurns = value.slice(0, -1);
        else this.budgetTokens = value.slice(0, -1);
        this.replaceBudgetValue = false;
        this.budgetInputError = undefined;
      } else if (matchesKey(data, "enter")) {
        const maxIterations = Number(this.budgetTurns);
        if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
          this.budgetInputError = "Turns must be a positive integer";
        } else {
          const maxTokens = this.budgetTokens ? Number(this.budgetTokens) : undefined;
          this.onAction({ type: "budget", maxIterations, maxTokens });
          return;
        }
      } else if (/^\d+$/.test(data)) {
        const value = this.replaceBudgetValue
          ? data
          : `${this.budgetField === "turns" ? this.budgetTurns : this.budgetTokens}${data}`;
        if (this.budgetField === "turns") this.budgetTurns = value;
        else this.budgetTokens = value;
        this.replaceBudgetValue = false;
        this.budgetInputError = undefined;
      } else {
        return;
      }
      this.requestRender();
      return;
    }

    if (this.pendingConfirmation) {
      const confirmationKey = this.pendingConfirmation === "complete" ? "c" : "x";
      if (key === confirmationKey) {
        this.onAction(this.pendingConfirmation);
      } else {
        this.pendingConfirmation = undefined;
        this.requestRender();
      }
      return;
    }

    if (key === "b" && this.goal.status !== "complete") {
      this.budgetField = "turns";
      this.budgetTurns = String(this.goal.budget.maxIterations);
      this.budgetTokens =
        this.goal.budget.maxTokens === undefined ? "" : String(this.goal.budget.maxTokens);
      this.replaceBudgetValue = true;
      this.budgetInputError = undefined;
      this.requestRender();
    } else if (key === "p" && this.goal.status === "active") {
      this.onAction("pause");
    } else if (key === "r" && (this.goal.status === "paused" || this.goal.status === "blocked")) {
      this.onAction("resume");
    } else if (key === "c" && this.goal.status !== "complete") {
      this.pendingConfirmation = "complete";
      this.requestRender();
    } else if (key === "x") {
      this.pendingConfirmation = "clear";
      this.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 8) return [truncateToWidth("Goal", Math.max(0, width), "")];
    const innerWidth = width - 2;
    const contentWidth = Math.max(1, innerWidth - 2);
    const borderColor = this.goal?.status === "complete" ? "success" : "borderAccent";
    const border = (text: string): string => this.theme.fg(borderColor, text);
    const row = (content = ""): string => {
      const truncated = truncateToWidth(content, innerWidth, "", true);
      return `${border("│")}${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}${border("│")}`;
    };
    const title = this.theme.fg("accent", this.theme.bold(" Goal "));
    const titleWidth = visibleWidth(title);
    const lines = [
      `${border("╭")}${title}${border(`${"─".repeat(Math.max(0, innerWidth - titleWidth))}╮`)}`,
    ];

    if (!this.goal) {
      lines.push(row(), row(` ${this.theme.fg("muted", "No goal for this session.")}`));
      lines.push(row(` ${this.theme.fg("dim", "/goal <objective> to begin")}`), row());
      lines.push(row(` ${this.theme.fg("dim", "esc · q  close")}`));
      lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
      return lines;
    }

    const statusColor =
      this.goal.status === "complete"
        ? "success"
        : this.goal.status === "blocked"
          ? "error"
          : this.goal.status === "active"
            ? "accent"
            : "warning";
    lines.push(row(` ${this.theme.fg(statusColor, `● ${this.goal.status.toUpperCase()}`)}`));

    const objectiveLines = wrapTextWithAnsi(
      displayGoalText(this.goal.objective, 500),
      contentWidth,
    ).slice(0, 3);
    for (const objectiveLine of objectiveLines) lines.push(row(` ${objectiveLine}`));
    lines.push(row());

    const turnBar = progressBar(
      this.goal.usage.iterations,
      this.goal.budget.maxIterations,
      Math.min(12, Math.max(4, contentWidth - 23)),
    );
    lines.push(
      row(
        ` Turns  ${this.theme.fg("accent", turnBar)}  ${this.goal.usage.iterations}/${this.goal.budget.maxIterations}`,
      ),
    );

    if (this.goal.budget.maxTokens === undefined) {
      lines.push(row(` Tokens ${compactNumber(this.goal.usage.tokens)}`));
    } else {
      const tokenBar = progressBar(
        this.goal.usage.tokens,
        this.goal.budget.maxTokens,
        Math.min(12, Math.max(4, contentWidth - 23)),
      );
      lines.push(
        row(
          ` Tokens ${this.theme.fg("accent", tokenBar)}  ${compactNumber(this.goal.usage.tokens)}/${compactNumber(this.goal.budget.maxTokens)}`,
        ),
      );
    }

    if (this.goal.budget.maxRuntimeMs !== undefined) {
      const end = this.goal.status === "active" ? this.now() : Date.parse(this.goal.updatedAt);
      const elapsed = Math.max(0, end - Date.parse(this.goal.createdAt));
      const runtimeBar = progressBar(
        elapsed,
        this.goal.budget.maxRuntimeMs,
        Math.min(12, Math.max(4, contentWidth - 23)),
      );
      lines.push(
        row(
          ` Time   ${this.theme.fg("accent", runtimeBar)}  ${Math.floor(elapsed / 60_000)}m/${Math.ceil(this.goal.budget.maxRuntimeMs / 60_000)}m`,
        ),
      );
    }

    if (this.goal.lastEvaluation) {
      lines.push(
        row(),
        row(
          ` ${this.theme.fg("muted", "Latest")} ${displayGoalText(this.goal.lastEvaluation.reason, Math.max(20, contentWidth - 8))}`,
        ),
      );
    } else if (this.goal.blockedReason) {
      lines.push(
        row(),
        row(
          ` ${this.theme.fg("muted", "Reason")} ${displayGoalText(this.goal.blockedReason, Math.max(20, contentWidth - 8))}`,
        ),
      );
    }
    if (this.claim) {
      lines.push(
        row(
          ` ${this.theme.fg("muted", "Continuation")} ${this.claim.state} · attempt ${this.claim.attempt}`,
        ),
      );
    }

    if (this.budgetField) {
      const turns = `${this.budgetField === "turns" ? "›" : " "} Turns  ${this.budgetTurns || "_"}`;
      const tokens = `${this.budgetField === "tokens" ? "›" : " "} Tokens ${this.budgetTokens || "unchanged"}`;
      lines.push(
        row(),
        row(` ${this.theme.fg("accent", "Edit budget")}`),
        row(` ${turns}`),
        row(` ${tokens}`),
      );
    }
    const error = this.budgetInputError ?? this.actionError;
    if (error) lines.push(row(` ${this.theme.fg("error", displayGoalText(error, contentWidth))}`));

    const actions = [
      this.goal.status === "active" ? "p pause" : undefined,
      this.goal.status === "paused" || this.goal.status === "blocked" ? "r resume" : undefined,
      this.goal.status !== "complete" ? "b budget" : undefined,
      this.goal.status !== "complete" ? "c complete" : undefined,
      "x clear",
      "q close",
    ].filter((action): action is string => action !== undefined);
    const footer = this.pendingConfirmation
      ? `${this.pendingConfirmation === "complete" ? "c" : "x"} again to confirm ${this.pendingConfirmation} · esc cancel`
      : this.budgetField
        ? "digits edit · tab field · enter save · esc cancel"
        : actions.join(" · ");
    lines.push(row(), row(` ${this.theme.fg("dim", footer)}`));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}
}
