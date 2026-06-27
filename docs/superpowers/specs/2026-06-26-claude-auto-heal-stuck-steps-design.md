# Spec — Claude Auto-Heal for Stuck Recorded Steps

**Date:** 2026-06-26
**Related:** `docs/superpowers/specs/2026-06-26-human-behavior-automation-design.md`
**Status:** Design approved — ready for implementation plan.

---

## Problem

Recorded-click automations replay deterministically via `RecordedReplayEngine`.
When a step fails all its retries the engine **pauses** and waits for a human to
Resume or Stop (`recorded-replay.ts:69-77`). That stalls unattended runs: a moved
button, a renamed label, an extra modal, or a slow page halts the whole sequence
until a person intervenes.

We want Claude to **step in automatically** when a step gets stuck, get the page
back into the state the recording expected, and hand control back to deterministic
replay so the sequence continues "on rails."

## Goal

When a recorded step gets stuck, Claude takes over the **same Playwright page**,
accomplishes **only that one step's intent**, and returns control to deterministic
replay at the next step. If Claude also fails, fall back to today's human pause.

## Non-Goals

- No persistence/"self-healing" of the saved recording (recover in-the-moment only).
- No autonomous pursuit of the overall goal — recovery is scoped to a single step.
- No per-automation toggle — auto-heal is always on when an API key is present.
- No new recovery for non-resolvable step types (raw scroll/keypress/navigate that
  have no element target): recovery declines → falls back to pause.

---

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Trigger model | **Auto-heal** — fires automatically on stuck, no user action |
| 2 | Recovery scope | **Just the stuck step**; next recorded step = success signal |
| 3 | Persistence | **Recover only** — never modify the saved recording |
| 4 | When recovery fails | **Fall back to human pause** (today's behavior) |
| 5 | Stuck detection | **3-retry exhaustion + per-step watchdog timeout** for hangs |
| 6 | Secrets | **Never recover sensitive steps** — they're paused for manual entry, value not stored |
| 7 | Destructive steps | **Don't auto-heal irreversible steps** — fall back to human pause |
| 8 | Success signal | **Semantic** (step intent held) first, next-step-resolves second |
| 9 | Motion during recovery | **Final recovered action uses the engine's human-motion path** |

---

## Design-review mitigations (required before build)

A second-pass audit of the whole feature surfaced holes the original design didn't
cover. These are **required** mitigations, not options.

### M1 — Secrets never reach the model (holes S1/S2)
The recorder no longer stores values for sensitive fields (`step.sensitive`,
value blanked at capture). Recovery **must**:
- **decline** any `step.sensitive` step (return `{ recovered:false }`) — these are
  handled by the engine's manual-entry pause, not by Claude;
- never place a recorded `value` for such a step into a prompt.

`describeStepIntent` omits the literal value for sensitive steps and, for normal
`type` steps, includes the value only when it is plainly non-secret.

### M2 — Don't auto-heal irreversible actions (hole S3)
Auto-heal removes the human from the loop, so a step that may have *partially*
succeeded (payment submitted, message sent, record deleted) must not be blindly
re-attempted. Add `isLikelyDestructive(failedStep)` — matches the step's
label/description/selector against a denylist (`buy|pay|checkout|order|delete|
remove|send|submit|confirm|transfer|withdraw|publish`). When it matches, recovery
**declines** and the engine falls back to the human pause with a clear reason
(`Auto-heal skipped (possibly irreversible step) — verify manually`).

### M3 — Semantic success signal, not just the next selector (hole A1)
"Next recorded step resolves" fails exactly when the page was redesigned (the case
auto-heal exists for), because the next step's selector is also stale. `onRails`
becomes a layered check, first-match wins:
1. **Intent verification** — re-run the failed step's own post-condition where it
   has one (`type`/`select` read-back via `verifyStep`); for `click`, a meaningful
   page change vs the pre-recovery fingerprint.
2. **Next step resolves** — the original secondary signal.
3. **Claude `isDone`** — the model asserts the single-step goal is met.
Any one satisfied ⇒ on-rails.

### M4 — Overshoot / double-execution guard (hole A3)
Recovery returns `advanceBy` (default `1`). If `onRails` was satisfied because
Claude already performed the **next** recorded step (detected when intent
verification passed *and* the next step's post-condition is already met before the
engine runs it), recovery returns `advanceBy: 2` so the engine skips the
already-done next step instead of running it twice.

### M5 — Wall-clock budget + loop circuit-breaker (hole A4)
- `MAX_RECOVERY_MS = 30000` bounds a recovery attempt in wall-clock time in
  addition to the `MAX_RECOVERY_ACTIONS = 5` count.
- In loop mode the engine tracks consecutive auto-heals per step index; after
  `MAX_AUTOHEAL_PER_STEP = 3` consecutive loop iterations heal the same step, the
  engine **stops auto-healing that step** and falls back to the human pause —
  preventing an unbounded spend on a permanently-broken recording.

### M6 — Human-motion continuity (holes A2/A5)
The *final* successful recovery action is performed through the engine's
trusted human-motion path (`pointerTo`/`actClick`/`actType`), not the raw
element-map executor, so the behavioral fingerprint stays consistent on
bot-protected sites. After recovery, the engine's tracked cursor (`this.mouse`) is
synced to the last landing point so the next bezier move starts from the right
origin.

---

## How the sequence knows it's stuck

Detection already exists in the engine; recovery hooks onto it.

`attemptStep` (`recorded-replay.ts:110`) runs `STEP_RETRIES = 3` cycles of
**resolve → snapshot → act → verify**. An attempt fails for one of three reasons:

1. **Target not found** — `resolveLocator` returns `null`, the act throws
   (`"click: could not resolve target"`, `"type: could not resolve target field"`).
2. **Action errors / times out** — Playwright native input throws (actionability
   timeout, detached, occluded, navigation interrupt); caught at `recorded-replay.ts:123`.
3. **Verification fails** — `verifyStep` returns `{ ok:false }` (e.g. a `type` field
   read-back ≠ expected, `step-verifier.ts:62`).

After 3 failed attempts `attemptStep` returns `{ ok:false, reason }`. **That return
is the stuck signal**, and it already carries a human-readable reason that we pass
to Claude.

**Lenient-click caveat (by design):** `click`/`keypress` verification passes even
without an observable page change (`step-verifier.ts:94-99`), so a click that lands
but silently sends the page somewhere wrong is **not** flagged at that step. The
divergence surfaces one step later — the next step can't resolve its target →
that step exhausts retries → recovery fires there. The recovery success criterion
("next recorded step resolves", see below) is the same mechanism that catches this,
so the system self-corrects one step late rather than never.

**Watchdog (new):** the `navigate` act (`recorded-replay.ts:176`) has no explicit
timeout, so a page that never fires `domcontentloaded` hangs forever instead of
failing. Wrap each step's act in a per-step watchdog (`Promise.race` against a
timeout, e.g. 15 s) so a hang becomes a normal attempt failure → counts toward
exhaustion → triggers recovery.

---

## Architecture

Two existing systems already share one server-side Playwright page:

- **Recorded replay** — `RecordedReplayEngine` + `RecordedAutomationManager`
  (deterministic, human-like motion).
- **AI agent brain** — `analyzePage` (`page-analyzer.ts`) + `askAgentWhatToDo`
  (`ai-client.ts`) + element-map action execution (today private in
  `AgentManager.executeAgentAction`).

Recovery reuses the agent brain at the failure point of replay. Both managers are
constructed with the same `PlaywrightSession` in `app.ts:63-68`.

```
RecordedReplayEngine.run
  └─ attemptStep (resolve→snapshot→act[+watchdog]→verify, 3 retries)
        └─ ok? → next step
        └─ stuck? → recover fn injected by manager
                       └─ StepRecoveryAgent.recover(page, failedStep, nextStep, reason, shouldStop)
                              └─ analyzePage → askAgentWhatToDo → executeAgentAction   (≤5 actions)
                              └─ success = nextStep target resolves  →  engine continues at next step
                              └─ failure = budget/exhausted/declined →  engine falls back to pause
```

### Decoupling principle

`RecordedReplayEngine` must keep **zero** dependency on the AI client. Recovery is
injected as an **optional** constructor callback. With no callback the engine
behaves exactly as today, so all existing engine tests remain valid.

---

## Components

### 1. `StepRecoveryAgent` — `src/automation/step-recovery.ts` (new)

Single responsibility: get one stuck step's intent accomplished on the live page.

```ts
interface RecoveryResult {
  recovered: boolean
  log: string[]
  advanceBy?: number   // steps to advance on success (default 1; 2 = skip the
                       // already-performed next step — see M4)
}

class StepRecoveryAgent {
  constructor(/* no Playwright page held; page passed per call */)
  async recover(
    page: Page,
    failedStep: RecordedStep,
    nextStep: RecordedStep | null,
    reason: string,
    shouldStop: () => boolean,
  ): Promise<RecoveryResult>
}
```

Internals:

- **Decline gates (run first, no AI calls):** return `{ recovered:false }` when
  `failedStep.sensitive` (M1) or `isLikelyDestructive(failedStep)` (M2), or when
  `describeStepIntent` returns `null`.
- **`describeStepIntent(step): string | null`** (pure, exported for tests) — builds an
  NL micro-goal from the step:
  - `click` → `Click the element labeled "<label>"` (label from quoted description) or
    `Click the <tagName> element that was at the recorded position`.
  - `type` → `Type "<value>" into the <field-desc> field` — **value omitted when
    `step.sensitive` or the value looks secret** (M1).
  - `select` → `Select the option "<value>"`.
  - Non-resolvable types (`scroll`, `keypress`, `navigate`, `hover`, `extract`) →
    returns `null` → `recover` immediately returns `{ recovered:false }` (declined).
- **Bounded loop** `MAX_RECOVERY_ACTIONS = 5`:
  1. `if (shouldStop()) return { recovered:false }`
  2. `if (await onRails(page, nextStep)) return { recovered:true }`  (page may already be fine)
  3. `analyzed = await analyzePage(page)`
  4. `{ action, history } = await askAgentWhatToDo(goal, analyzed…, history, lastOutcome)`
  5. `if (action.isDone) return { recovered: await onRails(page, nextStep) }`
  6. `lastOutcome = await executeAgentAction(page, action, analyzed.elementMap)`
  - light duplicate-action guard (same as `AgentManager` loop detection) to avoid
    burning the budget repeating one failing action.
- **`onRails(page, nextStep): Promise<boolean>`** — the success criterion:
  - `nextStep` present → resolve its `selector` (and label fallback) and return
    `count() > 0` (reuse the engine's resolve logic, extracted as shared helper).
  - `nextStep` null (failed step was last) → re-verify the failed step (re-resolve
    its own target + `verifyStep` where applicable) or accept Claude's `isDone`.
- Every meaningful event is pushed to `log` (`[auto-heal] goal: …`, each action +
  outcome, final verdict) for surfacing through the status channel.

### 2. Shared action executor — `page-analyzer.ts` (refactor)

Extract `AgentManager.executeAgentAction` (`agent-manager.ts:467`) into an exported
`executeAgentAction(page, action, elementMap): Promise<string>` in `page-analyzer.ts`
(co-located with `actOnElement`). `AgentManager` calls the extracted function.
Behavior-preserving move; removes duplication between the agent and the recovery loop.

### 3. Shared step resolver — `recorded-replay.ts` / small helper

`RecordedReplayEngine.resolveLocator` (`recorded-replay.ts:133`) holds the
selector→role→text resolution. Extract the core to a reusable
`resolveStepLocator(page, step): Promise<Locator | null>` (module function or static)
so `onRails` can check next-step resolvability with identical logic.

### 4. `RecordedReplayEngine` — `recorded-replay.ts` (modify)

- **Constructor** gains optional third arg:
  ```ts
  type RecoverFn = (
    page: Page, failedStep: RecordedStep, nextStep: RecordedStep | null,
    reason: string, shouldStop: () => boolean,
  ) => Promise<{ recovered: boolean; log: string[] }>

  constructor(getPage, onStatus, recover?: RecoverFn)
  ```
- **Watchdog** in `attemptStep`: wrap `this.act(...)` in `Promise.race` against a
  `STEP_WATCHDOG_MS` (15 000) timeout that rejects → counted as an attempt failure.
- **Failure point** (`recorded-replay.ts:71-77`): when `attemptStep` returns
  `!ok`, before pausing:
  ```ts
  if (this.recover && !this.stopped) {
    this.emit('recovering', i, steps, iteration, res.reason)
    const r = await this.recover(page, step, steps[i+1] ?? null, res.reason!, () => this.stopped)
    r.log.forEach(line => this.emit('recovering', i, steps, iteration, line))
    if (r.recovered) { done = true; break }   // page on-rails → continue at next step
  }
  // recovery off / declined / failed → existing pause behavior
  this.paused = true
  this.emit('paused-on-step', i, steps, iteration, `Auto-heal failed: ${res.reason}`)
  await this.waitIfPaused()
  ```
  On recovery success the engine does **not** re-run the stuck step; it advances to
  step `i+1`, which replays deterministically.

### 5. `recorded-types.ts` — status union (modify)

Add `'recovering'` to `ReplayStatusEvent['status']`.

### 6. `RecordedAutomationManager` — `recorded-automation-manager.ts` (modify)

Build the `RecoverFn` (constructs/uses a `StepRecoveryAgent`) and pass it as the
engine's third arg. If no API key is configured the recover fn returns
`{ recovered:false }` immediately (clean no-op → pause). Recovery `log` lines and the
`recovering` status flow through the existing `broadcast` → `pushReplayStatus` SSE.

### 7. `app.ts` — wiring (modify)

`new RecordedAutomationManager(getPage, broadcast)` gains the recovery dependency.
Keep it injected (manager builds the agent) so `app.ts` change is minimal.

### 8. Extension UI — `extension/sidepanel.js` (modify)

- Render the new `recovering` status: `🤖 Claude is fixing step N/M…` plus the latest
  recovery log line as sub-text.
- On recovery success the next `running` status restores the normal progress line.
- On failure the existing paused line renders with the `Auto-heal failed: …` reason.
- `extension/background.js` status polling already forwards arbitrary statuses;
  confirm `recovering` passes through to the panel without a code change (add the
  case only if the poller filters statuses).

---

## Data flow

1. Engine replays steps deterministically.
2. Step `i` fails 3 retries (or watchdog timeout) → `{ ok:false, reason }`.
3. Engine emits `recovering`, calls `recover(page, step_i, step_{i+1}, reason, shouldStop)`.
4. `StepRecoveryAgent` builds intent, runs ≤5 `analyzePage → askAgentWhatToDo →
   executeAgentAction` cycles, checking `onRails(step_{i+1})` each cycle.
5. **Recovered** → engine advances to step `i+1`, deterministic replay resumes.
6. **Not recovered** (declined / budget exhausted / stop) → engine pauses on step `i`
   with `Auto-heal failed: <reason>`; user Resumes or Stops as today.

---

## Error handling & safety

- **No API key / AI error** → recover fn returns `{ recovered:false }` → pause. Auto-heal
  never blocks a run that can't reach the model.
- **Stop during recovery** → `shouldStop()` checked between actions; engine `stop()`
  breaks the recovery loop promptly.
- **Budget bound** → `MAX_RECOVERY_ACTIONS = 5` caps cost/latency per stuck step.
- **Duplicate-action guard** → avoids spending the budget repeating one failing action.
- **Watchdog** → `STEP_WATCHDOG_MS = 15000` prevents a hung act from stalling forever.
- **Cost note (accepted):** each stuck step may spend up to ~5 Claude vision calls
  before pausing. Only triggers on genuine failures; auto-heal was the explicit choice.

---

## Testing (London-school / mock-first, per CLAUDE.md)

- **`describeStepIntent`** — pure-function tests per step type, incl. `null` for
  non-resolvable types.
- **`StepRecoveryAgent.recover`** — mock `analyzePage` / `askAgentWhatToDo` /
  `executeAgentAction` / `onRails`:
  - succeeds when `nextStep` becomes resolvable;
  - returns false at budget exhaustion;
  - declines (false, no AI calls) for non-resolvable step types;
  - aborts promptly when `shouldStop()` flips true.
- **`RecordedReplayEngine`** with injected fake `recover`:
  - `recovered:true` → loop advances to next step, **no** `paused-on-step` emitted,
    `recovering` emitted;
  - `recovered:false` → `paused-on-step` still fires with `Auto-heal failed:` reason;
  - no `recover` provided → behaves exactly as today (regression guard).
  - watchdog: an act that never resolves yields an attempt failure within
    `STEP_WATCHDOG_MS`.
- **`executeAgentAction` extraction** — existing agent behavior unchanged (move/export
  is behavior-preserving; covered by current agent tests if present, else add a focused
  unit test for the extracted function).

---

## Constants

| Name | Value | Location |
|------|-------|----------|
| `STEP_RETRIES` | 3 (existing) | `recorded-replay.ts` |
| `STEP_WATCHDOG_MS` | 15000 | `recorded-replay.ts` |
| `MAX_RECOVERY_ACTIONS` | 5 | `step-recovery.ts` |
| `MAX_RECOVERY_MS` | 30000 | `step-recovery.ts` (M5) |
| `MAX_AUTOHEAL_PER_STEP` | 3 | `recorded-replay.ts` (M5 loop breaker) |

---

## Files touched

| File | Change |
|------|--------|
| `src/automation/step-recovery.ts` | **new** — `StepRecoveryAgent`, `describeStepIntent` |
| `src/automation/recorded-replay.ts` | watchdog, optional `recover` arg, failure-point hook, extract `resolveStepLocator` |
| `src/automation/recorded-types.ts` | add `'recovering'` status |
| `src/automation/recorded-automation-manager.ts` | build + inject `RecoverFn` |
| `src/browser/page-analyzer.ts` | export extracted `executeAgentAction` |
| `src/agents/agent-manager.ts` | call extracted `executeAgentAction` |
| `src/app.ts` | minimal wiring |
| `extension/sidepanel.js` | render `recovering` status |
| `extension/background.js` | confirm `recovering` passes through (likely no change) |
