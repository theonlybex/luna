/**
 * app.ts — Luna entry point (pure Node.js, no Electron)
 *
 * Single Chromium window. The Luna panel is injected as a sliding overlay
 * into every browsed page — no separate panel window needed.
 */

import fs from 'fs'
import path from 'path'
import { PlaywrightSession } from './browser/playwright-session'
import { AgentManager } from './agents/agent-manager'
import { RecordedAutomationManager } from './automation/recorded-automation-manager'
import { getSettings, saveSettings } from './settings/settings-store'
import { setApiKey, setApiKeys, setModel, setFallbackModel, testApiKey, parseUserIntent } from './agents/ai-client'

const ENV_PATH = path.join(process.cwd(), '.env')

function loadDotEnv(): void {
    try {
        const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n')
        for (const line of lines) {
            const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
            if (match) process.env[match[1]] = match[2].trim()
        }
    } catch { /* .env doesn't exist yet */ }
}

function writeEnvKey(key: string, value: string): void {
    let content = ''
    try { content = fs.readFileSync(ENV_PATH, 'utf-8') } catch { /* new file */ }
    const re = new RegExp(`^${key}=.*$`, 'm')
    const line = `${key}=${value}`
    content = re.test(content) ? content.replace(re, line) : content + (content.endsWith('\n') || !content ? '' : '\n') + line + '\n'
    fs.writeFileSync(ENV_PATH, content, 'utf-8')
}

async function main(): Promise<void> {
    loadDotEnv()

    const settings = getSettings()
    const apiKey = process.env.ANTHROPIC_API_KEY || settings.apiKey
    const extraKeys = settings.apiKeys
        ? settings.apiKeys.split(',').map(k => k.trim()).filter(Boolean)
        : []
    setApiKeys([...(apiKey ? [apiKey] : []), ...extraKeys])

    if (apiKey) {
        setApiKey(apiKey)
        const masked = `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`
        console.log(`[Luna] API key loaded: ${masked} (model: ${settings.aiModel})`)
        const test = await testApiKey()
        if (test.ok) {
            console.log('[Luna] API key OK — reachable and credits available')
        } else {
            console.warn(`[Luna] API key FAILED: ${test.error}`)
        }
    } else {
        console.log('[Luna] No API key found — panel modal will prompt on first use')
    }
    setModel(settings.aiModel)
    setFallbackModel(settings.fallbackModel || '')

    const session = new PlaywrightSession()
    const manager = new AgentManager(session, (items) => session.pushSidebarUpdate(items))
    const recordedManager = new RecordedAutomationManager(
        () => session.getActivePage(),
        (event) => session.pushReplayStatus(event)
    )

    const close = async () => { await session.close(); process.exit(0) }
    process.once('SIGINT',  close)
    process.once('SIGTERM', close)

    await session.launch(settings.homepage, {
        createAgent:      (goal: string, maxSteps?: number) => manager.createAgent(goal, maxSteps ?? getSettings().maxAgentSteps),
        createAutomation: (desc: string) => manager.createAutomation(desc),
        runAutomation:    (id: string)   => manager.runAutomation(id),
        stopAutomation:   (id: string)   => { manager.stopAutomation(id) },
        updateAutomation: (id: string, updates: any) => { manager.updateAutomation(id, updates) },
        deleteAutomation: (id: string)   => { manager.deleteAutomation(id) },
        getSidebarItems:  ()             => Promise.resolve(manager.getItems()),
        navigate:         (url: string)  => { session.navigate(url) },
        newTab:           ()             => { session.newTab() },
        getSettings: () => {
            const s = getSettings()
            // Env var takes priority; if key isn't saved in settings file, reflect it so the
            // panel doesn't show the API key modal when the key is already working.
            if (!s.apiKey && process.env.ANTHROPIC_API_KEY) {
                return Promise.resolve({ ...s, apiKey: process.env.ANTHROPIC_API_KEY })
            }
            return Promise.resolve(s)
        },
        saveSettings:     (updates: any) => {
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
            if (updates.aiModel      !== undefined) setModel(updates.aiModel)
            if (updates.fallbackModel !== undefined) setFallbackModel(updates.fallbackModel)
            return Promise.resolve(saved)
        },
        saveApiKey: (key: string) => {
            saveSettings({ apiKey: key })
            setApiKey(key)
            writeEnvKey('ANTHROPIC_API_KEY', key)
            return Promise.resolve()
        },
        stopAgent: (id: string) => { manager.stopAgent(id) },
        pauseAgent:  (id: string)                      => { manager.pauseAgent(id) },
        resumeAgent: (id: string, correction?: string) => { manager.resumeAgent(id, correction) },
        replayRecorded: (steps: any[], loop: boolean) => { recordedManager.start(steps, loop) },
        pauseRecorded:  () => { recordedManager.pause() },
        resumeRecorded: () => { recordedManager.resume() },
        stopRecorded:   () => { recordedManager.stop() },
        sendChat: async (message: string) => {
            session.appendChat({ from: 'user', text: message })
            const intent = await parseUserIntent(message)
            if (intent.type === 'agent' && intent.goal) {
                manager.createAgent(intent.goal, getSettings().maxAgentSteps)
            } else if (intent.type === 'automation' && intent.description) {
                manager.createAutomation(intent.description)
            }
            session.appendChat({ from: 'luna', text: intent.reply })
            return intent.reply
        }
    })

    console.log('[Luna] Ready')
}

main().catch(err => { console.error('[Luna] Fatal:', err); process.exit(1) })
