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
    finalAnswer?: string
    // No tabIndex — Playwright manages the active page directly
}

export type AgentStatus = 'thinking' | 'running' | 'waiting' | 'done' | 'error' | 'stopped'

// ─── Automation ──────────────────────────────────────────────────────────────

export interface Automation {
    id: string
    type: 'automation'
    description: string
    steps: AutomationStep[]
    isRunning: boolean
    repeatInterval: number
    stopOnError?: boolean
    lastRun?: number
    extractedValues?: Record<string, any>
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
    status?: 'pending' | 'running' | 'done' | 'error' | 'skipped'
    result?: any
    error?: any
    extractAs?: string
    waitFor?: {
        selector?: string
        text?: string
        url?: string
        timeoutMs?: number
    }
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
    action: 'navigate' | 'click' | 'type' | 'scroll' | 'go_back' | 'wait' | 'search' | 'done'
    elementIndex?: number        // index from A11y tree (for click/type)
    url?: string                 // for navigate
    text?: string                // for type or search query
    scrollDirection?: 'up' | 'down'  // for scroll
    reason: string               // shown in sidebar log
    isDone: boolean
}

// ─── Page State ──────────────────────────────────────────────────────────────

/**
 * ContentBlock — a scored content fragment from page extraction.
 *
 * Each block is scored by visual prominence: fontSize × fontWeight × screenArea.
 * Blocks are sorted by score descending, so the AI sees what the user sees first.
 */
export interface ContentBlock {
    text: string               // trimmed text content of the block
    tag: 'HEADING' | 'CONTENT' | 'DETAIL' | 'NAV'  // visual category
    weight: number             // visual prominence score (higher = more visible on page)
    aboveFold: boolean         // true if the element is within the viewport
}

/**
 * AnalyzedPage — the full page state snapshot sent to Claude each loop iteration.
 *
 * bodyText: readable page content (boilerplate stripped, main content only) — kept as fallback
 * structuredContent: visually-ranked, tagged content blocks (preferred over bodyText)
 * accessibilityTree: numbered flat list of interactive elements — Claude targets by index
 * elementMap: maps index → {role, name} for Playwright to act on
 */
export interface AnalyzedPage {
    url: string
    title: string
    bodyText: string              // clean readable text from main content area (fallback)
    structuredContent: string     // visual-hierarchy-ranked content with [HEADING]/[CONTENT]/[DETAIL] tags
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
