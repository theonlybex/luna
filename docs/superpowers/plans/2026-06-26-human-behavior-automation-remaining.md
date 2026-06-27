# Plan — Human-Behavior Automation: What's Left

**Date:** 2026-06-26
**Spec:** `docs/superpowers/specs/2026-06-26-human-behavior-automation-design.md`
**Status of code:** Code-complete. Engine proven against real Chromium
(smoke test). Bridge + panel wired but not yet run live.

---

## Done (for reference)

- [x] `human-motion.ts` — bezier paths, recorded-gap think-time, keystroke jitter
- [x] `step-verifier.ts` — value read-back + page-change fingerprint
- [x] `recorded-replay.ts` — resolve→act→verify, retries, pause-on-failure, loop
- [x] `recorded-automation-manager.ts` — engine↔server bridge
- [x] Node wiring — `/api/replayRecorded|pauseRecorded|resumeRecorded|stopRecorded`,
      `GET /api/replayStatus`, SSE `replayStatus`, active-page getter
- [x] `extension/background.js` — server-aware Play, status polling, pause/resume/stop routing
- [x] `extension/sidepanel.js` — progress / paused / failed line + Resume button
- [x] Engine verified end-to-end vs real Chromium (trusted click, type/select verify, pause-on-fail)

---

## Remaining

### 1. Live end-to-end run (the real verification) — HIGH
- [ ] `npm run electron:dev`, record a short automation (e.g. search box: type + Enter + click a result)
- [ ] Hit Play; confirm replay runs in the Playwright Chromium with human-like motion
- [ ] Confirm panel shows live progress (`Running step N/M`)
- [ ] Confirm `type`/`select` verification passes on a normal run
- [ ] Force a failure (record a step, then change the page so the target is gone) →
      confirm `paused-on-step` + reason shows, Resume re-attempts, Stop ends
- [ ] Confirm loop-until-stopped works with the loop checkbox on

### 2. Bridge robustness — MEDIUM
- [x] Confirm `lunaServerReachable()` correctly detects server up/down (fallback to
      in-extension playback when the server isn't running)
- [x] Confirm status poll stops cleanly on done/stopped (no leaked interval)
- [x] Confirm `getActivePage()` targets the tab the user is actually on at Play time
- [x] Decide behavior when the recorded automation spans multiple tabs/navigations

### 3. Optional: manual pause button — LOW
- [x] Add a Pause button to the automation detail view (handler `pauseAutomation`
      already exists in background.js; only the UI control is missing)
- [x] Wire Resume to also cover manual pause (already routes `resumeAutomation`)

### 4. Anti-bot reality check — MEDIUM (do after #1)
- [ ] Test replay against a real protected site (Cloudflare Turnstile / DataDome demo)
- [ ] Tune `human-motion` constants (think-time spread, mouse step delays, keystroke
      cadence) based on what passes
- [ ] Consider randomizing viewport/landing more if flagged

### 5. Known out-of-scope (revisit only if needed)
- Cross-origin iframes (coordinates/locators won't resolve)
- Native `<select>` OS dropdowns (handled via `selectOption`, not pointer motion)

---

## Quick resume tomorrow
1. `cd Luna && npm run electron:dev`
2. Record → Play → watch the panel + the Playwright window
3. Work top-down through section 1 checkboxes
