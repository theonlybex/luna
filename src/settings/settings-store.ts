/**
 * settings-store.ts — Reads and writes user settings to disk
 *
 * WHERE SETTINGS ARE STORED:
 *   ~/.luna/luna-settings.json — cross-platform user config dir.
 *   Never stored in the project directory (not writable in production).
 *
 * DESIGN: MERGE WITH DEFAULTS
 *   getSettings() spreads DEFAULT_SETTINGS first, then the saved file on top.
 *   New settings added in future versions get their defaults automatically.
 */

import os from 'os'
import fs from 'fs'
import path from 'path'

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
    apiKeys: '',
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

function configDir(): string {
    return path.join(os.homedir(), '.luna')
}

function settingsPath(): string {
    return path.join(configDir(), 'luna-settings.json')
}

export function getSettings(): Settings {
    try {
        const raw = fs.readFileSync(settingsPath(), 'utf-8')
        const saved = JSON.parse(raw)
        return { ...DEFAULT_SETTINGS, ...saved }
    } catch {
        return { ...DEFAULT_SETTINGS }
    }
}

export function saveSettings(updates: Partial<Settings>): Settings {
    const current = getSettings()
    const updated = { ...current, ...updates }
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(updated, null, 2), 'utf-8')
    return updated
}
