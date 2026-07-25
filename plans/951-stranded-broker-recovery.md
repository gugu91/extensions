# 951 — Stranded broker recovery

Issue: https://github.com/gugu91/pinet/issues/951

## Problem

`/pinet start` collapses every leader-lock conflict into one generic error and
offers no recovery path. The lock stores only a PID and validates it with
`kill(pid, 0)`, so a second session cannot distinguish:

1. a healthy broker it should follow,
2. a dead broker with stale lock state,
3. a live but stranded/unresponsive broker process,
4. a stale lock whose PID was reused by an unrelated process.

When the Pi session hosting the broker is lost, recovery requires manual lock
forensics (`cat` the lock, `lsof`, signal a PID by hand).

## Design

### 1. Structured leader lock (broker-core/leader.ts)

New lock format, backward compatible with legacy plain-PID readers:

```
<pid>\n
{"version":2,"processStartTime":"...","instanceId":"...","hostname":"...","createdAt":"..."}
```

- Line 1 stays a plain PID so an older broker build parsing with `parseInt`
  still sees a live PID and refuses to take over (no mixed-version split-brain).
- `processStartTime` is captured deterministically (`/proc/<pid>/stat` start
  field on Linux, `LC_ALL=C ps -p <pid> -o lstart=` elsewhere) and compared by
  exact string equality. PID-reuse is only declared when both stored and
  current values are non-null and differ — uncertainty never reclaims a lock.
- New API: `readBrokerLockOwner()`, `inspectBrokerLock()` returning
  `none | stale-dead | stale-pid-reused | unreadable | alive` plus owner
  identity, and `getProcessStartTime()`.
- `tryAcquire()` reclaims `none`/`stale-*`/`unreadable`, refuses `alive`, and
  verifies the win by matching pid + instanceId after the atomic rename.

### 2. Conflict classification + typed error (slack-bridge/broker/lock-conflict.ts)

- `probeBrokerSocket(target, timeoutMs)` — bounded connect + `auth` RPC.
  Any well-formed JSON-RPC response (including an auth error) proves the broker
  event loop is serving: `healthy | unreachable | unresponsive`.
- `classifyBrokerLockConflict()` — lock inspection plus probe.
- `BrokerLockConflictError` — thrown by `startBroker` on lock conflict, carrying
  `classification` (`active-broker | unresponsive-broker`), lock owner identity,
  and probe result, with an actionable message. `startBroker` retries the
  acquire once when classification says the conflict became reclaimable
  (owner died between attempts).

### 3. Graceful remote shutdown (`admin.shutdown` RPC)

- New authenticated socket-server method `admin.shutdown`. The broker runtime
  wires a handler that stops the Pinet runtime in the owning session (session
  survives; it just stops being the broker) and notifies its UI.
- Responds first (`{ ok: true }`), shuts down on the next tick. Brokers without
  a wired handler return method-not-found so callers treat them as
  `unsupported` and fall back.

### 4. Conservative takeover (`/pinet start replace`)

`replaceBrokerOwner()` orchestration, with injectable deps for tests:

1. Inspect the lock. Stale/none → nothing to replace (normal start reclaims).
2. Live owner → request `admin.shutdown` over the socket, then poll for lock
   release (bounded).
3. If unsupported/unreachable/timed out → re-verify the owner fence (same pid +
   process start time + instanceId), then SIGTERM the verified owner and poll
   again (bounded).
4. Never SIGKILL; on failure report the owner PID and manual guidance.
5. Abort if the owner identity changes mid-flight (someone else recovered).

### 5. Operator surfaces

- `/pinet start` conflict messages become state-specific:
  - healthy broker → suggest `/pinet follow` or `/pinet start replace`;
  - unresponsive owner → suggest `/pinet start replace`.
- `/pinet start replace` runs the takeover then a normal broker start.
- `/pinet status` in `off`/`single` modes appends a machine-wide
  "Global broker" section (lock state, owner pid/age, socket health, next step),
  so the disconnected session — precisely the one that needs recovery — can see
  global broker state.

## Non-goals

- No daemonization (tracked by the PRD in plans/420-broker-daemon-prd.md).
- No automatic unattended takeover: replace stays an explicit operator action.
- No weakening of the single-broker invariant.

## Test plan

- leader: v2 write/read, legacy parse, dead-PID reclaim, PID-reuse reclaim via
  injected start-time provider, corrupt-lock reclaim, alive refusal, release
  fencing.
- lock-conflict: probe against a real socket server (healthy), missing socket
  (unreachable), silent server (unresponsive); classification matrix;
  `replaceBrokerOwner` graceful, fallback-terminate, owner-changed abort, and
  failure paths with injected deps.
- socket-server: `admin.shutdown` happy path, unauthenticated rejection,
  handler-missing → method-not-found.
- pinet-commands: start conflict messaging per classification, `start replace`
  flow, status global-broker section.

## Post-review hardening (PR #952 review findings)

- **Exclusive acquisition**: `tryAcquire` no longer uses check-then-rename
  (which admitted multiple simultaneous leaders — reproduced at 4–7 winners
  of 8 contenders on the base algorithm with winners held alive). The lock is
  created via write-temp + `link()` (atomic, exclusive, full content at the
  instant the path exists), so the kernel picks exactly one winner. Stale
  locks are only unlinked while holding an exclusively-created
  `<lockPath>.reclaim` mutex, with staleness re-verified under the mutex; a
  mutex left by a crashed reclaimer (dead PID) is itself reclaimed.
- **Release fencing**: `release()` requires the on-disk `instanceId` to match
  this acquisition, not just the PID, so a stale handle cannot delete a
  successor's lock.
- **Termination fencing**: `replaceBrokerOwner` refuses automatic SIGTERM for
  owners without a recorded process start identity (legacy locks), and
  aborts without signalling when a responsive broker rejects the shutdown
  RPC (`rejected`, typically a mesh secret mismatch) — a responsive broker
  is not stranded.
- **Multi-process regression tests**: two stress tests spawn 8 real
  contender processes racing over an empty path and over a stale lock, and
  assert exactly one winner (winners hold the lock until every contender has
  decided, so the test measures mutual exclusion rather than legitimate
  dead-owner recovery).
