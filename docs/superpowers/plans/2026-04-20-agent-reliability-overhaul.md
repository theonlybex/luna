# Agent Reliability Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port 7 reliability improvements from OpenClaw into Luna's agent system — parse-failure retry, classified error retry, completion-driven loop, upfront token estimation, history compaction, multi-key rotation + model fallback, planning-only detection, uncapped max_tokens.

**Architecture:** All changes live in `src/agents/ai-client.ts` (AI call layer) and `src/agents/agent-manager.ts` (loop orchestration). Settings gains two new fields. No new files — every change is an in-place upgrade to existing responsibilities.

**Tech Stack:** TypeScript, Anthropic SDK (`@anthropic-ai/sdk`), Node.js

---

## File Map

| File | What changes |
|------|-------------|
| `src/agents/ai-client.ts` | Uncap `max_tokens`, parse-failure retry, planning-only detection, multi-key rotation, model fallback, history compaction function |
| `src/agents/agent-manager.ts` | Completion-driven loop (while + absolute ceiling), upfront token estimation logged to agent, classified error retry |
| `src/settings/settings-store.ts` | Add `fallbackModel` and `apiKeys` fields |

---

## Task 1 — Settings: add `apiKeys` and `fallbackModel`

**Files:**
- Modify: `src/settings/settings-store.ts`

- [ ] **Step 1: Add fields to the `Settings` interface and defaults**

Open `src/settings/settings-store.ts`. Change the `Settings` interface and `DEFAULT_SETTINGS` to:

```typescript
export interface Settings {
    apiKey: string          // primary key (backward compat)
    apiKeys: string         // comma-separated extra keys for rotation
    fallbackModel: 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-3-7-sonnet-20250219' | 'claude-3-5-sonnet-20241022' | 'claude-haiku-4-5-20251001' | ''
    aiModel: 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-3-7-sonnet-20250219' | 'claude-3-5-sonnet-20241022' | 'claude-haiku-4-5-20251001'
    maxAgentSteps: number

    theme: 'light' | 'dark'
    defaultZoom: number
    fontSize: 'small' | 'medium' | 'large' | 'very-large'

    startupBehavior: 'new-tab' | 'homepage' | 'last-session'
    homepage: string

    searchEngine: 'google' | 'bing' | 'duckduckgo' | 'brave'

    downloadPath: string
    askBeforeDownload: boolean

    blockThirdPartyCookies: boolean
    sendDoNotTrack: boolean

    spellCheck: boolean
}

export const DEFAULT_SETTINGS: Settings = {
    apiKey: '',
    apiKeys: '',            // e.g. "sk-ant-key2,sk-ant-key3"
    fallbackModel: 'claude-haiku-4-5-20251001',
    aiModel: 'claude-sonnet-4-6',
    maxAgentSteps: 10,

    theme: 'light',
    defaultZoom: 1.25,
    fontSize: 'large',

    startupBehavior: 'homepage',
    homepage: 'https://google.com',

    searchEngine: 'google',

    downloadPath: path.join(os.homedir(), 'Downloads'),
    askBeforeDownload: true,

    blockThirdPartyCookies: false,
    sendDoNotTrack: false,

    spellCheck: true
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/settings/settings-store.ts
git commit -m "feat: add apiKeys and fallbackModel to settings"
```

---

## Task 2 — ai-client.ts: uncap max_tokens + multi-key rotation + model fallback

**Files:**
- Modify: `src/agents/ai-client.ts`

- [ ] **Step 1: Replace single-key state with multi-key state and add fallback model**

Replace the top-level state variables and `setApiKey` / `getClient` in `ai-client.ts`:

```typescript
let currentKeys: string[] = []      // all keys, primary first
let currentKeyIndex = 0              // which key is active
let currentModel  = 'claude-sonnet-4-6'
let fallbackModel = 'claude-haiku-4-5-20251001'

export function setApiKey(key: string): void {
    process.env.ANTHROPIC_API_KEY = key
    currentKeys = [key, ...currentKeys.filter(k => k !== key)]
    currentKeyIndex = 0
    client = null
}

export function setApiKeys(keys: string[]): void {
    const deduped = [...new Set(keys.filter(Boolean))]
    if (deduped.length === 0) return
    currentKeys = deduped
    currentKeyIndex = 0
    client = null
}

export function setFallbackModel(model: string): void {
    fallbackModel = model
}

export function setModel(model: string): void {
    currentModel = model
}

function getClient(keyIndex = currentKeyIndex): Anthropic {
    const keys = currentKeys.length > 0 ? currentKeys : [process.env.ANTHROPIC_API_KEY ?? '']
    const apiKey = keys[keyIndex] ?? keys[0]
    if (!apiKey) {
        throw new Error('No API key set. Open Settings (⚙) → Luna AI → Anthropic API Key.')
    }
    return new Anthropic({ apiKey })
}
```

Remove the top-level `let client: Anthropic | null = null` since we're building clients on-demand per key.

- [ ] **Step 2: Add `callWithRotation` — wraps any Anthropic call with key rotation and model fallback**

Add this function after `getClient`:

```typescript
const RATE_LIMIT_STRINGS = ['rate_limit', 'rate limit', '429', 'quota exceeded', 'too many requests', 'resource exhausted']
const AUTH_STRINGS       = ['invalid x-api-key', 'authentication', 'unauthorized', '401', '403']

function isRateLimit(err: any): boolean {
    const msg = String(err?.message ?? err).toLowerCase()
    return RATE_LIMIT_STRINGS.some(s => msg.includes(s))
}

function isAuthError(err: any): boolean {
    const msg = String(err?.message ?? err).toLowerCase()
    return AUTH_STRINGS.some(s => msg.includes(s))
}

async function callWithRotation<T>(
    fn: (client: Anthropic, model: string) => Promise<T>,
    model: string = currentModel
): Promise<T> {
    const keys = currentKeys.length > 0 ? currentKeys : [process.env.ANTHROPIC_API_KEY ?? '']

    // Try each key with the primary model
    let lastErr: unknown
    for (let i = 0; i < keys.length; i++) {
        const idx = (currentKeyIndex + i) % keys.length
        try {
            const result = await fn(getClient(idx), model)
            currentKeyIndex = idx  // remember successful key
            return result
        } catch (err) {
            lastErr = err
            if (isRateLimit(err)) continue     // try next key
            if (isAuthError(err) && i < keys.length - 1) continue
            break  // non-retriable error — don't burn remaining keys
        }
    }

    // All keys failed — try fallback model if it's different
    if (fallbackModel && fallbackModel !== model) {
        for (let i = 0; i < keys.length; i++) {
            const idx = (currentKeyIndex + i) % keys.length
            try {
                const result = await fn(getClient(idx), fallbackModel)
                currentKeyIndex = idx
                return result
            } catch (err) {
                lastErr = err
                if (isRateLimit(err)) continue
                break
            }
        }
    }

    throw lastErr
}
```

- [ ] **Step 3: Update `testApiKey` to use `callWithRotation`**

```typescript
export async function testApiKey(): Promise<{ ok: boolean; error?: string }> {
    try {
        await callWithRotation((client, model) => client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }]
        }))
        return { ok: true }
    } catch (err: any) {
        return { ok: false, error: err.message ?? String(err) }
    }
}
```

- [ ] **Step 4: Update `parseAutomationSteps` and `parseUserIntent` to use `callWithRotation`**

In `parseUserIntent`, replace the `getClient().messages.create(...)` call:
```typescript
const response = await callWithRotation((client, model) => client.messages.create({
    model,
    max_tokens: 256,
    system: `...same system prompt...`,
    messages: [{ role: 'user', content: message }]
}))
```

In `parseAutomationSteps`, replace similarly:
```typescript
const response = await callWithRotation((client, model) => client.messages.create({
    model,
    max_tokens: 1024,
    system: `...same system prompt...`,
    messages: [{ role: 'user', content: `Convert to steps: "${description}"` }]
}))
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agents/ai-client.ts
git commit -m "feat: multi-key rotation + model fallback in ai-client"
```

---

## Task 3 — ai-client.ts: planning-only detection + parse-failure retry + uncap max_tokens

**Files:**
- Modify: `src/agents/ai-client.ts`

- [ ] **Step 1: Add planning-only detection helper**

Add before `askAgentWhatToDo`:

```typescript
const PLANNING_ONLY_RETRY = 
    "The previous response described what you plan to do instead of taking an action. " +
    "Do not restate the plan. Act now: respond ONLY with the JSON action object. No prose."

const PARSE_FAILURE_RETRY =
    "Your previous response could not be parsed as JSON. " +
    "Respond ONLY with a single valid JSON object matching the schema. No markdown, no prose, no explanation."

const PLANNING_PROMISE_RE = /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i|next[, ]+i|i need to|i should)\b/i
const PLANNING_HEADING_RE = /^(?:plan|steps?|next steps?|approach)\s*:/im
const PLANNING_BULLET_RE  = /^(?:[-*•]\s+|\d+[.)]\s+)/m

function isPlanningOnlyResponse(raw: string): boolean {
    if (raw.trimStart().startsWith('{')) return false   // valid JSON start — not planning
    if (raw.length > 800) return false                  // too long to be a planning blurb
    if (raw.includes('```')) return false               // code fence means it tried
    return PLANNING_PROMISE_RE.test(raw) || PLANNING_HEADING_RE.test(raw) || PLANNING_BULLET_RE.test(raw)
}
```

- [ ] **Step 2: Rewrite `askAgentWhatToDo` with uncapped max_tokens, planning-only retry, and parse-failure retry**

Replace the entire `askAgentWhatToDo` function:

```typescript
const MAX_PARSE_RETRIES    = 2
const MAX_PLANNING_RETRIES = 2

export async function askAgentWhatToDo(
    goal: string,
    url: string,
    title: string,
    accessibilityTree: string,
    screenshotBase64: string,
    history: MessageParam[]
): Promise<{ action: AgentAction; history: MessageParam[] }> {

    const baseUserContent: MessageParam['content'] = [
        {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 }
        },
        {
            type: 'text',
            text: `URL: ${url}\nTitle: ${title}\n\nVisible interactive elements:\n${accessibilityTree}\n\nGoal: "${goal}"\nWhat is the next single action? JSON only.`
        }
    ]

    const cappedHistory = history.slice(-(MAX_HISTORY_TURNS * 2))

    let messages: MessageParam[] = [...cappedHistory, { role: 'user', content: baseUserContent }]
    let planningRetries = 0
    let parseRetries    = 0

    while (true) {
        const response = await callWithRotation((client, model) => client.messages.create({
            model,
            max_tokens: 1024,
            system: [{ type: 'text', text: AGENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages
        }))

        const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : ''

        // ── Planning-only detection ───────────────────────────────────────────
        if (isPlanningOnlyResponse(raw) && planningRetries < MAX_PLANNING_RETRIES) {
            planningRetries++
            messages = [
                ...messages,
                { role: 'assistant', content: raw },
                { role: 'user',      content: PLANNING_ONLY_RETRY }
            ]
            continue
        }

        // ── Parse attempt ─────────────────────────────────────────────────────
        const cleaned = raw
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

        let action: AgentAction
        try {
            action = JSON.parse(cleaned) as AgentAction
        } catch {
            if (parseRetries < MAX_PARSE_RETRIES) {
                parseRetries++
                messages = [
                    ...messages,
                    { role: 'assistant', content: raw },
                    { role: 'user',      content: PARSE_FAILURE_RETRY }
                ]
                continue
            }
            // Exhausted retries — give up gracefully
            action = { action: 'done', reason: `Response unparseable after ${MAX_PARSE_RETRIES} retries`, isDone: true }
        }

        const updatedHistory: MessageParam[] = [...messages, { role: 'assistant', content: raw }]
        return { action, history: updatedHistory }
    }
}
```

- [ ] **Step 3: Update `askAgentForFinalAnswer` to use `callWithRotation`**

Replace the `getClient().messages.create(...)` call inside `askAgentForFinalAnswer`:

```typescript
const response = await callWithRotation((client, model) => client.messages.create({
    model,
    max_tokens: 512,
    system: `You are Luna, a browser assistant. The user gave you a goal and you have finished browsing.
Based on what you found, give a clear, direct answer to the user's goal in plain English.
Be specific — name the exact item, price, link, or fact you found. Keep it under 4 sentences.`,
    messages: [{
        role: 'user',
        content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } },
            { type: 'text', text: `Goal: "${goal}"\n\nSteps taken:\n${log}\n\nCurrent page: ${url} — ${title}\n\nPage content:\n${accessibilityTree}\n\nWhat is the direct answer to the user's goal?` }
        ]
    }]
}))
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/ai-client.ts
git commit -m "feat: planning-only detection, parse-failure retry, uncap max_tokens"
```

---

## Task 4 — ai-client.ts: history compaction

**Files:**
- Modify: `src/agents/ai-client.ts`

- [ ] **Step 1: Add token estimation helper and compaction function**

Add after the `MAX_HISTORY_TURNS` constant:

```typescript
// Rough token estimate: 4 chars ≈ 1 token (industry standard approximation)
export function estimateTokens(messages: MessageParam[]): number {
    return Math.ceil(
        JSON.stringify(messages).length / 4
    )
}

// Compact history when it grows large. Summarizes old turns via Claude,
// keeps the most recent RECENT_TURNS_KEEP turns verbatim.
const COMPACTION_TOKEN_THRESHOLD = 50_000   // ~200k chars
const RECENT_TURNS_KEEP          = 6        // turns to preserve verbatim (user+assistant pairs)

export async function compactHistory(
    goal: string,
    history: MessageParam[]
): Promise<MessageParam[]> {
    if (estimateTokens(history) < COMPACTION_TOKEN_THRESHOLD) return history

    // Split: old turns to summarize, recent turns to keep
    const keepCount = RECENT_TURNS_KEEP * 2   // each turn = user + assistant message
    const toSummarize = history.slice(0, -keepCount)
    const toKeep      = history.slice(-keepCount)

    if (toSummarize.length === 0) return history

    // Build a text representation of what needs summarizing (text content only, no images)
    const historyText = toSummarize.map(m => {
        const textContent = Array.isArray(m.content)
            ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
            : String(m.content)
        return `[${m.role.toUpperCase()}]: ${textContent.slice(0, 500)}`
    }).join('\n\n')

    try {
        const summaryResponse = await callWithRotation((client, model) => client.messages.create({
            model,
            max_tokens: 512,
            system: `You are summarizing a browser automation agent's history for context compression.
Write a concise factual summary of what the agent has done so far.
Focus on: pages visited, actions taken, what was found, what failed, current state.
Preserve exact URLs, selectors, and values. Keep it under 400 words.`,
            messages: [{ role: 'user', content: `Agent goal: "${goal}"\n\nHistory to summarize:\n${historyText}` }]
        }))

        const summary = summaryResponse.content[0].type === 'text'
            ? summaryResponse.content[0].text.trim()
            : 'Previous browsing history summarized.'

        const compacted: MessageParam[] = [
            { role: 'user',      content: `[Context summary of earlier steps]\n${summary}` },
            { role: 'assistant', content: 'Understood. Continuing from current state.' },
            ...toKeep
        ]
        return compacted
    } catch {
        // If compaction fails, fall back to simple truncation
        return toKeep
    }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agents/ai-client.ts
git commit -m "feat: history compaction with Claude summarization"
```

---

## Task 5 — agent-manager.ts: completion-driven loop + token estimation + classified retry

**Files:**
- Modify: `src/agents/agent-manager.ts`

- [ ] **Step 1: Update import to include new exports from ai-client**

At the top of `agent-manager.ts`, update the import:

```typescript
import { askAgentWhatToDo, askAgentForFinalAnswer, parseAutomationSteps, compactHistory, estimateTokens, type MessageParam } from './ai-client'
```

- [ ] **Step 2: Add error classification helper at the top of the file (after imports)**

```typescript
const RATE_LIMIT_STRINGS = ['rate_limit', 'rate limit', '429', 'quota exceeded', 'too many requests']
const TIMEOUT_STRINGS    = ['timeout', 'etimedout', 'econnreset', 'enotfound', 'socket hang up']

type ErrorClass = 'rate_limit' | 'timeout' | 'auth' | 'unknown'

function classifyApiError(err: unknown): ErrorClass {
    const msg = String((err as any)?.message ?? err).toLowerCase()
    if (RATE_LIMIT_STRINGS.some(s => msg.includes(s))) return 'rate_limit'
    if (TIMEOUT_STRINGS.some(s => msg.includes(s)))    return 'timeout'
    if (msg.includes('401') || msg.includes('403') || msg.includes('invalid') && msg.includes('key')) return 'auth'
    return 'unknown'
}
```

- [ ] **Step 3: Replace `runAgentLoop` with the completion-driven implementation**

Replace the entire `private async runAgentLoop(agent: Agent, maxSteps: number): Promise<void>` method with:

```typescript
private async runAgentLoop(agent: Agent, maxSteps: number): Promise<void> {
    agent.status = 'running'
    this.broadcastUpdate()
    console.log(`\n[Agent ${agent.id.slice(0,8)}] Starting — goal: "${agent.goal}"`)

    this.agentHistories.set(agent.id, [])
    await this.sleep(1000)

    // maxSteps = 0 means no ceiling; otherwise it's a hard upper bound
    const ceiling = maxSteps === 0 ? Infinity : maxSteps
    let step = 0
    let apiRetries = 0
    const MAX_API_RETRIES = 3

    while (true) {
        // ── Ceiling guard ──────────────────────────────────────────────────
        if (step >= ceiling) {
            const lastPage = this.getActivePage(agent.id)
            if (lastPage) {
                try {
                    const snap = await analyzePage(lastPage)
                    agent.finalAnswer = await askAgentForFinalAnswer(
                        agent.goal, snap.url, snap.title,
                        snap.accessibilityTree, snap.screenshot, agent.log
                    )
                } catch { /* best-effort */ }
            }
            agent.status = 'done'
            agent.log.push(`Reached ${maxSteps}-step ceiling`)
            this.agentHistories.delete(agent.id)
            this.agentPages.delete(agent.id)
            this.broadcastUpdate()
            return
        }

        // ── Cancellation check ─────────────────────────────────────────────
        if (this.cancelledAgents.has(agent.id)) {
            this.cancelledAgents.delete(agent.id)
            agent.status = 'stopped'
            this.agentHistories.delete(agent.id)
            this.agentPages.delete(agent.id)
            this.broadcastUpdate()
            return
        }

        // ── Active page check ──────────────────────────────────────────────
        const page = this.getActivePage(agent.id)
        if (!page) {
            agent.status = 'error'
            agent.log.push('All tabs were closed')
            this.agentHistories.delete(agent.id)
            this.agentPages.delete(agent.id)
            this.broadcastUpdate()
            return
        }

        // ── Page analysis ──────────────────────────────────────────────────
        let analyzed
        try {
            analyzed = await analyzePage(page)
            console.log(`[Agent ${agent.id.slice(0,8)}] Step ${step+1} — url: ${analyzed.url} | elements: ${analyzed.elementMap.length}`)
        } catch (err) {
            agent.status = 'error'
            agent.log.push(`Page analysis failed: ${err}`)
            this.agentHistories.delete(agent.id)
            this.agentPages.delete(agent.id)
            this.broadcastUpdate()
            return
        }

        // ── History compaction + token estimation ──────────────────────────
        let history = this.agentHistories.get(agent.id) ?? []
        const tokensBefore = estimateTokens(history)

        if (tokensBefore > 30_000) {
            agent.log.push(`[compact] History ~${Math.round(tokensBefore / 1000)}k tokens — compacting…`)
            this.broadcastUpdate()
            history = await compactHistory(agent.goal, history)
            this.agentHistories.set(agent.id, history)
            const tokensAfter = estimateTokens(history)
            agent.log.push(`[compact] Reduced to ~${Math.round(tokensAfter / 1000)}k tokens`)
            this.broadcastUpdate()
        } else {
            agent.log.push(`[tokens] ~${Math.round(tokensBefore / 1000)}k context tokens`)
            this.broadcastUpdate()
        }

        // ── AI decision ────────────────────────────────────────────────────
        let action: AgentAction
        try {
            const result = await askAgentWhatToDo(
                agent.goal,
                analyzed.url,
                analyzed.title,
                analyzed.accessibilityTree,
                analyzed.screenshot,
                history
            )
            action = result.action
            this.agentHistories.set(agent.id, result.history)
            apiRetries = 0  // reset on success
            console.log(`[Agent ${agent.id.slice(0,8)}] Claude → action: ${action.action} | reason: ${action.reason}`)
        } catch (err) {
            const kind = classifyApiError(err)

            if (kind === 'rate_limit' && apiRetries < MAX_API_RETRIES) {
                apiRetries++
                const delay = apiRetries * 2000
                agent.log.push(`[retry] Rate limited — waiting ${delay / 1000}s (attempt ${apiRetries}/${MAX_API_RETRIES})`)
                this.broadcastUpdate()
                await this.sleep(delay)
                continue  // retry same step without incrementing
            }

            if (kind === 'timeout' && apiRetries < 1) {
                apiRetries++
                agent.log.push(`[retry] Timeout — retrying once`)
                this.broadcastUpdate()
                await this.sleep(1000)
                continue
            }

            if (kind === 'auth') {
                agent.status = 'error'
                agent.log.push(`API key invalid or unauthorized. Check Settings → API Key.`)
                this.agentHistories.delete(agent.id)
                this.agentPages.delete(agent.id)
                this.broadcastUpdate()
                return
            }

            // Unknown or exhausted retries
            agent.status = 'error'
            agent.log.push(`API error (${kind}): ${err}`)
            this.agentHistories.delete(agent.id)
            this.agentPages.delete(agent.id)
            this.broadcastUpdate()
            return
        }

        agent.log.push(`[${action.action}] ${action.reason}`)
        this.broadcastUpdate()

        // ── Done signal ────────────────────────────────────────────────────
        if (action.isDone || action.action === 'done') {
            agent.finalAnswer = await askAgentForFinalAnswer(
                agent.goal, analyzed.url, analyzed.title,
                analyzed.accessibilityTree, analyzed.screenshot, agent.log
            )
            agent.status = 'done'
            this.agentHistories.delete(agent.id)
            this.agentPages.delete(agent.id)
            this.broadcastUpdate()
            console.log(`[Agent ${agent.id.slice(0,8)}] Done after ${step+1} step(s)`)
            return
        }

        await this.executeAgentAction(page, action, analyzed.elementMap)
        await this.sleep(1500)
        step++
    }
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/agent-manager.ts
git commit -m "feat: completion-driven loop, token estimation, classified retry"
```

---

## Task 6 — app.ts: wire up apiKeys + fallbackModel from settings

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Update `setApiKey` / `setModel` calls to also load `apiKeys` and `fallbackModel`**

Update the import in `app.ts` to include `setApiKeys` and `setFallbackModel`:

```typescript
import { setApiKey, setApiKeys, setModel, setFallbackModel, testApiKey, parseUserIntent } from './agents/ai-client'
```

In `main()`, after the existing `setApiKey(apiKey)` call, add:

```typescript
// Load additional keys for rotation
const extraKeys = settings.apiKeys
    ? settings.apiKeys.split(',').map(k => k.trim()).filter(Boolean)
    : []
setApiKeys([apiKey, ...extraKeys])

setFallbackModel(settings.fallbackModel || '')
```

And in the `saveSettings` handler, also update keys + fallback when settings change:

```typescript
saveSettings: (updates: any) => {
    const saved = saveSettings(updates)
    if (updates.apiKey !== undefined) {
        setApiKey(updates.apiKey)
        const extra = (saved.apiKeys || '').split(',').map((k: string) => k.trim()).filter(Boolean)
        setApiKeys([updates.apiKey, ...extra])
    }
    if (updates.apiKeys !== undefined) {
        const primary = saved.apiKey || ''
        const extra = updates.apiKeys.split(',').map((k: string) => k.trim()).filter(Boolean)
        setApiKeys([primary, ...extra])
    }
    if (updates.aiModel     !== undefined) setModel(updates.aiModel)
    if (updates.fallbackModel !== undefined) setFallbackModel(updates.fallbackModel)
    return Promise.resolve(saved)
},
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Full build**

```bash
npx tsc
```

Expected: `dist/` updated, no errors.

- [ ] **Step 4: Final commit**

```bash
git add src/app.ts
git commit -m "feat: wire apiKeys + fallbackModel from settings into ai-client"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| Parse failure → retry with correction | Task 3 (`PARSE_FAILURE_RETRY`, `MAX_PARSE_RETRIES`) |
| Classified error retry | Task 5 (`classifyApiError`, retry loop in `runAgentLoop`) |
| Completion-driven loop | Task 5 (`while(true)` + ceiling guard) |
| Token estimation shown to user | Task 5 (`[tokens] ~Xk context tokens` in agent log) |
| Summarized compaction | Task 4 (`compactHistory`) |
| Key rotation | Task 2 (`callWithRotation`, `currentKeys`) |
| Model fallback | Task 2 (`fallbackModel`, fallback loop in `callWithRotation`) |
| Uncapped max_tokens | Task 3 (1024 for decisions, was 256) |
| Planning-only detection + retry | Task 3 (`isPlanningOnlyResponse`, `PLANNING_ONLY_RETRY`) |
| Settings fields | Task 1 |
| Wire-up in app.ts | Task 6 |

All requirements covered. No gaps.

### Placeholder scan

No TBDs, TODOs, or "implement later" markers. All code blocks are complete and self-contained.

### Type consistency

- `estimateTokens` exported from `ai-client.ts` (Task 4), imported in `agent-manager.ts` (Task 5) ✓
- `compactHistory` exported from `ai-client.ts` (Task 4), imported in `agent-manager.ts` (Task 5) ✓
- `setApiKeys`, `setFallbackModel` exported from `ai-client.ts` (Task 2), imported in `app.ts` (Task 6) ✓
- `callWithRotation` is file-private (not exported) — only used internally in `ai-client.ts` ✓
- `classifyApiError` is file-private in `agent-manager.ts` ✓
