import { randomUUID } from 'crypto'
import { Agent, AgentAction, Automation, AutomationStep, SidebarItem } from './types'
import { askAgentWhatToDo, askAgentForFinalAnswer, parseAutomationSteps, compactHistory, estimateTokens, webSearch, type MessageParam } from './ai-client'
import { PlaywrightSession } from '../browser/playwright-session'
import { analyzePage, actOnElement } from '../browser/page-analyzer'

const RATE_LIMIT_STRINGS = ['rate_limit', 'rate limit', '429', 'quota exceeded', 'too many requests']
const TIMEOUT_STRINGS    = ['timeout', 'etimedout', 'econnreset', 'enotfound', 'socket hang up']

type ErrorClass = 'rate_limit' | 'timeout' | 'auth' | 'unknown'

function classifyApiError(err: unknown): ErrorClass {
    const msg = String((err as any)?.message ?? err).toLowerCase()
    if (RATE_LIMIT_STRINGS.some(s => msg.includes(s))) return 'rate_limit'
    if (TIMEOUT_STRINGS.some(s => msg.includes(s)))    return 'timeout'
    if (msg.includes('401') || msg.includes('403') || (msg.includes('invalid') && msg.includes('key'))) return 'auth'
    return 'unknown'
}

const DEFAULT_MAX_AGENT_STEPS = 10

function interpolate(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
}

export class AgentManager {
    private items: SidebarItem[] = []
    private cancelledAgents = new Set<string>()
    private agentPages = new Map<string, import('playwright').Page[]>()
    private agentHistories = new Map<string, MessageParam[]>()
    private automationSchedules = new Map<string, NodeJS.Timeout>()
    private pausedAgents    = new Set<string>()
    private correctionQueue = new Map<string, string>()

    constructor(
        private playwrightSession: PlaywrightSession,
        private broadcast: (items: SidebarItem[]) => void
    ) {}

    stopAgent(agentId: string): void {
        const agent = this.items.find(i => i.id === agentId && i.type === 'agent') as Agent | undefined
        if (!agent) return
        this.cancelledAgents.add(agentId)
        agent.status = 'stopped'
        agent.log.push('Stopped by user')
        this.broadcastUpdate()
    }

    pauseAgent(agentId: string): void {
        const agent = this.items.find(i => i.id === agentId && i.type === 'agent') as Agent | undefined
        if (!agent || agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped') return
        this.pausedAgents.add(agentId)
        agent.status = 'waiting'
        agent.log.push('Paused by user')
        this.broadcastUpdate()
    }

    resumeAgent(agentId: string, correction?: string): void {
        const agent = this.items.find(i => i.id === agentId && i.type === 'agent') as Agent | undefined
        if (!agent || agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped') return
        if (correction?.trim()) {
            this.correctionQueue.set(agentId, correction.trim())
        }
        this.pausedAgents.delete(agentId)
        agent.status = 'running'
        agent.log.push('Resumed')
        this.broadcastUpdate()
    }

    // ── Page pool helpers ─────────────────────────────────────────────────────

    private trackPage(agentId: string, page: import('playwright').Page): void {
        const pool = this.agentPages.get(agentId) ?? []
        pool.push(page)
        this.agentPages.set(agentId, pool)

        page.on('popup', (popup) => { this.trackPage(agentId, popup) })
        page.on('close', () => {
            const current = this.agentPages.get(agentId) ?? []
            this.agentPages.set(agentId, current.filter(p => p !== page))
        })
    }

    private getActivePage(agentId: string): import('playwright').Page | null {
        const pool = this.agentPages.get(agentId) ?? []
        for (let i = pool.length - 1; i >= 0; i--) {
            if (!pool[i].isClosed()) return pool[i]
        }
        return null
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

        this.playwrightSession.openPage('https://google.com').then(page => {
            this.trackPage(agent.id, page)
            return this.runAgentLoop(agent, maxSteps)
        }).catch(err => {
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
            repeatInterval: 0,
            stopOnError: true,
        }

        this.items.push(automation)
        this.broadcastUpdate()

        try {
            automation.steps = await parseAutomationSteps(description)
        } catch (err) {
            this.items = this.items.filter(i => i.id !== automation.id)
            this.broadcastUpdate()
            throw err
        }
        this.broadcastUpdate()

        return automation
    }

    async runAutomation(automationId: string): Promise<void> {
        const automation = this.findAutomation(automationId)
        if (!automation || automation.isRunning) return

        const page = this.playwrightSession.getActivePage()
        if (!page) return

        automation.isRunning = true
        automation.lastRun = Date.now()
        automation.extractedValues = {}

        for (const step of automation.steps) {
            step.status = 'pending'
            step.result = undefined
            step.error = undefined
        }
        this.broadcastUpdate()

        for (const step of automation.steps) {
            if (!automation.isRunning) break

            step.status = 'running'
            this.broadcastUpdate()

            const { ok, result } = await this.executeStep(step, automation.extractedValues)

            if (ok) {
                step.status = 'done'
                if (result !== undefined) {
                    step.result = result
                    if (step.extractAs) {
                        automation.extractedValues[step.extractAs] = result
                    }
                }
            } else {
                step.status = 'error'
                step.error = result
                this.broadcastUpdate()
                if (automation.stopOnError) break
            }

            this.broadcastUpdate()
            await this.sleep(500)
        }

        // Mark any remaining pending steps as skipped
        for (const step of automation.steps) {
            if (step.status === 'pending') step.status = 'skipped'
        }

        automation.isRunning = false
        this.broadcastUpdate()

        // Schedule next run if repeat is configured and not manually stopped
        if (automation.repeatInterval > 0 && !this.automationSchedules.has(automationId)) {
            const timer = setInterval(() => this.runAutomation(automationId), automation.repeatInterval)
            this.automationSchedules.set(automationId, timer)
        }
    }

    stopAutomation(automationId: string): void {
        const automation = this.findAutomation(automationId)
        if (!automation) return
        automation.isRunning = false
        const timer = this.automationSchedules.get(automationId)
        if (timer) {
            clearInterval(timer)
            this.automationSchedules.delete(automationId)
        }
        this.broadcastUpdate()
    }

    updateAutomation(automationId: string, updates: Partial<Pick<Automation, 'description' | 'steps' | 'repeatInterval' | 'stopOnError'>>): void {
        const automation = this.findAutomation(automationId)
        if (!automation) return
        if (updates.description   !== undefined) automation.description   = updates.description
        if (updates.steps         !== undefined) automation.steps         = updates.steps
        if (updates.repeatInterval !== undefined) automation.repeatInterval = updates.repeatInterval
        if (updates.stopOnError   !== undefined) automation.stopOnError   = updates.stopOnError
        this.broadcastUpdate()
    }

    deleteAutomation(automationId: string): void {
        this.stopAutomation(automationId)
        this.items = this.items.filter(i => i.id !== automationId)
        this.broadcastUpdate()
    }

    getItems(): SidebarItem[] {
        return this.items
    }

    // ── Agent Loop ────────────────────────────────────────────────────────────

    private async runAgentLoop(agent: Agent, maxSteps: number): Promise<void> {
        agent.status = 'running'
        this.broadcastUpdate()
        console.log(`\n[Agent ${agent.id.slice(0,8)}] Starting — goal: "${agent.goal}"`)

        this.agentHistories.set(agent.id, [])
        await this.sleep(1000)

        const ceiling = maxSteps === 0 ? Infinity : maxSteps
        let step = 0
        let apiRetries = 0
        const MAX_API_RETRIES = 3

        // Loop detection — tracks recent (url|action|target) keys
        const recentActionKeys: string[] = []
        const LOOP_WINDOW = 3
        let lastActionOutcome: string | undefined

        const recordAndDetectLoop = (url: string, act: AgentAction): boolean => {
            const key = `${url}|${act.action}|${act.elementIndex ?? act.url ?? ''}`
            recentActionKeys.push(key)
            if (recentActionKeys.length > LOOP_WINDOW + 2) recentActionKeys.shift()
            return recentActionKeys.length >= LOOP_WINDOW &&
                   recentActionKeys.slice(-LOOP_WINDOW).every(k => k === key)
        }

        while (true) {
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

            // ── Ceiling guard ──────────────────────────────────────────────────
            if (step >= ceiling) {
                const lastPage = this.getActivePage(agent.id)
                if (lastPage) {
                    try {
                        const snap = await analyzePage(lastPage)
                        agent.finalAnswer = await askAgentForFinalAnswer(
                            agent.goal, snap.url, snap.title,
                            snap.accessibilityTree, snap.bodyText, agent.log,
                            snap.structuredContent
                        )
                    } catch { /* best-effort */ }
                }
                agent.status = 'done'
                agent.log.push(`Reached ${maxSteps}-step ceiling`)
                this.agentHistories.delete(agent.id)
                this.agentPages.delete(agent.id)
                this.pausedAgents.delete(agent.id)
                this.correctionQueue.delete(agent.id)
                this.broadcastUpdate()
                return
            }

            // ── Cancellation check ─────────────────────────────────────────────
            if (this.cancelledAgents.has(agent.id)) {
                this.cancelledAgents.delete(agent.id)
                agent.status = 'stopped'
                this.agentHistories.delete(agent.id)
                this.agentPages.delete(agent.id)
                this.pausedAgents.delete(agent.id)
                this.correctionQueue.delete(agent.id)
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
                this.pausedAgents.delete(agent.id)
                this.correctionQueue.delete(agent.id)
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
                this.pausedAgents.delete(agent.id)
                this.correctionQueue.delete(agent.id)
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
                    analyzed.bodyText,
                    history,
                    lastActionOutcome,
                    analyzed.structuredContent
                )
                action = result.action
                this.agentHistories.set(agent.id, result.history)
                apiRetries = 0
                console.log(`[Agent ${agent.id.slice(0,8)}] Claude → action: ${action.action} | reason: ${action.reason}`)
            } catch (err) {
                const kind = classifyApiError(err)

                if (kind === 'rate_limit' && apiRetries < MAX_API_RETRIES) {
                    apiRetries++
                    const delay = apiRetries * 2000
                    agent.log.push(`[retry] Rate limited — waiting ${delay / 1000}s (attempt ${apiRetries}/${MAX_API_RETRIES})`)
                    this.broadcastUpdate()
                    await this.sleep(delay)
                    continue
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
                    this.pausedAgents.delete(agent.id)
                    this.correctionQueue.delete(agent.id)
                    this.broadcastUpdate()
                    return
                }

                agent.status = 'error'
                agent.log.push(`API error (${kind}): ${err}`)
                this.agentHistories.delete(agent.id)
                this.agentPages.delete(agent.id)
                this.pausedAgents.delete(agent.id)
                this.correctionQueue.delete(agent.id)
                this.broadcastUpdate()
                return
            }

            agent.log.push(`[${action.action}] ${action.reason}`)
            this.broadcastUpdate()

            // ── Done signal ────────────────────────────────────────────────────
            if (action.isDone || action.action === 'done') {
                agent.finalAnswer = await askAgentForFinalAnswer(
                    agent.goal, analyzed.url, analyzed.title,
                    analyzed.accessibilityTree, analyzed.bodyText, agent.log,
                    analyzed.structuredContent
                )
                agent.status = 'done'
                this.agentHistories.delete(agent.id)
                this.agentPages.delete(agent.id)
                this.pausedAgents.delete(agent.id)
                this.correctionQueue.delete(agent.id)
                this.broadcastUpdate()
                console.log(`[Agent ${agent.id.slice(0,8)}] Done after ${step+1} step(s)`)
                return
            }

            // ── Loop detection ─────────────────────────────────────────────────
            if (recordAndDetectLoop(analyzed.url, action)) {
                agent.log.push(`[stuck] Same action repeated ${LOOP_WINDOW}x — intervening`)
                this.broadcastUpdate()
                const stuckMsg = `The last ${LOOP_WINDOW} actions were identical (${action.action} at ${analyzed.url}). This approach is not working. Try something completely different.`
                const currentHistory = this.agentHistories.get(agent.id) ?? []
                this.agentHistories.set(agent.id, [
                    ...currentHistory,
                    { role: 'user',      content: stuckMsg },
                    { role: 'assistant', content: 'Understood. I will try a different approach.' }
                ])
                lastActionOutcome = undefined
                step++
                continue
            }

            // ── Execute action + capture outcome ───────────────────────────────
            lastActionOutcome = await this.executeAgentAction(page, action, analyzed.elementMap)
            await this.sleep(1500)
            step++
        }
    }

    // ── Action Execution ──────────────────────────────────────────────────────

    private async executeAgentAction(page: any, action: any, elementMap: any[]): Promise<string> {
        try {
            switch (action.action) {
                case 'navigate':
                    if (action.url) {
                        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
                        return `Navigated to ${action.url} — now at: ${page.url()}`
                    }
                    return 'Navigate: no URL provided'
                case 'click':
                    if (action.elementIndex !== undefined) {
                        await actOnElement(page, action.elementIndex, elementMap, 'click')
                        return `Clicked element [${action.elementIndex}]. Page is now: ${page.url()}`
                    }
                    return 'Click: no element index provided'
                case 'type':
                    if (action.elementIndex !== undefined && action.text !== undefined) {
                        await actOnElement(page, action.elementIndex, elementMap, 'type', action.text)
                        return `Typed "${action.text}" into element [${action.elementIndex}]`
                    }
                    return 'Type: missing element or text'
                case 'scroll': {
                    const dy = action.scrollDirection === 'up' ? -500 : 500
                    await page.evaluate((d: number) => window.scrollBy(0, d), dy)
                    return `Scrolled ${action.scrollDirection ?? 'down'}`
                }
                case 'search': {
                    const query = action.text?.trim()
                    if (!query) return 'Search: no query provided'
                    const result = await webSearch(query)
                    return `Search results for "${query}":\n${result}`
                }
                case 'go_back':
                    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
                    return `Went back — now at: ${page.url()}`
                case 'wait':
                    await this.sleep(2000)
                    return 'Waited 2 seconds'
                default:
                    return `Unknown action: ${action.action}`
            }
        } catch (err) {
            console.warn(`[AgentManager] Action "${action.action}" failed:`, err)
            return `Action "${action.action}" failed: ${String(err).slice(0, 120)}`
        }
    }

    // Returns { ok, result? } — result is the extracted text for 'extract' steps
    private async executeStep(step: AutomationStep, vars: Record<string, string>): Promise<{ ok: boolean; result?: string }> {
        const page = this.playwrightSession.getActivePage()
        if (!page) return { ok: false, result: 'No active page' }

        const target = interpolate(step.target, vars)
        const value  = step.value ? interpolate(step.value, vars) : undefined

        try {
            switch (step.action) {
                case 'navigate':
                    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    break

                case 'click':
                    await page.getByRole('button', { name: target }).first().click({ timeout: 5000 })
                        .catch(() => page.getByText(target).first().click({ timeout: 5000 }))
                    break

                case 'type':
                    await page.getByLabel(target).first().fill(value || '', { timeout: 5000 })
                        .catch(() => page.getByPlaceholder(target).first().fill(value || '', { timeout: 5000 }))
                    break

                case 'wait':
                    if (step.waitFor?.selector) {
                        await page.locator(step.waitFor.selector).first()
                            .waitFor({ state: 'visible', timeout: step.waitFor.timeoutMs ?? 10000 })
                    } else if (step.waitFor?.text) {
                        await page.getByText(step.waitFor.text).first()
                            .waitFor({ state: 'visible', timeout: step.waitFor.timeoutMs ?? 10000 })
                    } else if (step.waitFor?.url) {
                        await page.waitForURL(`**${step.waitFor.url}**`, { timeout: step.waitFor.timeoutMs ?? 10000 })
                    } else {
                        await this.sleep(parseInt(target) || 1000)
                    }
                    break

                case 'extract': {
                    let text: string | null = null
                    // Try CSS selector first, then visible text search
                    try {
                        text = await page.locator(target).first().textContent({ timeout: 3000 })
                    } catch {
                        try {
                            text = await page.getByText(target).first().textContent({ timeout: 3000 })
                        } catch { /* no match */ }
                    }
                    return { ok: true, result: text?.trim() ?? '(not found)' }
                }

                case 'scroll': {
                    const dy = target === 'up' ? -500 : 500
                    await page.evaluate((d: number) => window.scrollBy(0, d), dy)
                    break
                }
            }
            return { ok: true }
        } catch (err) {
            return { ok: false, result: String(err) }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private findAutomation(id: string): Automation | undefined {
        return this.items.find(
            item => item.id === id && item.type === 'automation'
        ) as Automation | undefined
    }

    private broadcastUpdate(): void {
        this.broadcast(this.items)
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
