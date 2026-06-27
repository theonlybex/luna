/**
 * recorded-automation-manager.ts — Bridges the replay engine to the server.
 *
 * Owns at most one running RecordedReplayEngine, exposes start/pause/resume/stop,
 * and forwards status events to a broadcaster (wired to SSE in app.ts). Analogous
 * to AgentManager but for recorded-click automations.
 */

import { Page } from 'playwright'
import { RecordedReplayEngine } from './recorded-replay'
import { RecordedStep, ReplayStatusEvent } from './recorded-types'

export class RecordedAutomationManager {
    private engine: RecordedReplayEngine | null = null
    private lastStatus: ReplayStatusEvent | null = null

    constructor(
        private getPage: () => Page | null,
        private broadcast: (e: ReplayStatusEvent) => void,
    ) {}

    start(steps: RecordedStep[], loop = false): void {
        if (!Array.isArray(steps) || steps.length === 0) return
        if (this.engine?.isRunning) this.engine.stop()

        // Pin the run to the page it starts on (plus any popups that page opens),
        // isolated from the globally-mutable active page that a concurrent agent
        // or a user tab-switch could swap out underneath the replay.
        const { getPinnedPage, dispose } = this.pinPages()

        const engine = new RecordedReplayEngine(getPinnedPage, (e) => {
            this.lastStatus = e
            this.broadcast(e)
        })
        this.engine = engine

        engine.run(steps, { loop })
            .catch((err) => {
                this.broadcast({
                    status: 'failed',
                    stepIndex: 0,
                    totalSteps: steps.length,
                    reason: String((err as Error)?.message ?? err),
                })
            })
            .finally(dispose)
    }

    /**
     * Track the run's start page and any popups it spawns, so the engine always
     * acts on a page that belongs to this run rather than whatever the session's
     * shared active page happens to be at the moment.
     */
    private pinPages(): { getPinnedPage: () => Page | null; dispose: () => void } {
        const pages: Page[] = []
        const onClose = (p: Page) => () => {
            const i = pages.indexOf(p)
            if (i >= 0) pages.splice(i, 1)
        }
        const track = (p: Page) => {
            if (pages.includes(p)) return
            pages.push(p)
            p.on('popup', track)
            p.on('close', onClose(p))
        }

        const start = this.getPage()
        if (start) track(start)

        const getPinnedPage = (): Page | null => {
            for (let i = pages.length - 1; i >= 0; i--) {
                if (!pages[i].isClosed()) return pages[i]
            }
            return this.getPage() // every tracked page closed — fall back to session active
        }
        const dispose = () => {
            for (const p of pages) {
                p.off('popup', track)
            }
            pages.length = 0
        }
        return { getPinnedPage, dispose }
    }

    pause(): void { this.engine?.pause() }
    resume(): void { this.engine?.resume() }
    stop(): void { this.engine?.stop() }

    getStatus(): ReplayStatusEvent | null { return this.lastStatus }
}
