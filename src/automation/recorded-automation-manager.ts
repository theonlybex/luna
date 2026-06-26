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

        const engine = new RecordedReplayEngine(this.getPage, (e) => {
            this.lastStatus = e
            this.broadcast(e)
        })
        this.engine = engine

        engine.run(steps, { loop }).catch((err) => {
            this.broadcast({
                status: 'failed',
                stepIndex: 0,
                totalSteps: steps.length,
                reason: String((err as Error)?.message ?? err),
            })
        })
    }

    pause(): void { this.engine?.pause() }
    resume(): void { this.engine?.resume() }
    stop(): void { this.engine?.stop() }

    getStatus(): ReplayStatusEvent | null { return this.lastStatus }
}
