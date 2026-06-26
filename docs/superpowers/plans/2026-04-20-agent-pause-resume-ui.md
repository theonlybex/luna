# Agent Pause/Resume + Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stop and pause buttons to agent panels, allow users to inject corrections while paused, and redesign the agent panel to be cleaner and simpler.

**Architecture:** Pause is implemented as a sleep-poll loop in `runAgentLoop` — when paused, the loop checks every 500 ms until resumed. Corrections are queued in a `Map<agentId, string>` and injected into conversation history on resume. The extension panel gets a fixed action bar at the bottom that shows context-sensitive controls (Stop/Pause when running; correction textarea + Resume/Stop when paused; nothing when done).

**Tech Stack:** TypeScript, Node.js HTTP, Server-Sent Events, Vanilla JS extension

---

## Task 1: Backend — Pause/Resume in AgentManager

**Files:**
- Modify: `src/agents/agent-manager.ts`

### What to implement

Add two private state structures and two public methods. In `runAgentLoop`, add a pause-poll block at the top of the `while(true)` loop that suspends execution until resumed, and injects any queued correction into history.

- [ ] **Step 1: Read the file**

```bash
# Confirm line count and locate class fields
head -35 src/agents/agent-manager.ts
```

- [ ] **Step 2: Add private state fields**

In the `AgentManager` class body, after the existing `private automationSchedules` field (line ~31), add:

```typescript
private pausedAgents   = new Set<string>()
private correctionQueue = new Map<string, string>()
```

- [ ] **Step 3: Add `pauseAgent` method**

After `stopAgent` method (after line ~45), add:

```typescript
pauseAgent(agentId: string): void {
    const agent = this.items.find(i => i.id === agentId && i.type === 'agent') as Agent | undefined
    if (!agent || agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped') return
    this.pausedAgents.add(agentId)
    agent.status = 'waiting'
    agent.log.push('Paused by user')
    this.broadcastUpdate()
}
```

- [ ] **Step 4: Add `resumeAgent` method**

Directly after `pauseAgent`:

```typescript
resumeAgent(agentId: string, correction?: string): void {
    const agent = this.items.find(i => i.id === agentId && i.type === 'agent') as Agent | undefined
    if (!agent) return
    if (correction?.trim()) {
        this.correctionQueue.set(agentId, correction.trim())
    }
    this.pausedAgents.delete(agentId)
    agent.status = 'running'
    agent.log.push('Resumed')
    this.broadcastUpdate()
}
```

- [ ] **Step 5: Add pause-poll block inside `runAgentLoop`**

In `runAgentLoop`, at the very top of the `while (true)` loop body — **before** the ceiling guard — add:

```typescript
// ── Pause poll ─────────────────────────────────────────────────────────
while (this.pausedAgents.has(agent.id)) {
    await this.sleep(500)
}
// Inject correction if user provided one while paused
const correction = this.correctionQueue.get(agent.id)
if (correction) {
    this.correctionQueue.delete(agent.id)
    const history = this.agentHistories.get(agent.id) ?? []
    agent.log.push(`[correction] User: ${correction}`)
    this.broadcastUpdate()
    this.agentHistories.set(agent.id, [
        ...history,
        { role: 'user',      content: `User correction/context: ${correction}` },
        { role: 'assistant', content: 'Understood. Incorporating this into my next action.' }
    ])
}
```

The pause-poll block should be the **first** thing inside `while (true) {`, before `if (step >= ceiling)`.

- [ ] **Step 6: Clean up pause state on agent exit**

In all early-return paths in `runAgentLoop` (ceiling guard, cancellation, page error, auth error, unknown error, done signal), add cleanup after `this.agentHistories.delete(agent.id)`:

```typescript
this.pausedAgents.delete(agent.id)
this.correctionQueue.delete(agent.id)
```

There are 6 return paths — add to each one. Search for `this.agentHistories.delete(agent.id)` and add the two lines after each occurrence.

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/agents/agent-manager.ts
git commit -m "feat: add pause/resume with correction injection to AgentManager"
```

---

## Task 2: API Routes — `/api/pauseAgent` and `/api/resumeAgent`

**Files:**
- Modify: `src/browser/playwright-session.ts`
- Modify: `src/app.ts`

### What to implement

Expose the two new methods via HTTP POST routes and the `LunaHandlers` interface.

- [ ] **Step 1: Add to `LunaHandlers` interface**

In `src/browser/playwright-session.ts`, in the `LunaHandlers` interface (around line 38), add after `stopAgent`:

```typescript
pauseAgent:  (id: string) => void
resumeAgent: (id: string, correction?: string) => void
```

- [ ] **Step 2: Add HTTP routes**

In `startHttpServer`, after the `/api/stopAgent` block (around line 162), add:

```typescript
} else if (req.url === '/api/pauseAgent' && req.method === 'POST') {
    handlers.pauseAgent(data.agentId)
    this.ok(res, { ok: true })
} else if (req.url === '/api/resumeAgent' && req.method === 'POST') {
    handlers.resumeAgent(data.agentId, data.correction)
    this.ok(res, { ok: true })
```

- [ ] **Step 3: Wire handlers in `app.ts`**

In `src/app.ts`, add `pauseAgent` and `resumeAgent` imports from `./agents/agent-manager` — they're methods on `manager`, not standalone exports, so just wire them in the handlers object passed to `session.launch`.

After `stopAgent: (id: string) => { manager.stopAgent(id) },` add:

```typescript
pauseAgent:  (id: string)                      => { manager.pauseAgent(id) },
resumeAgent: (id: string, correction?: string) => { manager.resumeAgent(id, correction) },
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/browser/playwright-session.ts src/app.ts
git commit -m "feat: expose /api/pauseAgent and /api/resumeAgent HTTP endpoints"
```

---

## Task 3: Extension — Agent Panel Redesign + Controls

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`

### What to implement

**Visual design goals:**
- System log entries (`[tokens]`, `[compact]`, `[stuck]`, `[retry]`, `[correction]`) → rendered as small inline system notes, not full bubbles
- Action log entries (`[navigate]`, `[click]`, etc.) → rendered as clean step cards
- Final answer → distinct "Luna" bubble in accent color
- Agent panel bottom: fixed action bar with Stop + Pause when running; correction textarea + Resume + Stop when paused; empty when done/error/stopped

**New CSS to add in `sidepanel.html` `<style>` block** (after `.step-tag` rules, around line 248):

```css
/* ── Agent action bar ── */
.agent-bar {
  flex-shrink: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-bar-btns {
  display: flex;
  gap: 8px;
}
.agent-bar-btn {
  flex: 1;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--text2);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.agent-bar-btn:hover { color: var(--text); border-color: #666; }
.agent-bar-btn.stop  { border-color: #6b2d2d; color: #f28b82; }
.agent-bar-btn.stop:hover { background: #3c1f1f; border-color: #f28b82; }
.agent-bar-btn.resume { background: var(--accent); border-color: var(--accent); color: #fff; }
.agent-bar-btn.resume:hover { background: #0d55cc; }
.agent-correction {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.4;
  min-height: 56px;
  max-height: 120px;
}
.agent-correction:focus { border-color: var(--accent); }
.agent-correction::placeholder { color: var(--text2); }

/* ── System log notes ── */
.sys-note {
  align-self: center;
  font-size: 10px;
  color: var(--text2);
  padding: 2px 8px;
  background: transparent;
  font-family: monospace;
  opacity: 0.7;
}
```

- [ ] **Step 1: Read both extension files**

Read `extension/sidepanel.html` and `extension/sidepanel.js` fully before editing.

- [ ] **Step 2: Add CSS to `sidepanel.html`**

Inside the `<style>` block, after the `.step-tag { ... }` rule (around line 248), paste the CSS block above.

- [ ] **Step 3: Update `ensureAgentTab` in `sidepanel.js` to include the action bar**

Current `ensureAgentTab` creates a `screenEl` with only a `msgsEl` child. Replace that block so it also creates the action bar:

```javascript
function ensureAgentTab(agent) {
  if (agentRegistry.has(agent.id)) return false

  const label = agent.goal.length > 22 ? agent.goal.slice(0, 22) + '…' : agent.goal

  const tabEl = document.createElement('button')
  tabEl.className   = 'tab-item'
  tabEl.dataset.tab = agent.id
  tabEl.innerHTML   = `<span class="tab-dot pulse" style="background:#9aa0a6"></span>${label}`
  tabEl.addEventListener('click', () => switchTab(agent.id))
  tabBar.appendChild(tabEl)

  const screenEl = document.createElement('div')
  screenEl.className     = 'agent-screen'
  screenEl.style.display = 'none'

  const msgsEl = document.createElement('div')
  msgsEl.className = 'agent-msgs'
  screenEl.appendChild(msgsEl)

  // Action bar
  const barEl = document.createElement('div')
  barEl.className = 'agent-bar'
  barEl.style.display = 'none'

  const correctionTa = document.createElement('textarea')
  correctionTa.className   = 'agent-correction'
  correctionTa.placeholder = 'Add context or correction…'
  correctionTa.style.display = 'none'

  const btnsEl = document.createElement('div')
  btnsEl.className = 'agent-bar-btns'

  const pauseBtn = document.createElement('button')
  pauseBtn.className   = 'agent-bar-btn pause'
  pauseBtn.textContent = 'Pause'

  const stopBtn = document.createElement('button')
  stopBtn.className   = 'agent-bar-btn stop'
  stopBtn.textContent = 'Stop'

  btnsEl.appendChild(pauseBtn)
  btnsEl.appendChild(stopBtn)
  barEl.appendChild(correctionTa)
  barEl.appendChild(btnsEl)
  screenEl.appendChild(barEl)

  document.body.appendChild(screenEl)

  // ── Button handlers ──────────────────────────────────────────────────
  stopBtn.addEventListener('click', () => {
    fetch(`${API}/api/stopAgent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id })
    })
  })

  pauseBtn.addEventListener('click', () => {
    const data = agentRegistry.get(agent.id)
    if (!data) return
    if (data.paused) {
      // Resume
      const correction = correctionTa.value.trim()
      fetch(`${API}/api/resumeAgent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id, correction: correction || undefined })
      })
      correctionTa.value = ''
    } else {
      // Pause
      fetch(`${API}/api/pauseAgent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id })
      })
    }
  })

  agentRegistry.set(agent.id, {
    tabEl, screenEl, msgsEl, barEl, correctionTa, btnsEl, pauseBtn, stopBtn,
    stepsShown: 0, ended: false, paused: false
  })
  return true
}
```

- [ ] **Step 4: Update `renderBar` to handle system notes, paused state, and action bar visibility**

Replace the entire `renderBar` function:

```javascript
const SYS_PREFIXES = ['[tokens]', '[compact]', '[stuck]', '[retry]', '[correction]']

function isSysEntry(entry) {
  return SYS_PREFIXES.some(p => entry.startsWith(p))
}

function renderBar(items) {
  items.filter(i => i.type === 'agent').forEach(agent => {
    const isNew = ensureAgentTab(agent)
    const data  = agentRegistry.get(agent.id)

    const active  = agent.status === 'thinking' || agent.status === 'running'
    const paused  = agent.status === 'waiting'
    const ended   = agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped'
    const color   = STATUS_COLORS[agent.status] || '#9aa0a6'
    const dot     = data.tabEl.querySelector('.tab-dot')

    if (dot) {
      dot.style.background = color
      dot.classList.toggle('pulse', active)
    }

    // ── Action bar visibility ──────────────────────────────────────────
    data.barEl.style.display = ended ? 'none' : 'flex'

    if (paused && !data.paused) {
      // Just became paused
      data.paused = true
      data.pauseBtn.textContent = 'Resume'
      data.pauseBtn.classList.add('resume')
      data.correctionTa.style.display = 'block'
    } else if (!paused && data.paused) {
      // Just resumed
      data.paused = false
      data.pauseBtn.textContent = 'Pause'
      data.pauseBtn.classList.remove('resume')
      data.correctionTa.style.display = 'none'
    }

    // ── New log entries ────────────────────────────────────────────────
    const newSteps = agent.log.slice(data.stepsShown)
    newSteps.forEach((entry, i) => {
      const stepNum = data.stepsShown + i + 1

      if (isSysEntry(entry)) {
        // System note — small, centered, subtle
        const d = document.createElement('div')
        d.className   = 'sys-note'
        d.textContent = entry
        data.msgsEl.appendChild(d)
      } else {
        const { action, reason } = parseStep(entry)
        const d = document.createElement('div')
        d.className = 'msg luna'
        d.innerHTML =
          `<div class="sender">Step ${stepNum}</div>` +
          `<div class="bubble">` +
            (action ? `<span class="step-tag">[${esc(action)}]</span>` : '') +
            esc(reason) +
          `</div>`
        data.msgsEl.appendChild(d)
      }

      data.msgsEl.scrollTop = data.msgsEl.scrollHeight
    })
    data.stepsShown = agent.log.length

    // ── Ended state ────────────────────────────────────────────────────
    if (!data.ended && ended) {
      data.ended = true
      const d = document.createElement('div')
      d.className = 'msg luna'
      if (agent.status === 'done' && agent.finalAnswer) {
        d.innerHTML = `<div class="sender">Luna</div><div class="bubble">${esc(agent.finalAnswer)}</div>`
      } else {
        const label = { done: 'Completed', error: 'Error', stopped: 'Stopped' }
        d.innerHTML = `<div class="sender">Agent</div><div class="bubble" style="color:${color}">${label[agent.status] || agent.status}</div>`
      }
      data.msgsEl.appendChild(d)
      data.msgsEl.scrollTop = data.msgsEl.scrollHeight
    }

    if (isNew) switchTab(agent.id)
  })
}
```

- [ ] **Step 5: Update `agentRegistry` JSDoc comment**

At the top of `sidepanel.js`, update the registry comment from:

```javascript
// agentId → { tabEl, screenEl, msgsEl, stepsShown, ended }
```

to:

```javascript
// agentId → { tabEl, screenEl, msgsEl, barEl, correctionTa, btnsEl, pauseBtn, stopBtn, stepsShown, ended, paused }
```

- [ ] **Step 6: Verify type-check passes (no TS in sidepanel, so just check backend)**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js
git commit -m "feat: stop/pause/correction controls + cleaner agent panel design"
```

---

## Self-Review

**Spec coverage:**
- ✅ Stop button → calls `/api/stopAgent` (existing), shown in action bar
- ✅ Pause button → calls `/api/pauseAgent`, transitions to `waiting` status
- ✅ Resume button → calls `/api/resumeAgent` with optional correction text
- ✅ Correction textarea → shown only when paused, value sent on resume
- ✅ Cleaner panel design → system notes styled differently from action steps
- ✅ Action bar hidden when agent is done/error/stopped

**Placeholder scan:** No TBD or TODO present. All code is complete.

**Type consistency:**
- `pauseAgent(id)` / `resumeAgent(id, correction?)` consistent across AgentManager, LunaHandlers, app.ts, and extension fetch calls
- `data.paused` boolean on registry entries matches `pauseBtn.classList.add('resume')` toggle logic
- `correctionQueue` cleanup added to all 6 return paths in `runAgentLoop`
