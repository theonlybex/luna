# Luna Playwright Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite Luna's browser engine from Electron WebContentsViews to Playwright-controlled headed Chromium, with Accessibility Tree + screenshot-based vision for dramatically smarter AI agents.

**Architecture:** Electron remains the control panel (agent list, logs, goal input). Playwright launches and controls a separate visible Chromium window — the browser the user actually sees. Each agent step reads the page via the Accessibility Tree (serialized numbered elements) and a screenshot, sends both to Claude as vision input, and executes Claude's response via Playwright's rich action API.

**Tech Stack:** Electron 41, Playwright (headed Chromium), TypeScript, @anthropic-ai/sdk (vision-enabled messages)

---

## File Map

| File | Status | Responsibility |
|------|--------|---------------|
| `src/main.ts` | **Rewrite** | Electron control panel only — no WebContentsViews. Wires IPC to AgentManager + PlaywrightSession. |
| `src/preload.ts` | **Simplify** | Exposes only agent/sidebar/settings IPC — no tab navigation. |
| `src/browser/playwright-session.ts` | **Create** | Playwright browser lifecycle: launch headed Chromium, expose current page, manage tabs. |
| `src/browser/page-analyzer.ts` | **Create** | Given a Playwright Page, returns: screenshot (base64), serialized A11y tree (numbered), element map for acting. |
| `src/agents/types.ts` | **Rewrite** | New AgentAction schema (elementIndex instead of CSS selector), richer action set. |
| `src/agents/ai-client.ts` | **Rewrite** | Claude messages with vision: sends screenshot as image + A11y tree as text. |
| `src/agents/agent-manager.ts` | **Rewrite** | Agent loop using PlaywrightSession + PageAnalyzer. Automation engine rewritten with Playwright actions. |
| `src/renderer/index.html` | **Simplify** | Remove tab bar (Playwright manages tabs). Keep: sidebar, goal input, logs. |
| `src/renderer/renderer.ts` | **Simplify** | Remove all tab/address-bar logic. Keep: agent cards, creation panel. |
| `src/settings/settings-store.ts` | **Keep** | No changes needed. |
| `src/settings-preload.ts` | **Keep** | No changes needed. |
| `src/renderer/settings.html` | **Keep** | No changes needed. |
| `src/renderer/settings.ts` | **Keep** | No changes needed. |
| `package.json` | **Modify** | Add `playwright` dependency. |

---

## Task 1: Install Playwright

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Playwright and types**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npm install playwright
npm install --save-dev @playwright/test
```

- [ ] **Step 2: Install Chromium browser binary**

```bash
npx playwright install chromium
```

Expected output: `Chromium X.X.X` downloaded to local cache.

- [ ] **Step 3: Verify package.json has playwright**

Check that `package.json` `dependencies` now includes `"playwright": "^X.X.X"`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add playwright dependency"
```

---

## Task 2: Rewrite Types

**Files:**
- Rewrite: `src/agents/types.ts`

- [ ] **Step 1: Replace the entire types file**

```typescript
/**
 * types.ts — Data contracts for the Luna agent system (Playwright edition)
 *
 * KEY CHANGE: AgentAction now uses elementIndex (from the Accessibility Tree)
 * instead of CSS selectors. Claude sees a numbered list of interactive elements
 * and responds with an index — no selector guessing.
 */

// ─── Agent ───────────────────────────────────────────────────────────────────

export interface Agent {
    id: string
    type: 'agent'
    goal: string
    status: AgentStatus
    log: string[]
    // No tabIndex — Playwright manages the active page directly
}

export type AgentStatus = 'thinking' | 'running' | 'done' | 'error'

// ─── Automation ──────────────────────────────────────────────────────────────

export interface Automation {
    id: string
    type: 'automation'
    description: string
    steps: AutomationStep[]
    isRunning: boolean
    repeatInterval: number
}

export interface AutomationStep {
    id: string
    action: 'navigate' | 'click' | 'type' | 'wait' | 'extract' | 'scroll'
    // For navigate: full URL
    // For click/type/extract: element name (from A11y tree) OR CSS selector fallback
    // For wait: ms as string e.g. "2000"
    // For scroll: "up" | "down"
    target: string
    value?: string        // text to type (type action only)
    description: string
}

// ─── Shared ──────────────────────────────────────────────────────────────────

export type SidebarItem = Agent | Automation

// ─── AI Communication ────────────────────────────────────────────────────────

/**
 * AgentAction — what Claude decides to do next.
 *
 * elementIndex refers to the numbered index in the Accessibility Tree
 * that PageAnalyzer serialized and sent to Claude. This is far more
 * reliable than CSS selectors because Claude is choosing from a menu
 * of elements it can actually see in both the A11y tree and the screenshot.
 */
export interface AgentAction {
    action: 'navigate' | 'click' | 'type' | 'scroll' | 'go_back' | 'wait' | 'done'
    elementIndex?: number        // index from A11y tree (for click/type)
    url?: string                 // for navigate
    text?: string                // for type
    scrollDirection?: 'up' | 'down'  // for scroll
    reason: string               // shown in sidebar log
    isDone: boolean
}

// ─── Page State ──────────────────────────────────────────────────────────────

/**
 * AnalyzedPage — the full page state snapshot sent to Claude each loop iteration.
 *
 * screenshot: base64 PNG — Claude sees the page visually
 * accessibilityTree: numbered flat list of interactive elements — Claude targets by index
 * elementMap: maps index → {role, name} for Playwright to act on
 */
export interface AnalyzedPage {
    url: string
    title: string
    screenshot: string            // base64 PNG
    accessibilityTree: string     // e.g. "[0] button \"Search\"\n[1] textbox \"Query\""
    elementMap: ElementInfo[]     // parallel array — elementMap[i] corresponds to index i
}

export interface ElementInfo {
    role: string    // ARIA role e.g. "button", "textbox", "link"
    name: string    // accessible name e.g. "Search", "Submit"
}

// ─── Sidebar UI ──────────────────────────────────────────────────────────────

export interface SidebarItemInfo {
    id: string
    type: 'agent' | 'automation'
    goal?: string
    description?: string
    status?: AgentStatus
    log?: string[]
    steps?: AutomationStep[]
    isRunning?: boolean
}
```

- [ ] **Step 2: Build to catch type errors**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only from files that haven't been rewritten yet (ai-client, agent-manager). That's fine.

- [ ] **Step 3: Commit**

```bash
git add src/agents/types.ts
git commit -m "feat: rewrite types for Playwright/A11y tree agent architecture"
```

---

## Task 3: Playwright Session

**Files:**
- Create: `src/browser/playwright-session.ts`

- [ ] **Step 1: Create the browser directory**

```bash
mkdir -p /c/Users/abdim/Desktop/Projects/Luna/src/browser
```

- [ ] **Step 2: Create playwright-session.ts**

```typescript
/**
 * playwright-session.ts — Playwright browser lifecycle manager
 *
 * Launches a headed Chromium browser that the user can see and interact with.
 * Exposes the current active page for agents to analyze and act on.
 *
 * WHY HEADED (not headless):
 *   Luna is a user-facing browser. The user should see what the agent is doing.
 *   Headed mode = visible browser window. headless: false achieves this.
 *
 * WHY A SINGLETON:
 *   One browser, multiple pages (tabs). The singleton ensures all agents share
 *   the same browser context (cookies, sessions, etc.) just like a real browser.
 */

import { Browser, BrowserContext, Page, chromium } from 'playwright'

export class PlaywrightSession {
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private activePage: Page | null = null

    /**
     * launch — starts the headed Chromium browser.
     * Called once at app startup from main.ts.
     */
    async launch(homepage: string = 'https://google.com'): Promise<void> {
        this.browser = await chromium.launch({
            headless: false,   // HEADED — user sees the browser
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized'
            ]
        })

        this.context = await this.browser.newContext({
            viewport: null,    // null = use the window's actual size (not a fixed viewport)
            acceptDownloads: true
        })

        // Open first tab
        this.activePage = await this.context.newPage()
        await this.activePage.goto(homepage)

        // Track which page is active when user switches tabs
        this.context.on('page', (page) => {
            this.activePage = page
        })
    }

    /**
     * getActivePage — returns the page the agent should act on.
     * Returns null if the browser hasn't been launched yet.
     */
    getActivePage(): Page | null {
        return this.activePage
    }

    /**
     * getAllPages — returns all open pages (tabs).
     */
    getAllPages(): Page[] {
        return this.context?.pages() ?? []
    }

    /**
     * navigate — navigates the active page to a URL.
     */
    async navigate(url: string): Promise<void> {
        if (!this.activePage) return
        const fullUrl = url.startsWith('http') ? url : `https://${url}`
        await this.activePage.goto(fullUrl, { waitUntil: 'domcontentloaded' })
    }

    /**
     * newTab — opens a new tab and makes it active.
     */
    async newTab(url: string = 'https://google.com'): Promise<void> {
        if (!this.context) return
        this.activePage = await this.context.newPage()
        await this.activePage.goto(url)
    }

    /**
     * close — shuts down the browser. Called when Electron app quits.
     */
    async close(): Promise<void> {
        await this.browser?.close()
        this.browser = null
        this.context = null
        this.activePage = null
    }

    /**
     * isAlive — true if the browser is running.
     */
    isAlive(): boolean {
        return this.browser !== null && this.browser.isConnected()
    }
}
```

- [ ] **Step 3: Build to verify no syntax errors**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | grep "playwright-session" || echo "No errors in playwright-session.ts"
```

- [ ] **Step 4: Commit**

```bash
git add src/browser/playwright-session.ts
git commit -m "feat: add PlaywrightSession — headed Chromium browser lifecycle"
```

---

## Task 4: Page Analyzer (A11y Tree + Screenshot)

**Files:**
- Create: `src/browser/page-analyzer.ts`

- [ ] **Step 1: Create page-analyzer.ts**

```typescript
/**
 * page-analyzer.ts — Extracts page state for AI consumption
 *
 * Given a Playwright Page, this module produces:
 *   1. A screenshot (base64 PNG) — Claude sees the page visually
 *   2. A serialized Accessibility Tree — numbered list of interactive elements
 *   3. An elementMap — maps each index to its ARIA role+name for Playwright to act on
 *
 * WHY THE ACCESSIBILITY TREE:
 *   Raw HTML is thousands of lines. The A11y tree gives only what matters:
 *   buttons, inputs, links — the things Claude can actually interact with.
 *   It's the same representation screen readers use, semantically clean.
 *
 * WHY NUMBERED ELEMENTS:
 *   Instead of asking Claude to guess a CSS selector, we pre-assign an index
 *   to every interactive element. Claude picks a number. We find the element
 *   by its ARIA role + name. No guessing, no broken selectors.
 */

import { Page } from 'playwright'
import { AnalyzedPage, ElementInfo } from '../agents/types'

// ARIA roles we consider "interactive" — Claude can click/type on these
const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'menuitem', 'tab', 'option',
    'spinbutton', 'slider', 'switch', 'treeitem', 'listitem'
])

interface AXNode {
    role?: string
    name?: string
    value?: string
    children?: AXNode[]
    disabled?: boolean
    focused?: boolean
}

/**
 * analyzePage — the main export. Call this each agent loop iteration.
 *
 * Returns everything Claude needs to decide its next action.
 */
export async function analyzePage(page: Page): Promise<AnalyzedPage> {
    // Run screenshot and A11y snapshot in parallel for speed
    const [screenshotBuffer, snapshot] = await Promise.all([
        page.screenshot({ type: 'png', fullPage: false }),
        page.accessibility.snapshot({ interestingOnly: false })
    ])

    const elementMap: ElementInfo[] = []
    const lines: string[] = []

    // Walk the A11y tree, number every interactive element
    if (snapshot) {
        flattenTree(snapshot as AXNode, elementMap, lines)
    }

    // If nothing interactive found (e.g. page still loading), add a fallback
    if (lines.length === 0) {
        lines.push('(No interactive elements detected — page may still be loading)')
    }

    return {
        url: page.url(),
        title: await page.title(),
        screenshot: screenshotBuffer.toString('base64'),
        accessibilityTree: lines.join('\n'),
        elementMap
    }
}

/**
 * flattenTree — recursively walks the A11y node tree.
 * Assigns an index to every interactive node and records it in elementMap + lines.
 */
function flattenTree(node: AXNode, elementMap: ElementInfo[], lines: string[]): void {
    const role = node.role?.toLowerCase() ?? ''
    const name = node.name?.trim() ?? ''

    // Assign an index if this node is interactive, has a name, and is not disabled
    if (INTERACTIVE_ROLES.has(role) && name && !node.disabled) {
        const index = elementMap.length
        elementMap.push({ role, name })
        // Format: [0] button "Search"
        lines.push(`[${index}] ${role} "${name}"`)
    }

    // Recurse into children
    node.children?.forEach(child => flattenTree(child, elementMap, lines))
}

/**
 * actOnElement — executes a click or type action using the elementMap.
 *
 * Uses Playwright's getByRole locator — robust against DOM changes,
 * works across frames, handles ARIA-hidden correctly.
 */
export async function actOnElement(
    page: Page,
    elementIndex: number,
    elementMap: ElementInfo[],
    action: 'click' | 'type',
    text?: string
): Promise<void> {
    const info = elementMap[elementIndex]
    if (!info) {
        console.warn(`[PageAnalyzer] No element at index ${elementIndex}`)
        return
    }

    try {
        // getByRole is Playwright's preferred, most reliable locator
        const locator = page.getByRole(info.role as any, { name: info.name }).first()

        if (action === 'click') {
            await locator.click({ timeout: 5000 })
        } else if (action === 'type' && text !== undefined) {
            await locator.fill(text, { timeout: 5000 })
        }
    } catch (err) {
        console.warn(`[PageAnalyzer] Failed to ${action} element [${elementIndex}] "${info.role}:${info.name}": ${err}`)
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | grep "page-analyzer" || echo "No errors in page-analyzer.ts"
```

- [ ] **Step 3: Commit**

```bash
git add src/browser/page-analyzer.ts
git commit -m "feat: add PageAnalyzer — A11y tree + screenshot extraction for AI vision"
```

---

## Task 5: Rewrite AI Client (Vision-Enabled)

**Files:**
- Rewrite: `src/agents/ai-client.ts`

- [ ] **Step 1: Rewrite ai-client.ts**

```typescript
/**
 * ai-client.ts — Claude API communication with vision
 *
 * KEY CHANGES from the old version:
 *   1. Each request now includes a SCREENSHOT (base64 PNG) as an image content part.
 *      Claude can literally see the page, not just read URL+title.
 *   2. The prompt includes the numbered Accessibility Tree so Claude picks element
 *      indices instead of guessing CSS selectors.
 *   3. The action schema uses elementIndex (number) instead of target (CSS string).
 *
 * WHY VISION + A11Y TREE TOGETHER:
 *   The A11y tree gives structure and indices. The screenshot catches visual context
 *   the A11y tree misses (images, layout, CAPTCHAs, canvas content).
 *   Together they give Claude the full picture a human would see.
 */

import Anthropic from '@anthropic-ai/sdk'
import { AgentAction, AutomationStep } from './types'

let client: Anthropic | null = null
let currentModel = 'claude-opus-4-6'

export function setApiKey(key: string): void {
    process.env.ANTHROPIC_API_KEY = key
    client = null
}

export function setModel(model: string): void {
    currentModel = model
}

function getClient(): Anthropic {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
        throw new Error('No API key set. Open Settings (⚙) → Luna AI → Anthropic API Key.')
    }
    if (!client) {
        client = new Anthropic({ apiKey })
    }
    return client
}

/**
 * askAgentWhatToDo — vision-enabled agent decision.
 *
 * Sends Claude:
 *   - A screenshot of the current page (image content part)
 *   - The numbered Accessibility Tree (text content part)
 *   - The goal and action history
 *
 * Claude responds with an AgentAction using elementIndex (not CSS selectors).
 */
export async function askAgentWhatToDo(
    goal: string,
    url: string,
    title: string,
    accessibilityTree: string,
    screenshotBase64: string,
    previousActions: string[]
): Promise<AgentAction> {

    const history = previousActions.length > 0
        ? `Actions taken so far:\n${previousActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
        : 'No actions taken yet.'

    const response = await getClient().messages.create({
        model: currentModel,
        max_tokens: 512,
        system: `You are a browser automation agent inside the Luna browser.
You receive a screenshot of the current page AND a numbered list of interactive elements from the Accessibility Tree.
Choose your next single action to accomplish the user's goal.

Respond ONLY with valid JSON:
{
  "action": "navigate" | "click" | "type" | "scroll" | "go_back" | "wait" | "done",
  "elementIndex": <number from the list below, for click/type only>,
  "url": "<full https:// URL, for navigate only>",
  "text": "<text to enter, for type only>",
  "scrollDirection": "up" | "down",
  "reason": "<one-line explanation under 80 chars>",
  "isDone": true | false
}

Rules:
- click: set elementIndex to the number in [brackets] from the element list
- type: set elementIndex AND text
- navigate: set url (must start with https://)
- scroll: set scrollDirection
- done: set isDone=true when the goal is accomplished
- Raw JSON only — no markdown, no code fences`,
        messages: [{
            role: 'user',
            content: [
                // Vision: the actual screenshot
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: screenshotBase64
                    }
                },
                // Text context: page state + A11y tree + goal + history
                {
                    type: 'text',
                    text: `URL: ${url}
Title: ${title}

Interactive elements on this page:
${accessibilityTree}

Goal: "${goal}"
${history}

What is the next single action? JSON only.`
                }
            ]
        }]
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : ''

    try {
        return JSON.parse(raw) as AgentAction
    } catch {
        return {
            action: 'done',
            reason: `Could not parse response: ${raw.slice(0, 60)}`,
            isDone: true
        }
    }
}

/**
 * parseAutomationSteps — convert plain-English description into structured steps.
 * Unchanged in concept — Claude still parses steps, but they now use element names.
 */
export async function parseAutomationSteps(description: string): Promise<AutomationStep[]> {
    const response = await getClient().messages.create({
        model: currentModel,
        max_tokens: 1024,
        system: `Convert natural language browser automation descriptions into step arrays.

Respond ONLY with a JSON array. Each element:
{
  "id": "step_1",
  "action": "navigate" | "click" | "type" | "wait" | "extract" | "scroll",
  "target": "URL for navigate | element accessible name for click/type/extract | ms string for wait | up/down for scroll",
  "value": "text (type only)",
  "description": "Human-readable label"
}

For click/type, use the element's likely accessible name (e.g. "Search", "Submit", "Email").
Always add a wait step after navigate. Raw JSON array only — no markdown.`,
        messages: [{
            role: 'user',
            content: `Convert to steps: "${description}"`
        }]
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]'

    try {
        const cleaned = raw
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim()
        return JSON.parse(cleaned) as AutomationStep[]
    } catch {
        return [{
            id: 'step_1',
            action: 'navigate',
            target: 'https://google.com',
            description: `Parse failed for: "${description.slice(0, 40)}"`
        }]
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | grep "ai-client" || echo "No errors in ai-client.ts"
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/ai-client.ts
git commit -m "feat: rewrite ai-client with vision — screenshot + A11y tree sent to Claude"
```

---

## Task 6: Rewrite Agent Manager

**Files:**
- Rewrite: `src/agents/agent-manager.ts`

- [ ] **Step 1: Rewrite agent-manager.ts**

```typescript
/**
 * agent-manager.ts — Orchestrates agents using Playwright
 *
 * KEY CHANGES from old version:
 *   - No more tabs[] array or WebContentsViews — PlaywrightSession manages the browser
 *   - Agent loop calls analyzePage() each iteration to get A11y tree + screenshot
 *   - Actions use elementIndex (from A11y tree) instead of CSS selectors
 *   - Automation steps use Playwright's rich action API (fill, click, scroll)
 */

import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { Agent, Automation, AutomationStep, SidebarItem } from './types'
import { askAgentWhatToDo, parseAutomationSteps } from './ai-client'
import { PlaywrightSession } from '../browser/playwright-session'
import { analyzePage, actOnElement } from '../browser/page-analyzer'

const DEFAULT_MAX_AGENT_STEPS = 10

export class AgentManager {
    private items: SidebarItem[] = []
    private shell: BrowserWindow
    private playwrightSession: PlaywrightSession

    constructor(shell: BrowserWindow, playwrightSession: PlaywrightSession) {
        this.shell = shell
        this.playwrightSession = playwrightSession
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async createAgent(goal: string, maxSteps: number = DEFAULT_MAX_AGENT_STEPS): Promise<Agent> {
        const agent: Agent = {
            id: randomUUID(),
            type: 'agent',
            goal,
            status: 'thinking',
            log: []
        }

        this.items.push(agent)
        this.broadcastUpdate()

        this.runAgentLoop(agent, maxSteps).catch(err => {
            agent.status = 'error'
            agent.log.push(`Unexpected error: ${err}`)
            this.broadcastUpdate()
        })

        return agent
    }

    async createAutomation(description: string): Promise<Automation> {
        const automation: Automation = {
            id: randomUUID(),
            type: 'automation',
            description,
            steps: [],
            isRunning: false,
            repeatInterval: 5000
        }

        this.items.push(automation)
        this.broadcastUpdate()

        automation.steps = await parseAutomationSteps(description)
        this.broadcastUpdate()

        return automation
    }

    async runAutomation(automationId: string): Promise<void> {
        const automation = this.findAutomation(automationId)
        if (!automation || automation.isRunning) return

        const page = this.playwrightSession.getActivePage()
        if (!page) return

        automation.isRunning = true
        this.broadcastUpdate()

        for (const step of automation.steps) {
            if (!automation.isRunning) break
            await this.executeStep(step)
            await this.sleep(500)
        }

        automation.isRunning = false
        this.broadcastUpdate()
    }

    stopAutomation(automationId: string): void {
        const automation = this.findAutomation(automationId)
        if (!automation) return
        automation.isRunning = false
        this.broadcastUpdate()
    }

    getItems(): SidebarItem[] {
        return this.items
    }

    // ── Agent Loop ────────────────────────────────────────────────────────────

    /**
     * runAgentLoop — the core think → see → act loop.
     *
     * Each iteration:
     *   1. analyzePage() → screenshot + A11y tree
     *   2. askAgentWhatToDo() → Claude sees screenshot + tree, picks action
     *   3. Execute action via Playwright
     *   4. Wait for page to settle (domcontentloaded or 1.5s)
     */
    private async runAgentLoop(agent: Agent, maxSteps: number): Promise<void> {
        const page = this.playwrightSession.getActivePage()

        if (!page) {
            agent.status = 'error'
            agent.log.push('Error: No browser page available. Is Playwright running?')
            this.broadcastUpdate()
            return
        }

        agent.status = 'running'
        this.broadcastUpdate()

        for (let step = 0; step < maxSteps; step++) {
            // Bail out if page closed
            if (page.isClosed()) {
                agent.status = 'error'
                agent.log.push('Browser page was closed')
                this.broadcastUpdate()
                return
            }

            // 1. Get full page state — A11y tree + screenshot
            let analyzed
            try {
                analyzed = await analyzePage(page)
            } catch (err) {
                agent.status = 'error'
                agent.log.push(`Page analysis failed: ${err}`)
                this.broadcastUpdate()
                return
            }

            // 2. Ask Claude — with vision
            let action
            try {
                action = await askAgentWhatToDo(
                    agent.goal,
                    analyzed.url,
                    analyzed.title,
                    analyzed.accessibilityTree,
                    analyzed.screenshot,
                    agent.log
                )
            } catch (err) {
                agent.status = 'error'
                agent.log.push(`API error: ${err}`)
                this.broadcastUpdate()
                return
            }

            agent.log.push(`[${action.action}] ${action.reason}`)
            this.broadcastUpdate()

            if (action.isDone || action.action === 'done') {
                agent.status = 'done'
                this.broadcastUpdate()
                return
            }

            // 3. Execute action
            await this.executeAgentAction(page, action, analyzed.elementMap)

            // 4. Wait for page to settle
            await this.sleep(1500)
        }

        agent.status = 'done'
        agent.log.push(`Reached ${maxSteps}-step limit`)
        this.broadcastUpdate()
    }

    // ── Action Execution ──────────────────────────────────────────────────────

    private async executeAgentAction(
        page: any,
        action: any,
        elementMap: any[]
    ): Promise<void> {
        try {
            switch (action.action) {
                case 'navigate':
                    if (action.url) {
                        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    }
                    break

                case 'click':
                    if (action.elementIndex !== undefined) {
                        await actOnElement(page, action.elementIndex, elementMap, 'click')
                    }
                    break

                case 'type':
                    if (action.elementIndex !== undefined && action.text !== undefined) {
                        await actOnElement(page, action.elementIndex, elementMap, 'type', action.text)
                    }
                    break

                case 'scroll':
                    const direction = action.scrollDirection === 'up' ? -500 : 500
                    await page.evaluate((dy: number) => window.scrollBy(0, dy), direction)
                    break

                case 'go_back':
                    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
                    break

                case 'wait':
                    await this.sleep(2000)
                    break
            }
        } catch (err) {
            console.warn(`[AgentManager] Action "${action.action}" failed: ${err}`)
        }
    }

    private async executeStep(step: AutomationStep): Promise<void> {
        const page = this.playwrightSession.getActivePage()
        if (!page) return

        try {
            switch (step.action) {
                case 'navigate':
                    await page.goto(step.target, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    break

                case 'click':
                    // Automation steps use element name (target = accessible name)
                    await page.getByRole('button', { name: step.target }).first().click({ timeout: 5000 })
                        .catch(() => page.getByText(step.target).first().click({ timeout: 5000 }))
                    break

                case 'type':
                    await page.getByLabel(step.target).first().fill(step.value || '', { timeout: 5000 })
                        .catch(() => page.getByPlaceholder(step.target).first().fill(step.value || '', { timeout: 5000 }))
                    break

                case 'wait':
                    await this.sleep(parseInt(step.target) || 1000)
                    break

                case 'scroll':
                    const dy = step.target === 'up' ? -500 : 500
                    await page.evaluate((d: number) => window.scrollBy(0, d), dy)
                    break

                case 'extract':
                    const text = await page.getByText(step.target).first().textContent().catch(() => null)
                    console.log(`[Luna Extract] "${step.description}": ${text}`)
                    break
            }
        } catch (err) {
            console.warn(`[AgentManager] Step "${step.action}" failed: ${err}`)
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private findAutomation(id: string): Automation | undefined {
        return this.items.find(item => item.id === id && item.type === 'automation') as Automation | undefined
    }

    private broadcastUpdate(): void {
        this.shell.webContents.send('sidebar-updated', this.items)
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | grep "agent-manager" || echo "No errors in agent-manager.ts"
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/agent-manager.ts
git commit -m "feat: rewrite agent-manager — Playwright actions, A11y element targeting"
```

---

## Task 7: Rewrite Main Process

**Files:**
- Rewrite: `src/main.ts`

- [ ] **Step 1: Rewrite main.ts**

```typescript
/**
 * main.ts — Electron entry point (control panel only)
 *
 * KEY CHANGE: We no longer manage WebContentsViews or tabs here.
 * Playwright controls its own headed Chromium window.
 * This file creates the Electron control panel (agent sidebar)
 * and wires IPC between the renderer and AgentManager.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import { PlaywrightSession } from './browser/playwright-session'
import { AgentManager } from './agents/agent-manager'
import { getSettings, saveSettings } from './settings/settings-store'
import { setApiKey, setModel } from './agents/ai-client'

const playwrightSession = new PlaywrightSession()
let agentManager: AgentManager

async function createWindow(): Promise<void> {
    // Load settings on startup
    const settings = getSettings()
    if (settings.apiKey) setApiKey(settings.apiKey)
    setModel(settings.aiModel)

    // Control panel window — slim sidebar, always on top optional
    const shell = new BrowserWindow({
        title: 'Luna — Control Panel',
        width: 280,
        height: 800,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    })

    shell.loadFile(path.join(__dirname, 'renderer/index.html'))

    // Wire up AgentManager with the PlaywrightSession
    agentManager = new AgentManager(shell, playwrightSession)

    // Send theme on startup
    shell.webContents.once('did-finish-load', () => {
        shell.webContents.send('apply-theme', settings.theme)
    })

    // ── IPC Handlers ─────────────────────────────────────────────────────────

    ipcMain.handle('create-agent', async (_e, goal: string) => {
        const settings = getSettings()
        return agentManager.createAgent(goal, settings.maxAgentSteps)
    })

    ipcMain.handle('create-automation', async (_e, description: string) => {
        return agentManager.createAutomation(description)
    })

    ipcMain.handle('run-automation', async (_e, id: string) => {
        return agentManager.runAutomation(id)
    })

    ipcMain.on('stop-automation', (_e, id: string) => {
        agentManager.stopAutomation(id)
    })

    ipcMain.handle('get-sidebar-items', () => {
        return agentManager.getItems()
    })

    // Settings IPC
    ipcMain.handle('get-settings', () => getSettings())

    ipcMain.handle('save-settings', (_e, updates) => {
        const saved = saveSettings(updates)
        if (updates.apiKey !== undefined) setApiKey(updates.apiKey)
        if (updates.aiModel !== undefined) setModel(updates.aiModel)
        if (updates.theme !== undefined) shell.webContents.send('apply-theme', updates.theme)
        return saved
    })

    // Navigate the Playwright browser (from address bar or agent)
    ipcMain.on('navigate', (_e, url: string) => {
        playwrightSession.navigate(url)
    })

    ipcMain.on('new-tab', () => {
        playwrightSession.newTab()
    })

    // Launch Playwright browser
    try {
        await playwrightSession.launch(settings.homepage)
        console.log('[Luna] Playwright browser launched')
    } catch (err) {
        console.error('[Luna] Failed to launch Playwright browser:', err)
    }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', async () => {
    await playwrightSession.close()
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('will-quit', async () => {
    await playwrightSession.close()
})
```

- [ ] **Step 2: Build to verify**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: rewrite main.ts — Electron control panel + PlaywrightSession wiring"
```

---

## Task 8: Simplify Preload

**Files:**
- Rewrite: `src/preload.ts`

- [ ] **Step 1: Rewrite preload.ts**

```typescript
/**
 * preload.ts — IPC bridge for the control panel renderer
 *
 * Removed: switchTab, closeTab, navigate (tab bar)
 * Kept: agent ops, sidebar updates, theme, settings
 * Added: navigate (tells Playwright browser where to go)
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('luna', {
    // ── Agent operations ──────────────────────────────────────────────────────
    createAgent:      (goal: string)        => ipcRenderer.invoke('create-agent', goal),
    createAutomation: (desc: string)        => ipcRenderer.invoke('create-automation', desc),
    runAutomation:    (id: string)          => ipcRenderer.invoke('run-automation', id),
    stopAutomation:   (id: string)          => ipcRenderer.send('stop-automation', id),
    getSidebarItems:  ()                    => ipcRenderer.invoke('get-sidebar-items'),

    // ── Browser navigation (controls the Playwright window) ───────────────────
    navigate: (url: string) => ipcRenderer.send('navigate', url),
    newTab:   ()            => ipcRenderer.send('new-tab'),

    // ── Event listeners ───────────────────────────────────────────────────────
    onSidebarUpdated: (cb: (items: any[]) => void) =>
        ipcRenderer.on('sidebar-updated', (_e, items) => cb(items)),

    onThemeChanged: (cb: (theme: string) => void) =>
        ipcRenderer.on('apply-theme', (_e, theme) => cb(theme)),

    // ── Settings ──────────────────────────────────────────────────────────────
    getSettings:  ()        => ipcRenderer.invoke('get-settings'),
    saveSettings: (u: any)  => ipcRenderer.invoke('save-settings', u)
})
```

- [ ] **Step 2: Build**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | grep "preload" || echo "No errors in preload.ts"
```

- [ ] **Step 3: Commit**

```bash
git add src/preload.ts
git commit -m "feat: simplify preload — remove tab management, add Playwright navigate"
```

---

## Task 9: Simplify Renderer (Control Panel UI)

**Files:**
- Rewrite: `src/renderer/index.html`
- Rewrite: `src/renderer/renderer.ts`

- [ ] **Step 1: Rewrite index.html — control panel only**

Replace the entire file with:

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            display: flex;
            flex-direction: column;
            width: 100vw;
            height: 100vh;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #1e1e2e;
            overflow: hidden;
            user-select: none;
        }

        .hidden { display: none !important; }

        /* ── Header ── */
        #header {
            height: 48px;
            display: flex;
            align-items: center;
            padding: 0 12px;
            background: #16162a;
            border-bottom: 1px solid #2d2d42;
            gap: 8px;
            flex-shrink: 0;
            -webkit-app-region: drag;
        }

        #header-title {
            font-size: 13px;
            font-weight: 700;
            color: #ccc;
            flex: 1;
            letter-spacing: 0.3px;
        }

        #addBtn {
            width: 24px; height: 24px;
            border-radius: 50%;
            background: #4a90e2;
            color: white;
            font-size: 18px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; border: none; flex-shrink: 0;
            -webkit-app-region: no-drag;
        }
        #addBtn:hover { background: #357abd; }

        #settingsBtn {
            width: 28px; height: 28px;
            border-radius: 50%; border: none;
            background: transparent; cursor: pointer;
            font-size: 15px; display: flex; align-items: center; justify-content: center;
            color: #5f6368; flex-shrink: 0;
            -webkit-app-region: no-drag;
        }
        #settingsBtn:hover { background: #2d2d42; }

        /* ── Agent/Automation list ── */
        #sidebar-items {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        #sidebar-items::-webkit-scrollbar { width: 4px; }
        #sidebar-items::-webkit-scrollbar-thumb { background: #2d2d42; border-radius: 2px; }

        .sidebar-empty { color: #555; font-size: 12px; text-align: center; padding: 24px 8px; line-height: 2; }
        .sidebar-empty strong { color: #888; }

        .sidebar-card { background: #252538; border-radius: 8px; padding: 10px; border: 1px solid #2d2d42; }
        .sidebar-card:hover { border-color: #4a90e2; }
        .card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
        .card-icon { font-size: 14px; }
        .card-label { font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px; flex: 1; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .running-badge { font-size: 9px; font-weight: 700; color: #4a90e2; }
        .card-goal { font-size: 12px; color: #ccc; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-meta { font-size: 10px; color: #666; margin-bottom: 4px; }
        .card-log { border-top: 1px solid #2d2d42; padding-top: 6px; margin-top: 4px; }
        .log-entry { font-size: 10px; color: #777; line-height: 1.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-actions { margin-top: 8px; display: flex; gap: 6px; }
        .btn-run, .btn-stop { flex: 1; height: 24px; border-radius: 4px; border: none; font-size: 11px; font-weight: 600; cursor: pointer; }
        .btn-run { background: #4a90e2; color: white; }
        .btn-run:hover { background: #357abd; }
        .btn-stop { background: #d0021b; color: white; }
        .btn-stop:hover { background: #a50115; }

        /* ── Creation panel ── */
        #creation-panel {
            flex: 1; display: flex; flex-direction: column;
            padding: 12px; gap: 10px; overflow-y: auto;
        }

        .creation-title { font-size: 12px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.6px; padding-bottom: 8px; border-bottom: 1px solid #2d2d42; }

        .type-choice { padding: 14px 12px; border-radius: 8px; border: 1px solid #2d2d42; background: #252538; cursor: pointer; text-align: left; transition: border-color 0.15s; }
        .type-choice:hover { border-color: #4a90e2; background: #2a2a42; }
        .type-choice-icon { font-size: 22px; display: block; margin-bottom: 6px; }
        .type-choice strong { display: block; font-size: 13px; color: #eee; margin-bottom: 3px; }
        .type-choice span { font-size: 11px; color: #888; line-height: 1.5; display: block; }

        .creation-label { font-size: 11px; color: #888; margin-bottom: 4px; display: block; }

        .creation-input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #2d2d42; background: #16162a; color: #eee; font-size: 12px; outline: none; resize: none; }
        .creation-input:focus { border-color: #4a90e2; }
        .creation-input::placeholder { color: #444; }

        .creation-actions { display: flex; gap: 6px; margin-top: 4px; }

        .btn-back { height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid #2d2d42; background: transparent; color: #888; font-size: 12px; cursor: pointer; }
        .btn-back:hover { color: #ccc; }

        .btn-submit { flex: 1; height: 32px; border-radius: 6px; border: none; background: #4a90e2; color: white; font-size: 12px; font-weight: 600; cursor: pointer; }
        .btn-submit:hover { background: #357abd; }
        .btn-submit:disabled { background: #333; color: #666; cursor: not-allowed; }
    </style>
</head>
<body>

<div id="header">
    <span id="header-title">🌙 Luna Agents</span>
    <button id="addBtn" title="Add agent or automation">+</button>
    <button id="settingsBtn" title="Settings">⚙</button>
</div>

<div id="sidebar-items"></div>

<div id="creation-panel" class="hidden">

    <div id="type-screen">
        <div class="creation-title">Create new</div>
        <button class="type-choice" id="btn-choose-agent">
            <span class="type-choice-icon">🤖</span>
            <strong>Agent</strong>
            <span>Give it a goal. AI sees the page and figures out the steps.</span>
        </button>
        <button class="type-choice" id="btn-choose-automation">
            <span class="type-choice-icon">⚡</span>
            <strong>Automation</strong>
            <span>Describe the steps. AI parses and runs on repeat.</span>
        </button>
        <div class="creation-actions" style="margin-top: auto;">
            <button class="btn-back" id="btn-cancel-creation">Cancel</button>
        </div>
    </div>

    <div id="agent-screen" class="hidden">
        <div class="creation-title">🤖 New Agent</div>
        <label class="creation-label">What is the agent's goal?</label>
        <input id="agent-goal-input" class="creation-input" type="text"
            placeholder="e.g. Find the top AI news on Hacker News" />
        <div class="creation-actions">
            <button class="btn-back" id="btn-back-from-agent">← Back</button>
            <button class="btn-submit" id="btn-submit-agent">Start</button>
        </div>
    </div>

    <div id="auto-screen" class="hidden">
        <div class="creation-title">⚡ New Automation</div>
        <label class="creation-label">Describe the steps:</label>
        <textarea id="auto-desc-input" class="creation-input" rows="5"
            placeholder="e.g. Go to reddit.com, wait for it to load, click the top post"></textarea>
        <div class="creation-actions">
            <button class="btn-back" id="btn-back-from-auto">← Back</button>
            <button class="btn-submit" id="btn-submit-auto">Create</button>
        </div>
    </div>

</div>

<script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Rewrite renderer.ts**

```typescript
/**
 * renderer.ts — Control panel UI logic
 *
 * Manages the agent/automation list and creation panel.
 * No tab bar — Playwright manages the browser window directly.
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const sidebarItems    = document.getElementById('sidebar-items')!
const addBtn          = document.getElementById('addBtn')!
const settingsBtn     = document.getElementById('settingsBtn')!
const creationPanel   = document.getElementById('creation-panel')!
const typeScreen      = document.getElementById('type-screen')!
const agentScreen     = document.getElementById('agent-screen')!
const autoScreen      = document.getElementById('auto-screen')!
const btnChooseAgent  = document.getElementById('btn-choose-agent')!
const btnChooseAuto   = document.getElementById('btn-choose-automation')!
const agentGoalInput  = document.getElementById('agent-goal-input') as HTMLInputElement
const autoDescInput   = document.getElementById('auto-desc-input') as HTMLTextAreaElement
const btnSubmitAgent  = document.getElementById('btn-submit-agent')!
const btnSubmitAuto   = document.getElementById('btn-submit-auto')!
const btnCancel       = document.getElementById('btn-cancel-creation')!
const btnBackAgent    = document.getElementById('btn-back-from-agent')!
const btnBackAuto     = document.getElementById('btn-back-from-auto')!

// ── Settings button ───────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => window.luna.navigate('luna://settings'))

// ── Panel switching ───────────────────────────────────────────────────────────

function showView(view: 'items' | 'creation') {
    sidebarItems.classList.toggle('hidden', view === 'creation')
    creationPanel.classList.toggle('hidden', view === 'items')
}

function showScreen(screen: 'type' | 'agent' | 'auto') {
    typeScreen.classList.add('hidden')
    agentScreen.classList.add('hidden')
    autoScreen.classList.add('hidden')
    if (screen === 'type')  typeScreen.classList.remove('hidden')
    if (screen === 'agent') agentScreen.classList.remove('hidden')
    if (screen === 'auto')  autoScreen.classList.remove('hidden')
}

// ── Creation panel wiring ─────────────────────────────────────────────────────

addBtn.addEventListener('click', () => { showView('creation'); showScreen('type') })
btnCancel.addEventListener('click',   () => showView('items'))
btnBackAgent.addEventListener('click', () => showScreen('type'))
btnBackAuto.addEventListener('click',  () => showScreen('type'))

btnChooseAgent.addEventListener('click', () => { showScreen('agent'); agentGoalInput.focus() })
btnChooseAuto.addEventListener('click',  () => { showScreen('auto'); autoDescInput.focus() })

btnSubmitAgent.addEventListener('click', async () => {
    const goal = agentGoalInput.value.trim()
    if (!goal) return
    ;(btnSubmitAgent as HTMLButtonElement).disabled = true
    ;(btnSubmitAgent as HTMLButtonElement).textContent = 'Starting...'
    await window.luna.createAgent(goal)
    agentGoalInput.value = ''
    ;(btnSubmitAgent as HTMLButtonElement).disabled = false
    ;(btnSubmitAgent as HTMLButtonElement).textContent = 'Start'
    showView('items')
})

btnSubmitAuto.addEventListener('click', async () => {
    const desc = autoDescInput.value.trim()
    if (!desc) return
    ;(btnSubmitAuto as HTMLButtonElement).disabled = true
    ;(btnSubmitAuto as HTMLButtonElement).textContent = 'Parsing...'
    await window.luna.createAutomation(desc)
    autoDescInput.value = ''
    ;(btnSubmitAuto as HTMLButtonElement).disabled = false
    ;(btnSubmitAuto as HTMLButtonElement).textContent = 'Create'
    showView('items')
})

// ── Sidebar rendering ─────────────────────────────────────────────────────────

function renderSidebar(items: any[]) {
    sidebarItems.innerHTML = ''
    if (items.length === 0) {
        sidebarItems.innerHTML = `<div class="sidebar-empty"><p>No agents yet.</p><p>Click <strong>+</strong> to create one.</p></div>`
        return
    }
    items.forEach(item => {
        sidebarItems.appendChild(
            item.type === 'agent' ? renderAgentCard(item) : renderAutomationCard(item)
        )
    })
}

function renderAgentCard(item: any): HTMLElement {
    const card = document.createElement('div')
    card.className = 'sidebar-card agent-card'
    const dotColor = ({ thinking: '#f5a623', running: '#4a90e2', done: '#7ed321', error: '#d0021b' } as any)[item.status || 'thinking'] || '#888'
    const recentLog = (item.log || []).slice(-3)
    card.innerHTML = `
        <div class="card-header">
            <span class="card-icon">🤖</span>
            <span class="card-label">Agent</span>
            <span class="status-dot" style="background:${dotColor}" title="${item.status}"></span>
        </div>
        <div class="card-goal" title="${item.goal}">${item.goal}</div>
        <div class="card-meta">${item.status}</div>
        ${recentLog.length > 0 ? `<div class="card-log">${recentLog.map((e: string) => `<div class="log-entry">· ${e}</div>`).join('')}</div>` : ''}
    `
    return card
}

function renderAutomationCard(item: any): HTMLElement {
    const card = document.createElement('div')
    card.className = 'sidebar-card auto-card'
    const stepCount = (item.steps || []).length
    card.innerHTML = `
        <div class="card-header">
            <span class="card-icon">⚡</span>
            <span class="card-label">Automation</span>
            ${item.isRunning ? '<span class="running-badge">RUNNING</span>' : ''}
        </div>
        <div class="card-goal" title="${item.description}">${item.description}</div>
        <div class="card-meta">${stepCount > 0 ? `${stepCount} steps` : 'Parsing...'}</div>
        <div class="card-actions">
            ${!item.isRunning
                ? `<button class="btn-run" data-id="${item.id}">▶ Run</button>`
                : `<button class="btn-stop" data-id="${item.id}">■ Stop</button>`}
        </div>
    `
    card.querySelector('.btn-run')?.addEventListener('click',  () => window.luna.runAutomation(item.id))
    card.querySelector('.btn-stop')?.addEventListener('click', () => window.luna.stopAutomation(item.id))
    return card
}

window.luna.onSidebarUpdated((items) => renderSidebar(items))
window.luna.getSidebarItems().then((items) => renderSidebar(items))

window.luna.onThemeChanged((theme: string) => {
    document.body.dataset.theme = theme
})
```

- [ ] **Step 3: Build**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.html src/renderer/renderer.ts
git commit -m "feat: simplify control panel UI — remove tabs, Playwright owns the browser"
```

---

## Task 10: Update global.d.ts and Build

**Files:**
- Modify: `src/global.d.ts`

- [ ] **Step 1: Read current global.d.ts**

```bash
cat /c/Users/abdim/Desktop/Projects/Luna/src/global.d.ts
```

- [ ] **Step 2: Update the window.luna type declarations to match new preload.ts**

Replace file contents with:

```typescript
// global.d.ts — type declarations for window.luna (exposed by preload.ts)

interface Window {
    luna: {
        // Agent operations
        createAgent:      (goal: string)        => Promise<any>
        createAutomation: (desc: string)        => Promise<any>
        runAutomation:    (id: string)          => Promise<void>
        stopAutomation:   (id: string)          => void
        getSidebarItems:  ()                    => Promise<any[]>

        // Browser navigation (controls Playwright window)
        navigate: (url: string) => void
        newTab:   ()            => void

        // Event listeners
        onSidebarUpdated: (cb: (items: any[]) => void) => void
        onThemeChanged:   (cb: (theme: string) => void) => void

        // Settings
        getSettings:  ()        => Promise<any>
        saveSettings: (u: any)  => Promise<any>
    }
}
```

- [ ] **Step 3: Full build — must pass clean**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 4: Build dist**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npx tsc
```

- [ ] **Step 5: Copy HTML files to dist**

```bash
mkdir -p /c/Users/abdim/Desktop/Projects/Luna/dist/renderer
cp /c/Users/abdim/Desktop/Projects/Luna/src/renderer/index.html /c/Users/abdim/Desktop/Projects/Luna/dist/renderer/
cp /c/Users/abdim/Desktop/Projects/Luna/src/renderer/settings.html /c/Users/abdim/Desktop/Projects/Luna/dist/renderer/
```

- [ ] **Step 6: Commit**

```bash
git add src/global.d.ts
git commit -m "feat: update window.luna types for Playwright rewrite"
```

---

## Task 11: Smoke Test

- [ ] **Step 1: Run the app**

```bash
cd /c/Users/abdim/Desktop/Projects/Luna
npm start
```

Expected:
- Electron control panel window opens (slim, ~280px wide)
- Playwright Chromium browser opens separately and loads Google
- No console errors in Electron

- [ ] **Step 2: Test agent creation**
  - Click `+` → Agent → type "Search for cats on Google" → Start
  - Watch the Playwright browser window act on the page
  - Agent card in control panel shows log entries updating live

- [ ] **Step 3: Test automation creation**
  - Click `+` → Automation → type "Go to news.ycombinator.com and wait 2 seconds" → Create
  - Automation card appears with parsed steps
  - Click Run — Playwright browser navigates to HN

- [ ] **Step 4: Fix any issues found, commit fixes**

```bash
git add -A
git commit -m "fix: smoke test fixes"
```

---

## Self-Review

**Spec coverage:**
- Playwright headed mode ✅ (Task 3 — `headless: false`)
- CDP access ✅ (Playwright uses CDP internally; direct CDP session available via `page.context().newCDPSession(page)` if needed)
- Accessibility Tree ✅ (Task 4 — `page.accessibility.snapshot()`)
- Vision + DOM analysis ✅ (Task 5 — screenshot sent as image content part alongside A11y tree)
- Headed (not headless) ✅ (Task 3 — explicitly set)

**No placeholders found** — all steps contain actual code.

**Type consistency check:**
- `ElementInfo` defined in types.ts Task 2, used in page-analyzer.ts Task 4, agent-manager.ts Task 6 ✅
- `AnalyzedPage` defined in types.ts Task 2, returned by `analyzePage()` in Task 4, consumed in Task 6 ✅
- `AgentAction.elementIndex` defined in types.ts Task 2, read in agent-manager.ts Task 6 ✅
- `PlaywrightSession` created in Task 3, injected into `AgentManager` in Task 6, launched in `main.ts` Task 7 ✅
