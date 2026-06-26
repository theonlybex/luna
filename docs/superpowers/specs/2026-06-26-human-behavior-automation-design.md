# Human-Behavior Automation + Step Verification — Design

**Date:** 2026-06-26
**Status:** Approved, implementing
**Scope:** Replay recorded-click automations with human-like, trusted input in
a separate browser instance, verifying each step executed before continuing.

---

## Goals

1. **Human behaviour** — replay recorded steps with realistic (fast but
   non-robotic) motion and timing so sites don't flag/ban the automation.
2. **Step verification** — between steps, confirm the previous step actually
   took effect before moving on.
3. **Separate instance, no banner** — automation runs in a browser the user is
   not actively working in, with no "being debugged"/"automated software" bar.

## Key decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Input engine | **Playwright native input** (CDP `Input.*`, `isTrusted:true`, no `chrome.debugger`) on the Node/Playwright side |
| 2 | Verification rigor | **Deterministic checks + readiness waits** (no AI in the hot path) |
| 3 | On step failure | **Pause and wait for user** (Resume / Stop) |
| 4 | Integration | **Bridge** — extension records, POSTs steps to Node, Node replays |
| 5 | Build target | **Playwright/Electron side (`src/`)** — only path delivering separate instance + no banner |

## Why the Playwright side (not the extension)

A Chrome extension is sandboxed to its own profile; `chrome.debugger` can only
attach to the user's own tabs and always shows the debugger banner. The Electron
app already launches its **own** Chromium via
`chromium.launchPersistentContext('.playwright-data', { headless:false, ... })`
(`src/browser/playwright-session.ts:77`) with the Luna extension loaded into it.
That instance is separate from the user's Chrome, shows **no** infobar, keeps
persistent logins, and Playwright's `mouse.*`/`keyboard.*` produce genuinely
trusted events. Readiness/occlusion checks come free via Playwright locator
actionability.

---

## Architecture & data flow

```
content.js (record) ──► background.js (store recorded steps)
                             │  on Play: POST /api/replayRecorded { steps, loop }
                             ▼
                    Node HTTP server (playwright-session.ts)
                             ▼
              RecordedReplayEngine (new, src/automation/)
                 resolve → act → verify  per step, in the existing
                 Playwright Chromium  (no banner, isTrusted input)
                             │  status / paused-on-step / failed / done
                             ▼
                    SSE ──► side panel (Resume / Stop)
```

Per-step cycle: **resolve (locator) → snapshot fingerprint → act (human motion)
→ verify → (retry · pause)**.

---

## New modules (`src/automation/`)

### `human-motion.ts` — pure, no Playwright dep, unit-testable
- `bezierPath(from, to)` → intermediate points along a cubic Bézier with slight
  overshoot-and-correct near the target.
- `thinkTime(recordedGapMs)` → pre-step delay seeded from the real recorded
  timestamp gap, log-normal jitter, clamped min/max.
- `keystrokeDelay()` → per-character delay with jitter + occasional hesitation.

### `step-verifier.ts` — post-condition checks, takes a Playwright `Page`
Returns `{ ok, reason }`. One function per condition:

| Step | Pass condition (within timeout) |
|------|--------------------------------|
| `type` | `locator.inputValue()` === typed text (post-interpolation) |
| `select` | `locator.inputValue()` === chosen value |
| `scroll` | `window.scrollY` within tolerance of target |
| `click` / `keypress(Enter)` | page-change signal vs pre-action fingerprint: URL changed OR navigation committed OR DOM mutated OR `activeElement` changed. Lenient pass only if the click provably landed and no signal is expected |
| `hover` | target still under the cursor point (best-effort) |
| `extract` | element found, value captured |

Pre-action readiness (visible/stable/enabled/not occluded) = Playwright locator
actionability; not re-implemented.

### `recorded-replay.ts` — `RecordedReplayEngine` class (owns one run)
- `run(steps, { loop })` — `do…while` loop (loop-until-stopped, same semantics as
  today). Per step: resolve locator (selector first, label-match fallback like
  `content.js findElement`) → snapshot fingerprint → act via human-motion →
  verify, with **N retries** (default 3, backoff).
- `pause()` / `resume()` / `stop()` — flags polled between steps (mirrors
  `AgentManager` agent pause).
- Emits status via callback: `running`, `paused-on-step`, `failed`, `done`.
- Depends on `human-motion`, `step-verifier`, live `Page`. No HTTP/extension
  knowledge.

### `recorded-automation-manager.ts` — thin bridge engine↔server
Holds the active engine, exposes start/pause/resume/stop, pushes status to SSE.
Analogous to `AgentManager` but for recorded automations.

---

## Step → Playwright action mapping

| Step | Action |
|------|--------|
| `click` | locate → `boundingBox()` → `mouse.move` (bezier) → `mouse.down/up` |
| `type` | focus (click) → per-char `keyboard.press` with jitter |
| `select` | `locator.selectOption(value)` |
| `hover` | `mouse.move` to element along path |
| `keypress` | `keyboard.press(key)` |
| `scroll` | `mouse.wheel(0, deltaY)` in increments |
| `navigate` | `page.goto(url)` |
| `extract` | `locator.inputValue()` / `textContent()` |

## Failure handling & panel UX

- N retries per step (full resolve→act→verify each attempt, backoff).
- On exhausted retries → state `paused-on-step`, loop stops cleanly, SSE pushes
  step index + description + failure reason.
- Panel shows paused/failed step with **Resume** (re-attempt from that step) and
  **Stop** (end run). Mirrors existing agent pause/resume UI.
- `Stop` aborts the `do…while` at any time.

---

## Edits to existing files

- `src/browser/playwright-session.ts` — add routes `/api/replayRecorded`,
  `/api/pauseAutomation`, `/api/resumeAutomation`; add handlers to the
  `LunaHandlers` interface; broadcast replay status over the existing SSE channel.
- `src/app.ts` — instantiate `RecordedAutomationManager`, give it the active
  `Page` getter; wire the new handlers.
- `extension/background.js` — on Play, when the Node server is reachable, POST
  the recorded steps to `/api/replayRecorded` instead of in-extension playback;
  reflect `paused`/`failed` status; send pause/resume/stop.
- `extension/sidepanel.js` — render `paused-on-step`/`failed` state with Resume
  / Stop controls.

## Known limitations (out of scope)

- Elements inside cross-origin **iframes** (coordinates/locators won't resolve).
- Native `<select>` OS dropdowns — handled by `selectOption`, not pointer motion.

## Testing

- `human-motion.ts` is pure → unit-testable in isolation (bezier point count &
  monotonic progress, thinkTime/keystrokeDelay bounds).
- `step-verifier.ts` / engine → manual verification against a live page in the
  Luna Chromium (no test runner currently configured in the repo).
