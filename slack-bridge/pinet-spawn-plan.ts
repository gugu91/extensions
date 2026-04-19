export interface PinetSpawnPlanOptions {
  cwd: string;
  branch?: string | null;
  socketPath?: string | null;
  count?: number | null;
}

export interface PinetSpawnPlan {
  branch: string | null;
  count: number;
  launcherScriptPath: string;
  logDir: string;
  commands: string[];
  summary: string;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function sanitizeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
}

function buildSpawnSlug(branch: string | null): string {
  const source = branch ?? "pinet-follower";
  return source
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function clampCount(count?: number | null): number {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return 1;
  }
  const normalized = Math.trunc(count);
  if (normalized < 1) {
    return 1;
  }
  return normalized;
}

export function buildPinetFollowerSpawnPlan(options: PinetSpawnPlanOptions): PinetSpawnPlan {
  const branch = normalizeOptional(options.branch);
  const sanitizedBranch = branch ? sanitizeBranchName(branch) : null;
  const slug = buildSpawnSlug(sanitizedBranch);
  const count = clampCount(options.count);
  const socketPath = normalizeOptional(options.socketPath);
  const launcherScriptPath = `.pi/tmp/pinet-follow-${slug}.sh`;
  const logDir = `.pi/tmp/pinet-follow-${slug}-logs`;

  const commandParts = [
    "pi",
    ...(socketPath ? [`--broker-socket=${JSON.stringify(socketPath)}`] : []),
  ];
  const piInvocation = commandParts.join(" ");
  const branchCommand = sanitizedBranch
    ? `git worktree add .worktrees/${slug}-worker-$N -b ${sanitizedBranch}-worker-$N`
    : `mkdir -p .worktrees/${slug}-worker-$N`;
  const moveCommand = sanitizedBranch
    ? `cd .worktrees/${slug}-worker-$N`
    : `cd ${JSON.stringify(options.cwd)}`;
  const launcherBody = [
    "#!/bin/bash",
    "set -euo pipefail",
    `ROOT=${JSON.stringify(options.cwd)}`,
    "N=${1:-1}",
    `LOG_DIR=${JSON.stringify(logDir)}`,
    'mkdir -p "$ROOT/$LOG_DIR"',
    'cd "$ROOT"',
    branchCommand,
    moveCommand,
    `exec ${piInvocation} --command /pinet-follow > "$ROOT/$LOG_DIR/worker-$N.log" 2>&1`,
  ].join("\n");

  const spawnLoop = [
    `mkdir -p ${JSON.stringify(logDir)}`,
    `cat > ${JSON.stringify(launcherScriptPath)} <<'EOF'\n${launcherBody}\nEOF`,
    `chmod +x ${JSON.stringify(launcherScriptPath)}`,
    `for N in $(seq 1 ${count}); do (${JSON.stringify(launcherScriptPath)} "$N" </dev/null &); done`,
  ];

  return {
    branch: sanitizedBranch,
    count,
    launcherScriptPath,
    logDir,
    commands: spawnLoop,
    summary:
      `Launch ${count} real Pinet follower${count === 1 ? "" : "s"}` +
      (sanitizedBranch
        ? ` on worktrees branched from ${sanitizedBranch}`
        : " in the current checkout") +
      `. Logs stream to ${logDir}.`,
  };
}
