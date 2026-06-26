/**
 * recorded-types.ts — Shape of steps captured by the extension recorder.
 *
 * This is distinct from `AutomationStep` in agents/types.ts (which is the
 * AI-generated automation shape). Recorded steps come from content.js's
 * onRecord* handlers and carry pixel coordinates, CSS selectors, the recorded
 * timestamp (used to seed human think-time) and the element label/description.
 */

export type RecordedStepType =
    | 'click' | 'type' | 'select' | 'hover'
    | 'keypress' | 'scroll' | 'navigate' | 'extract'

export interface RecordedStep {
    type: RecordedStepType
    // Targeting (click/type/select/hover/extract)
    selector?: string
    tagName?: string
    description?: string
    // Pointer coords (click/hover) — fallback when selector/label don't resolve
    x?: number
    y?: number
    // Payloads
    value?: string        // type / select
    label?: string        // select option text
    key?: string          // keypress
    scrollX?: number      // scroll
    scrollY?: number
    url?: string          // navigate
    variable?: string     // extract → store result under this name
    // Recording metadata
    timestamp?: number    // ms epoch when captured; gaps seed think-time
    delay?: number        // recorder's suggested post-step settle
}

export type ReplayStatus = 'running' | 'paused-on-step' | 'failed' | 'done' | 'stopped'

export interface ReplayStatusEvent {
    status: ReplayStatus
    /** 0-based index of the current/failed step within the steps array. */
    stepIndex: number
    /** Total steps in one pass. */
    totalSteps: number
    /** Human-readable description of the step. */
    stepDescription?: string
    /** Reason a step failed verification (only on 'paused-on-step' / 'failed'). */
    reason?: string
    /** Loop iteration number (1-based) when looping. */
    iteration?: number
}

export interface VerifyResult {
    ok: boolean
    reason?: string
}
