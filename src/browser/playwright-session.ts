/**
 * playwright-session.ts — Browser lifecycle + HTTP API bridge
 *
 * Architecture:
 *   Node.js runs an HTTP server on localhost:38412.
 *   The Luna Chrome extension side panel connects to this server via fetch + SSE.
 *   Playwright manages the Chromium window with the extension loaded.
 */

import http from 'http'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import { BrowserContext, Page, chromium } from 'playwright'
import { SidebarItem } from '../agents/types'

const HTTP_PORT = 38412

function getSystemColorScheme(): 'dark' | 'light' {
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme',
                { encoding: 'utf8' }
            )
            return out.includes('0x0') ? 'dark' : 'light'
        }
        if (process.platform === 'darwin') {
            const out = execSync('defaults read -g AppleInterfaceStyle 2>/dev/null', { encoding: 'utf8' })
            return out.trim().toLowerCase() === 'dark' ? 'dark' : 'light'
        }
    } catch { /* fallback */ }
    return 'light'
}

// ── LunaHandlers interface ────────────────────────────────────────────────────

export interface LunaHandlers {
    createAgent:      (goal: string, maxSteps?: number)  => Promise<any>
    createAutomation: (desc: string)  => Promise<any>
    runAutomation:    (id: string)    => Promise<void>
    stopAutomation:   (id: string)    => void
    updateAutomation: (id: string, updates: any) => void
    deleteAutomation: (id: string)    => void
    getSidebarItems:  ()              => Promise<any[]>
    navigate:         (url: string)   => void
    newTab:           ()              => void
    getSettings:      ()              => Promise<any>
    saveSettings:     (u: any)        => Promise<any>
    saveApiKey:       (key: string)   => Promise<void>
    sendChat:         (msg: string)   => Promise<string>
    stopAgent:        (id: string)    => void
    pauseAgent:  (id: string) => void
    resumeAgent: (id: string, correction?: string) => void
    // Recorded-click automation replay (human-behavior engine)
    replayRecorded: (steps: any[], loop: boolean) => void
    pauseRecorded:  () => void
    resumeRecorded: () => void
    stopRecorded:   () => void
}

// ── PlaywrightSession ─────────────────────────────────────────────────────────

export class PlaywrightSession {
    private browseContext: BrowserContext | null = null
    private activePage:    Page           | null = null
    private httpServer:    http.Server    | null = null
    private sseClients:    http.ServerResponse[] = []
    private lastReplayStatus: object | null = null

    private chatHistory: Array<{from: string, text: string}> = [
        { from: 'luna', text: "Hi! I'm Luna. Tell me what you'd like to do — search the web, find products, look up information, or set up repeating automations. Just ask in plain English." }
    ]

    async launch(homepage: string, handlers: LunaHandlers): Promise<void> {
        this.startHttpServer(handlers)

        const extensionPath = path.resolve(process.cwd(), 'extension')
        const userDataDir   = path.resolve(process.cwd(), '.playwright-data')

        console.log(`[Luna] Loading extension from: ${extensionPath}`)

        this.browseContext = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
            viewport: null,
            colorScheme: getSystemColorScheme(),
            acceptDownloads: true,
        })

        this.activePage = await this.browseContext.newPage()
        await this.activePage.goto(homepage)

        // Track active page: update when new pages open, fall back when pages close
        this.browseContext.on('page', (page) => {
            this.activePage = page
            page.on('close', () => {
                if (this.activePage === page) {
                    const pages = this.browseContext?.pages() ?? []
                    this.activePage = pages.length > 0 ? pages[pages.length - 1] : null
                }
            })
        })

        // Also track close on the initial page
        this.activePage.on('close', () => {
            if (this.activePage?.isClosed()) {
                const pages = this.browseContext?.pages() ?? []
                this.activePage = pages.length > 0 ? pages[pages.length - 1] : null
            }
        })
    }

    // ── HTTP server ───────────────────────────────────────────────────────────

    private startHttpServer(handlers: LunaHandlers): void {
        this.httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

            // SSE stream for sidebar push updates
            if (req.url === '/api/events' && req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type':  'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection':    'keep-alive',
                })
                this.sseClients.push(res)
                handlers.getSidebarItems().then(items =>
                    this.pushSSE({ type: 'sidebarUpdate', items })
                )
                req.on('close', () => {
                    this.sseClients = this.sseClients.filter(c => c !== res)
                })
                return
            }

            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', async () => {
                try {
                    const data = body ? JSON.parse(body) : {}

                    if (req.url === '/' && req.method === 'GET') {
                        const html = fs.readFileSync(path.resolve(process.cwd(), 'extension/sidepanel.html'))
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length })
                        res.end(html)
                    } else if (req.url === '/sidepanel.js' && req.method === 'GET') {
                        const js = fs.readFileSync(path.resolve(process.cwd(), 'extension/sidepanel.js'))
                        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': js.length })
                        res.end(js)
                    } else if (req.url === '/automations' && req.method === 'GET') {
                        const html = fs.readFileSync(path.resolve(process.cwd(), 'extension/automations.html'))
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length })
                        res.end(html)
                    } else if (req.url === '/automations.js' && req.method === 'GET') {
                        const js = fs.readFileSync(path.resolve(process.cwd(), 'extension/automations.js'))
                        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': js.length })
                        res.end(js)
                    } else if (req.url === '/api/settings' && req.method === 'GET') {
                        this.ok(res, await handlers.getSettings())
                    } else if (req.url === '/api/history' && req.method === 'GET') {
                        this.ok(res, this.chatHistory)
                    } else if (req.url === '/api/sidebar' && req.method === 'GET') {
                        this.ok(res, await handlers.getSidebarItems())
                    } else if (req.url === '/api/replayStatus' && req.method === 'GET') {
                        this.ok(res, this.lastReplayStatus ?? { status: 'idle' })
                    } else if (req.url === '/api/chat' && req.method === 'POST') {
                        const reply = await handlers.sendChat(data.text)
                        this.ok(res, { reply })
                    } else if (req.url === '/api/createAgent' && req.method === 'POST') {
                        const agent = await handlers.createAgent(data.goal, data.maxSteps)
                        this.ok(res, { ok: true, agentId: agent?.id })
                    } else if (req.url === '/api/createAutomation' && req.method === 'POST') {
                        const automation = await handlers.createAutomation(data.description)
                        this.ok(res, { ok: true, automationId: automation?.id })
                    } else if (req.url === '/api/saveApiKey' && req.method === 'POST') {
                        await handlers.saveApiKey(data.key)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/stopAgent' && req.method === 'POST') {
                        handlers.stopAgent(data.agentId)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/pauseAgent' && req.method === 'POST') {
                        handlers.pauseAgent(data.agentId)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/resumeAgent' && req.method === 'POST') {
                        handlers.resumeAgent(data.agentId, data.correction)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/navigate' && req.method === 'POST') {
                        handlers.navigate(data.url)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/newTab' && req.method === 'POST') {
                        handlers.newTab()
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/runAutomation' && req.method === 'POST') {
                        handlers.runAutomation(data.automationId).catch(() => {})
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/stopAutomation' && req.method === 'POST') {
                        handlers.stopAutomation(data.automationId)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/updateAutomation' && req.method === 'POST') {
                        handlers.updateAutomation(data.automationId, data)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/deleteAutomation' && req.method === 'POST') {
                        handlers.deleteAutomation(data.automationId)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/replayRecorded' && req.method === 'POST') {
                        handlers.replayRecorded(data.steps || [], !!data.loop)
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/pauseRecorded' && req.method === 'POST') {
                        handlers.pauseRecorded()
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/resumeRecorded' && req.method === 'POST') {
                        handlers.resumeRecorded()
                        this.ok(res, { ok: true })
                    } else if (req.url === '/api/stopRecorded' && req.method === 'POST') {
                        handlers.stopRecorded()
                        this.ok(res, { ok: true })
                    } else {
                        res.writeHead(404); res.end()
                    }
                } catch (err) {
                    res.writeHead(500); res.end(String(err))
                }
            })
        })

        this.httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
            console.log(`[Luna] HTTP API listening on http://127.0.0.1:${HTTP_PORT}`)
        })
    }

    private pushSSE(data: object): void {
        const msg = `data: ${JSON.stringify(data)}\n\n`
        this.sseClients = this.sseClients.filter(c => {
            try { c.write(msg); return true } catch { return false }
        })
    }

    private ok(res: http.ServerResponse, data: object): void {
        const json = JSON.stringify(data)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
        res.end(json)
    }

    // ── Chat history ──────────────────────────────────────────────────────────

    appendChat(msg: {from: string, text: string}): void {
        this.chatHistory.push(msg)
    }

    // ── Push sidebar updates via SSE ──────────────────────────────────────────

    pushSidebarUpdate(items: SidebarItem[]): void {
        this.pushSSE({ type: 'sidebarUpdate', items })
    }

    // ── Push recorded-replay status via SSE + cache for GET /api/replayStatus ──
    pushReplayStatus(event: object): void {
        this.pushSSE({ type: 'replayStatus', ...event })
        // SSE clients already received the real terminal event; reset the cached
        // value so a panel that loads /api/replayStatus later sees 'idle' rather
        // than a stale 'done'/'stopped'/'failed' from a finished run.
        const status = (event as { status?: string }).status
        const terminal = status === 'done' || status === 'stopped' || status === 'failed'
        this.lastReplayStatus = terminal ? { status: 'idle' } : event
    }

    pushThemeChange(_theme: string): void {}

    // ── Navigation ────────────────────────────────────────────────────────────

    getActivePage(): Page | null {
        return this.activePage
    }

    async navigate(url: string): Promise<void> {
        if (!this.activePage) return
        if (url.startsWith('luna://')) return
        const fullUrl = url.startsWith('http') ? url : `https://${url}`
        await this.activePage.goto(fullUrl, { waitUntil: 'domcontentloaded' })
    }

    async openPage(url: string = 'https://google.com'): Promise<Page> {
        if (!this.browseContext) throw new Error('Browser not launched')
        const page = await this.browseContext.newPage()
        if (this.activePage && !this.activePage.isClosed()) {
            await this.activePage.bringToFront()
        }
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        return page
    }

    async newTab(url: string = 'https://google.com'): Promise<void> {
        if (!this.browseContext) return
        const page = await this.browseContext.newPage()
        await page.goto(url)
        this.activePage = page
    }

    async close(): Promise<void> {
        this.httpServer?.close()
        await this.browseContext?.close()
        this.httpServer    = null
        this.browseContext = null
        this.activePage    = null
    }

    isAlive(): boolean {
        return this.browseContext !== null
    }
}
