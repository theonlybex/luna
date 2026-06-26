/**
 * step-verifier.ts — Deterministic "did the step take effect?" checks.
 *
 * Runs after a step is acted on, reading state back through Playwright. No AI,
 * no network. For value-bearing steps (type/select/scroll) the read-back is
 * authoritative. For click/keypress the act itself is the primary proof (a
 * Playwright click throws if the element isn't actionable/landable); the
 * page-change signal here is corroboration, so absence of change is a lenient
 * pass rather than a failure.
 */

import { Page, Locator } from 'playwright'
import { RecordedStep, VerifyResult } from './recorded-types'

export interface Fingerprint {
    url: string
    domSize: number
    active: string
}

/** Cheap pre-action snapshot used to detect change after click/keypress. */
export async function snapshot(page: Page): Promise<Fingerprint> {
    try {
        return await page.evaluate(() => ({
            url: location.href,
            domSize: document.documentElement ? document.documentElement.outerHTML.length : 0,
            active: document.activeElement
                ? `${document.activeElement.tagName}#${(document.activeElement as HTMLElement).id || ''}.${(document.activeElement as HTMLElement).className || ''}`.slice(0, 120)
                : '',
        }))
    } catch {
        return { url: page.url(), domSize: 0, active: '' }
    }
}

function changed(a: Fingerprint, b: Fingerprint): boolean {
    return a.url !== b.url || a.active !== b.active || Math.abs(a.domSize - b.domSize) > 8
}

async function pollUntil(timeoutMs: number, fn: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await fn()) return true
        await new Promise(r => setTimeout(r, 120))
    }
    return false
}

/**
 * Verify a step's post-condition.
 * @param locator the element the engine resolved & acted on (for value read-back)
 * @param before  fingerprint captured immediately before the action
 */
export async function verifyStep(
    page: Page,
    step: RecordedStep,
    before: Fingerprint,
    locator: Locator | null,
    timeoutMs = 2500,
): Promise<VerifyResult> {
    switch (step.type) {
        case 'type': {
            if (!locator) return { ok: false, reason: 'type: target element not found for verification' }
            const expected = (step.value ?? '').trim()
            const matched = await pollUntil(timeoutMs, async () => {
                try { return ((await locator.inputValue()).trim()) === expected } catch { return false }
            })
            if (matched) return { ok: true }
            let actual = ''
            try { actual = await locator.inputValue() } catch { /* detached */ }
            return { ok: false, reason: `type verify failed: field shows "${actual}" not "${expected}"` }
        }

        case 'select': {
            if (!locator) return { ok: false, reason: 'select: target element not found' }
            const expected = step.value ?? ''
            const matched = await pollUntil(timeoutMs, async () => {
                try { return (await locator.inputValue()) === expected } catch { return false }
            })
            return matched
                ? { ok: true }
                : { ok: false, reason: `select verify failed: value is not "${expected}"` }
        }

        case 'scroll': {
            const target = step.scrollY ?? 0
            const reached = await pollUntil(timeoutMs, async () => {
                try { return Math.abs((await page.evaluate(() => window.scrollY)) - target) < 40 } catch { return false }
            })
            // Pages can clamp scroll (shorter than recorded); treat as best-effort.
            return reached ? { ok: true } : { ok: true, reason: 'scroll did not reach exact target (page may be shorter)' }
        }

        case 'click':
        case 'keypress': {
            // Act already proved the element was landable; look for corroborating change.
            const sawChange = await pollUntil(timeoutMs, async () => changed(before, await snapshot(page)))
            return sawChange ? { ok: true } : { ok: true, reason: 'no observable page change (lenient pass)' }
        }

        case 'navigate': {
            return { ok: true }
        }

        case 'extract':
        case 'hover':
        default:
            return { ok: true }
    }
}
