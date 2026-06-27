/**
 * recorded-replay.ts — Replays recorded steps with human-like, trusted input.
 *
 * Each step runs a resolve → snapshot → act → verify cycle. Acting uses
 * Playwright's native input (mouse paths, jittered keystrokes), which dispatches
 * via CDP and is therefore isTrusted. Pre-action readiness (visible / stable /
 * enabled / not occluded) comes from Playwright locator actionability, so it
 * isn't re-implemented here.
 *
 * On a step that fails verification after its retries, the engine pauses and
 * emits `paused-on-step`; the user resumes (re-attempt) or stops.
 */

import { Page, Locator } from 'playwright'
import { RecordedStep, ReplayStatusEvent } from './recorded-types'
import { snapshot, verifyStep, Fingerprint } from './step-verifier'
import { bezierPath, landingPoint, thinkTime, keystrokeDelay, scrollTicks, Point } from './human-motion'

const STEP_RETRIES = 3

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
function rand(min: number, max: number): number { return min + Math.random() * (max - min) }

function interpolate(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')
}

/** Pull a quoted label out of a recorded step's description, e.g. Click "Search". */
function labelOf(step: RecordedStep): string | null {
    const m = (step.description || '').match(/"([^"]+)"/)
    return m ? m[1] : null
}

export class RecordedReplayEngine {
    private paused = false
    private stopped = false
    private mouse: Point = { x: 200, y: 200 }

    constructor(
        private getPage: () => Page | null,
        private onStatus: (e: ReplayStatusEvent) => void,
    ) {}

    pause(): void { this.paused = true }
    resume(): void { this.paused = false }
    stop(): void { this.stopped = true; this.paused = false }
    get isRunning(): boolean { return !this.stopped }

    // ── Main loop ───────────────────────────────────────────────────────────────

    async run(steps: RecordedStep[], opts: { loop?: boolean } = {}): Promise<void> {
        const vars: Record<string, string> = {}
        let iteration = 0

        do {
            iteration++
            for (let i = 0; i < steps.length; i++) {
                if (this.stopped) { this.emit('stopped', i, steps, iteration); return }
                await this.waitIfPaused(i, steps, iteration)
                if (this.stopped) { this.emit('stopped', i, steps, iteration); return }

                const step = steps[i]
                const gap = i > 0 ? (step.timestamp ?? 0) - (steps[i - 1].timestamp ?? 0) : undefined
                await sleep(thinkTime(gap))

                this.emit('running', i, steps, iteration)

                // Sensitive fields aren't captured (no stored secret). Pause so the
                // user types the value into the real browser, then Resume to skip
                // the automated type and continue with the rest of the sequence.
                if (step.type === 'type' && step.sensitive) {
                    this.paused = true
                    this.emit('paused-on-step', i, steps, iteration, 'Sensitive field — enter the value manually, then Resume')
                    await this.waitIfPaused()
                    if (this.stopped) { this.emit('stopped', i, steps, iteration); return }
                    continue
                }

                let done = false
                while (!done && !this.stopped) {
                    const res = await this.attemptStep(this.getPage(), step, vars)
                    if (res.ok) { done = true; break }
                    // Retries exhausted — pause and surface to the user.
                    this.paused = true
                    this.emit('paused-on-step', i, steps, iteration, res.reason)
                    await this.waitIfPaused()
                    // On resume the while-loop re-attempts the same step.
                }
            }
            if (this.stopped) { this.emit('stopped', steps.length, steps, iteration); return }
            if (opts.loop) await sleep(rand(800, 1600))
        } while (opts.loop && !this.stopped)

        this.emit('done', steps.length, steps, iteration)
    }

    private async waitIfPaused(stepIndex?: number, steps?: RecordedStep[], iteration?: number): Promise<void> {
        if (!this.paused || this.stopped) return
        // Emit paused status if context is provided and no status was already emitted
        // (failure-pause emits before calling waitIfPaused; manual pause does not)
        if (stepIndex !== undefined && steps && iteration !== undefined) {
            // Only emit if the current status isn't already paused-on-step (avoid double-emit on failure)
            this.emit('paused-on-step', stepIndex, steps, iteration, 'Paused by user')
        }
        while (this.paused && !this.stopped) await sleep(250)
    }

    private emit(status: ReplayStatusEvent['status'], stepIndex: number, steps: RecordedStep[], iteration: number, reason?: string): void {
        this.onStatus({
            status,
            stepIndex,
            totalSteps: steps.length,
            stepDescription: steps[stepIndex]?.description,
            reason,
            iteration,
        })
    }

    // ── Single step: resolve → snapshot → act → verify, with retries ──────────────

    private async attemptStep(page: Page | null, step: RecordedStep, vars: Record<string, string>): Promise<{ ok: boolean; reason?: string }> {
        if (!page || page.isClosed()) return { ok: false, reason: 'no active page' }

        let lastReason = 'unknown failure'
        for (let attempt = 0; attempt < STEP_RETRIES; attempt++) {
            if (this.stopped) return { ok: true }
            try {
                const locator = await this.resolveLocator(page, step)
                const before: Fingerprint = await snapshot(page)
                await this.act(page, step, locator, vars)
                const verdict = await verifyStep(page, step, before, locator)
                if (verdict.ok) return { ok: true }
                lastReason = verdict.reason || 'verification failed'
            } catch (err) {
                lastReason = String((err as Error)?.message ?? err).split('\n')[0]
            }
            if (attempt < STEP_RETRIES - 1) await sleep(400 * (attempt + 1))
        }
        return { ok: false, reason: lastReason }
    }

    // ── Resolve ───────────────────────────────────────────────────────────────────

    private async resolveLocator(page: Page, step: RecordedStep): Promise<Locator | null> {
        if (!['click', 'type', 'select', 'hover', 'extract'].includes(step.type)) return null

        if (step.selector) {
            try {
                const loc = page.locator(step.selector).first()
                if ((await loc.count()) > 0) return loc
            } catch { /* invalid selector — fall through to label match */ }
        }

        const label = labelOf(step)
        if (label) {
            const role = this.guessRole(step.tagName)
            // Prefer specific, unambiguous matches. A broad first()-of-many can
            // silently click the wrong element (the lenient click verify won't
            // catch it), so only accept a candidate that resolves to exactly one
            // node. Ambiguity returns null → the step fails → recovery/pause.
            const candidates: Locator[] = [
                page.getByRole(role, { name: label, exact: true }),
                page.getByRole(role, { name: label }),
                page.getByText(label, { exact: true }),
                page.getByText(label, { exact: false }),
            ]
            for (const c of candidates) {
                try { if ((await c.count()) === 1) return c.first() } catch { /* try next */ }
            }
        }
        return null
    }

    private guessRole(tag?: string): 'button' | 'link' | 'textbox' | 'combobox' {
        switch (tag) {
            case 'a':        return 'link'
            case 'input':
            case 'textarea': return 'textbox'
            case 'select':   return 'combobox'
            default:         return 'button'
        }
    }

    // ── Act (human-like, trusted input) ──────────────────────────────────────────

    private async act(page: Page, step: RecordedStep, locator: Locator | null, vars: Record<string, string>): Promise<void> {
        switch (step.type) {
            case 'click':    return this.actClick(page, step, locator)
            case 'type':     return this.actType(page, step, locator, vars)
            case 'select':   { if (locator) await locator.selectOption(step.value ?? ''); return }
            case 'hover':    return this.actHover(page, step, locator)
            case 'keypress': { if (step.key) await page.keyboard.press(this.keyName(step.key)); return }
            case 'scroll':   return this.actScroll(page, step)
            case 'navigate': { if (step.url) await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); return }
            case 'extract':  return this.actExtract(step, locator, vars)
        }
    }

    private async moveMouseTo(page: Page, target: Point): Promise<void> {
        for (const p of bezierPath(this.mouse, target)) {
            if (this.stopped) return
            await page.mouse.move(p.x, p.y)
            await sleep(rand(4, 14))
        }
        this.mouse = target
    }

    private async pointerTo(page: Page, locator: Locator | null, fallbackX?: number, fallbackY?: number): Promise<boolean> {
        if (locator) {
            try {
                await locator.scrollIntoViewIfNeeded({ timeout: 4000 })
                const box = await locator.boundingBox()
                if (box) { await this.moveMouseTo(page, landingPoint(box)); return true }
            } catch { /* fall back to recorded coords */ }
        }
        // Recorded coords are in the recording window's space; only trust them if
        // they still fall inside this window (it may be a different size).
        if (fallbackX != null && fallbackY != null && await this.coordsInViewport(page, fallbackX, fallbackY)) {
            await this.moveMouseTo(page, { x: fallbackX, y: fallbackY }); return true
        }
        return false
    }

    private async coordsInViewport(page: Page, x: number, y: number): Promise<boolean> {
        if (x < 0 || y < 0) return false
        try {
            const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
            return x <= size.w && y <= size.h
        } catch { return false }
    }

    private async actClick(page: Page, step: RecordedStep, locator: Locator | null): Promise<void> {
        const moved = await this.pointerTo(page, locator, step.x, step.y)
        if (moved) {
            await page.mouse.down()
            await sleep(rand(40, 90))
            await page.mouse.up()
        } else if (locator) {
            await locator.click({ timeout: 4000 })   // last resort
        } else {
            throw new Error('click: could not resolve target')
        }
    }

    private async actType(page: Page, step: RecordedStep, locator: Locator | null, vars: Record<string, string>): Promise<void> {
        if (!locator) throw new Error('type: could not resolve target field')
        await this.pointerTo(page, locator)
        await page.mouse.down(); await page.mouse.up()
        await this.clearField(page, locator)
        const text = interpolate(step.value ?? '', vars)
        for (const ch of text) {
            if (this.stopped) return
            await page.keyboard.type(ch)
            await sleep(keystrokeDelay())
        }
    }

    /** Clear a field's existing content, covering inputs and contenteditable. */
    private async clearField(page: Page, locator: Locator): Promise<void> {
        try {
            await locator.fill('')
            if ((await locator.inputValue().catch(() => '')) === '') return
        } catch { /* not a fillable input (e.g. contenteditable) — fall through */ }
        try {
            await page.keyboard.press('ControlOrMeta+A')
            await page.keyboard.press('Delete')
        } catch { /* best effort */ }
    }

    private async actHover(page: Page, step: RecordedStep, locator: Locator | null): Promise<void> {
        await this.pointerTo(page, locator, step.x, step.y)
    }

    private async actScroll(page: Page, step: RecordedStep): Promise<void> {
        const current = await page.evaluate(() => window.scrollY)
        const delta = (step.scrollY ?? 0) - current
        if (Math.abs(delta) < 4) return
        const ticks = scrollTicks(delta)
        for (let i = 0; i < ticks; i++) {
            if (this.stopped) return
            await page.mouse.wheel(0, delta / ticks)
            await sleep(rand(30, 90))
        }
    }

    private async actExtract(step: RecordedStep, locator: Locator | null, vars: Record<string, string>): Promise<void> {
        if (!step.variable) return
        // Surface an unresolved source rather than silently leaving the variable
        // empty (which would interpolate to "" downstream and pass verification).
        if (!locator) throw new Error(`extract: could not resolve source for "${step.variable}"`)
        let value = ''
        try {
            value = await locator.inputValue()
        } catch {
            try { value = (await locator.textContent()) ?? '' } catch { /* leave empty */ }
        }
        vars[step.variable] = value.trim()
    }

    private keyName(key: string): string {
        // Recorder stores DOM key values which match Playwright key names for these.
        return key
    }
}
