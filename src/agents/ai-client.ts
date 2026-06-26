/**
 * ai-client.ts — Claude API communication
 *
 * Page state sent to Claude each step:
 *   1. Body text — main content stripped of nav/ads/boilerplate (Firecrawl technique)
 *   2. Numbered Accessibility Tree — interactive elements Claude can act on by index
 *
 * WHY BODY TEXT + A11Y TREE:
 *   The A11y tree gives structure and indices for interaction. Body text gives Claude
 *   the actual content on the page (prices, descriptions, results) that the A11y tree
 *   ignores because those are non-interactive nodes.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, WebSearchTool20250305 } from '@anthropic-ai/sdk/resources/messages'
import { AgentAction, AutomationStep } from './types'

export type { MessageParam }

let currentKeys: string[] = []
let currentKeyIndex = 0
let currentModel = 'claude-sonnet-4-6'
let fallbackModel = 'claude-haiku-4-5-20251001'

export function setApiKey(key: string): void {
    process.env.ANTHROPIC_API_KEY = key
    currentKeys = [key, ...currentKeys.filter(k => k !== key)]
    currentKeyIndex = 0
}

export function setApiKeys(keys: string[]): void {
    const deduped = [...new Set(keys.filter(Boolean))]
    if (deduped.length === 0) return
    currentKeys = deduped
    currentKeyIndex = 0
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

    let lastErr: unknown
    for (let i = 0; i < keys.length; i++) {
        const idx = (currentKeyIndex + i) % keys.length
        try {
            const result = await fn(getClient(idx), model)
            currentKeyIndex = idx
            return result
        } catch (err) {
            lastErr = err
            if (isRateLimit(err)) continue
            if (isAuthError(err) && i < keys.length - 1) continue
            break
        }
    }

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

const AGENT_SYSTEM_PROMPT = `You are a browser automation agent inside the Luna browser.
You receive the page's content organized by visual prominence AND a numbered list of interactive elements visible on screen.
You also see the full history of your previous decisions — use it to avoid repeating yourself.
Choose your next single action to accomplish the user's goal.

Page content format:
- Content is grouped into HEADINGS (large/bold text), MAIN CONTENT, and DETAILS (fine print)
- Lines marked with ▸ are above the fold (currently visible to the user)
- Content is sorted by visual prominence — the most important/visible text appears first
- Focus on HEADINGS and MAIN CONTENT for key information; DETAILS contains fine print

Respond ONLY with valid JSON:
{
  "action": "navigate" | "click" | "type" | "scroll" | "go_back" | "wait" | "search" | "done",
  "elementIndex": <number from the list below, for click/type only>,
  "url": "<full https:// URL, for navigate only>",
  "text": "<text to enter for type, or search query for search>",
  "scrollDirection": "up" | "down",
  "reason": "<one-line explanation under 80 chars>",
  "isDone": true | false
}

Rules:
- click: set elementIndex to the number in [brackets] from the element list
- type: set elementIndex AND text
- navigate: set url (must start with https://)
- scroll: set scrollDirection — new elements appear in the next step
- search: set text to your search query — use this for research, current info, prices, reviews, news. Faster and cheaper than navigating to Google.
- done: set isDone=true when the goal is accomplished
- Raw JSON only — no markdown, no code fences`

const WEB_SEARCH_TOOL: WebSearchTool20250305 = { type: 'web_search_20250305', name: 'web_search' }

/**
 * webSearch — calls Claude with the built-in web_search tool.
 *
 * Anthropic executes the search server-side and returns the answer with citations
 * in a single API call. No browser navigation, no Playwright, no extra cost beyond
 * the search fee ($10/1000 searches) + standard tokens.
 *
 * Returns Claude's synthesized answer as plain text with source citations inline.
 */
export async function webSearch(query: string): Promise<string> {
    try {
        const response = await callWithRotation((client, model) => client.messages.create({
            model,
            max_tokens: 1024,
            tools: [WEB_SEARCH_TOOL],
            messages: [{
                role: 'user',
                content: `Search the web for: ${query}\n\nGive a concise, factual answer with source citations.`
            }]
        }))

        const text = response.content
            .filter(block => block.type === 'text')
            .map(block => (block as any).text as string)
            .join('\n')
            .trim()

        // Extract source URLs from web_search_tool_result blocks
        const sources: string[] = []
        for (const block of response.content) {
            if (block.type === 'web_search_tool_result') {
                const results = (block as any).content
                if (Array.isArray(results)) {
                    for (const r of results) {
                        if (r.type === 'web_search_result' && r.url && r.title) {
                            sources.push(`- ${r.title}: ${r.url}`)
                        }
                    }
                }
            }
        }

        const sourcesSection = sources.length > 0 ? `\n\nSources:\n${sources.join('\n')}` : ''
        return (text || '(Search returned no answer)') + sourcesSection
    } catch (err) {
        return `Search failed: ${String(err).slice(0, 120)}`
    }
}

const MAX_HISTORY_TURNS = 8

export function estimateTokens(messages: MessageParam[]): number {
    return Math.ceil(JSON.stringify(messages).length / 4)
}

const COMPACTION_TOKEN_THRESHOLD = 50_000
const RECENT_TURNS_KEEP          = 6

export async function compactHistory(
    goal: string,
    history: MessageParam[]
): Promise<MessageParam[]> {
    if (estimateTokens(history) < COMPACTION_TOKEN_THRESHOLD) return history

    const keepCount    = RECENT_TURNS_KEEP * 2
    const toSummarize  = history.slice(0, -keepCount)
    const toKeep       = history.slice(-keepCount)

    if (toSummarize.length === 0) return history

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

        return [
            { role: 'user',      content: `[Context summary of earlier steps]\n${summary}` },
            { role: 'assistant', content: 'Understood. Continuing from current state.' },
            ...toKeep
        ]
    } catch {
        return toKeep
    }
}

const MAX_PARSE_RETRIES    = 2
const MAX_PLANNING_RETRIES = 2
const MAX_REASONING_RETRIES = 2
const MAX_EMPTY_RETRIES     = 1

const REASONING_ONLY_RETRY =
    "The previous response described the page state without taking an action. " +
    "Stop observing. Act now: respond ONLY with the JSON action object."

const EMPTY_RESPONSE_RETRY =
    "The previous response was empty. " +
    "Respond ONLY with a single valid JSON action object. No explanation."

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
    if (raw.trimStart().startsWith('{')) return false
    if (raw.length > 800) return false
    if (raw.includes('```')) return false
    return PLANNING_PROMISE_RE.test(raw) || PLANNING_HEADING_RE.test(raw) || PLANNING_BULLET_RE.test(raw)
}

const REASONING_OBSERVE_RE = /\b(?:i (?:can )?see|i notice|i observe|the page (?:shows|displays|contains|has)|there (?:is|are|appears?)|it appears?|looking at|i(?:'m| am) looking)\b/i

function isReasoningOnlyResponse(raw: string): boolean {
    if (raw.trimStart().startsWith('{')) return false
    if (raw.length > 600) return false
    if (raw.includes('```')) return false
    if (isPlanningOnlyResponse(raw)) return false  // already handled
    return REASONING_OBSERVE_RE.test(raw)
}

function isEmptyResponse(raw: string): boolean {
    return raw.trim().length === 0
}

/**
 * askAgentWhatToDo — vision-enabled agent decision with persistent conversation history.
 *
 * Accepts the growing messages[] from previous turns so Claude remembers every
 * page it saw, every action it took, and every outcome — no more repeating itself.
 * Returns both the action and the updated history to pass into the next turn.
 */
export async function askAgentWhatToDo(
    goal: string,
    url: string,
    title: string,
    accessibilityTree: string,
    bodyText: string,
    history: MessageParam[],
    lastActionOutcome?: string,
    structuredContent?: string
): Promise<{ action: AgentAction; history: MessageParam[] }> {

    // Prefer structured content (visual hierarchy) over flat bodyText
    const pageContent = structuredContent || bodyText || '(no readable content)'

    const baseUserContent: MessageParam['content'] = [
        {
            type: 'text',
            text: `${lastActionOutcome ? `Previous action result: ${lastActionOutcome}\n\n` : ''}URL: ${url}\nTitle: ${title}\n\nPage content:\n${pageContent}\n\nVisible interactive elements:\n${accessibilityTree}\n\nGoal: "${goal}"\nWhat is the next single action? JSON only.`
        }
    ]

    const cappedHistory = history.slice(-(MAX_HISTORY_TURNS * 2))
    let messages: MessageParam[] = [...cappedHistory, { role: 'user', content: baseUserContent }]
    let planningRetries  = 0
    let parseRetries     = 0
    let reasoningRetries = 0
    let emptyRetries     = 0

    while (true) {
        const response = await callWithRotation((client, model) => client.messages.create({
            model,
            max_tokens: 1024,
            system: [{ type: 'text', text: AGENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages
        }))

        const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : ''

        // ── Empty response ────────────────────────────────────────────────────
        if (isEmptyResponse(raw) && emptyRetries < MAX_EMPTY_RETRIES) {
            emptyRetries++
            messages = [
                ...messages,
                { role: 'assistant', content: '...' },
                { role: 'user',      content: EMPTY_RESPONSE_RETRY }
            ]
            continue
        }

        // ── Reasoning-only response ───────────────────────────────────────────
        if (isReasoningOnlyResponse(raw) && reasoningRetries < MAX_REASONING_RETRIES) {
            reasoningRetries++
            messages = [
                ...messages,
                { role: 'assistant', content: raw },
                { role: 'user',      content: REASONING_ONLY_RETRY }
            ]
            continue
        }

        // ── Planning-only response ────────────────────────────────────────────
        if (isPlanningOnlyResponse(raw) && planningRetries < MAX_PLANNING_RETRIES) {
            planningRetries++
            messages = [
                ...messages,
                { role: 'assistant', content: raw },
                { role: 'user',      content: PLANNING_ONLY_RETRY }
            ]
            continue
        }

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
            action = { action: 'done', reason: `Response unparseable after ${MAX_PARSE_RETRIES} retries`, isDone: true }
        }

        const updatedHistory: MessageParam[] = [...messages, { role: 'assistant', content: raw }]
        return { action, history: updatedHistory }
    }
}

/**
 * askAgentForFinalAnswer — after the agent finishes browsing, asks Claude to
 * synthesize a direct answer to the user's goal from the final page state.
 */
export async function askAgentForFinalAnswer(
    goal: string,
    url: string,
    title: string,
    accessibilityTree: string,
    bodyText: string,
    actionLog: string[],
    structuredContent?: string
): Promise<string> {
    const log = actionLog.map((a, i) => `${i + 1}. ${a}`).join('\n')
    try {
        const response = await callWithRotation((client, model) => client.messages.create({
            model,
            max_tokens: 512,
            system: `You are Luna, a browser assistant. The user gave you a goal and you have finished browsing.
Based on what you found, give a clear, direct answer to the user's goal in plain English.
Be specific — name the exact item, price, link, or fact you found. Keep it under 4 sentences.`,
            messages: [{
                role: 'user',
                content: `Goal: "${goal}"\n\nSteps taken:\n${log}\n\nCurrent page: ${url} — ${title}\n\nPage content:\n${structuredContent || bodyText || accessibilityTree}\n\nWhat is the direct answer to the user's goal?`
            }]
        }))
        return response.content[0].type === 'text' ? response.content[0].text.trim() : 'Task completed.'
    } catch {
        return 'Task completed.'
    }
}

/**
 * parseUserIntent — classifies a plain-English chat message into an action type,
 * extracts the goal/description, and returns a friendly reply for the chat UI.
 */
export async function parseUserIntent(message: string): Promise<{
    type: 'agent' | 'automation' | 'unknown'
    goal?: string
    description?: string
    reply: string
}> {
    try {
        const response = await callWithRotation((client, model) => client.messages.create({
            model,
            max_tokens: 256,
            system: `You are Luna, a friendly AI browser assistant. Users send you chat messages.
Classify their intent and compose a short reply.

Respond ONLY with valid JSON:
{
  "type": "agent" | "automation" | "unknown",
  "goal": "<concise goal, if type=agent>",
  "description": "<step description, if type=automation>",
  "reply": "<1-2 sentence friendly reply telling the user what you are doing>"
}

- agent: one-time browsing task ("find me a new iPhone", "check the weather", "look up flights to Paris")
- automation: scripted repeating sequence ("every day open gmail and check unread", "go to reddit and click top post")
- unknown: conversation with no actionable task

Raw JSON only, no markdown.`,
            messages: [{ role: 'user', content: message }]
        }))
        const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}'
        const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim()
        return JSON.parse(cleaned)
    } catch {
        return { type: 'unknown', reply: "I didn't quite catch that. Try asking me to find something or set up an automation." }
    }
}

/**
 * testApiKey — makes a minimal 1-token call to verify the key works and credits are available.
 * Uses the cheapest model to avoid burning credits.
 */
export async function testApiKey(): Promise<{ ok: boolean; error?: string }> {
    try {
        await callWithRotation((client) => client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }]
        }))
        return { ok: true }
    } catch (err: any) {
        return { ok: false, error: err.message ?? String(err) }
    }
}

/**
 * parseAutomationSteps — convert plain-English description into structured steps.
 */
export async function parseAutomationSteps(description: string): Promise<AutomationStep[]> {
    const response = await callWithRotation((client, model) => client.messages.create({
        model,
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
    }))

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
