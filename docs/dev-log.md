# Dev Log

Reverse-chronological log of notable development work.

---

## 2026-06-26 — Human-behavior automation: hardening + Claude auto-heal design

**Branch:** `fix/human-behavior-automation-hardening`

### Audited the recorded-click automation + Claude-help feature end-to-end
Reviewed the recorder (`content.js`), storage/bridge (`background.js`), both replay
engines (server `RecordedReplayEngine` + in-extension fallback), the HTTP/SSE bridge,
and the auto-heal design. Found and fixed a series of holes.

### Replay-robustness fixes (H1–H9)
- **H1** — label fallback now accepts only a uniquely-resolving target (role-exact →
  role → text-exact → text); ambiguity fails instead of silently clicking the wrong node.
- **H2** — replay is pinned to the run's own page set (start page + popups), isolated
  from the globally-mutable `activePage` a concurrent agent/tab-switch could swap.
- **H4** — `navigate` got a 20s timeout (was unbounded → could hang forever).
- **H5** — recorded `x/y` fallback validated against the live viewport before use.
- **H6** — `this.stopped` checked inside mouse-move / keystroke / scroll loops (Stop
  was ignored mid-action).
- **H7** — `thinkTime` honors long recorded gaps (clamped to max) instead of dropping
  >10s pauses to a 500ms default.
- **H8** — terminal replay status resets the cached `/api/replayStatus` to `idle`
  (no stale `done` on panel reload).
- **H9** — `clearField` handles contenteditable / React-controlled inputs (select-all
  + delete fallback).
- **H3** — in-extension fallback (server offline) now shows a visible "⚠ Basic playback"
  banner + per-step progress instead of silently degrading.

### Capture-side security & correctness fixes
- **S1** — sensitive fields (password/CC/OTP/PIN, via type/autocomplete/name heuristics)
  are no longer stored; value blanked at capture, step flagged `sensitive`. Server replay
  **pauses for manual entry** on sensitive steps; fallback never auto-fills them.
- **R1** — `flushPendingInputs()` emits debounced `type` steps before a click/keypress/
  change, fixing the `[Enter, type]` reordering bug on search boxes.
- **R2** — contenteditable typing is now recorded, replayed, and verified (textContent).
- **R4** — `getSelector` prefers durable anchors (`data-testid` → `id` → `[name]` →
  `[aria-label]`), each accepted only when uniquely resolving, before the nth-of-type chain.
- **E1** — unresolved `extract` now throws (surfaces the failure) instead of silently
  interpolating `""` downstream.

### Claude auto-heal — design + hardening (spec only, not yet built)
Wrote `docs/superpowers/specs/2026-06-26-claude-auto-heal-stuck-steps-design.md`:
auto-heal that lets Claude take over a stuck step, accomplish its intent, and hand
control back to deterministic replay. After a second-pass design review, added required
mitigations: M1 secrets never reach the model, M2 don't auto-heal irreversible steps,
M3 semantic success signal (not just the next stale selector), M4 overshoot/double-exec
guard, M5 wall-clock budget + loop circuit-breaker, M6 human-motion continuity.

### Verification
`tsc --noEmit` clean; `node --check` clean on all modified extension JS. No project test
runner exists; live end-to-end run (remaining-work plan §1) is still outstanding.
