/**
 * human-motion.ts — Human-like motion & timing primitives.
 *
 * Pure functions, no Playwright dependency, so they can be unit-tested in
 * isolation. The replay engine composes these to drive trusted Playwright
 * input (mouse paths, keystroke cadence, think-time) that reads as a real
 * person rather than an instant robotic action.
 */

export interface Point { x: number; y: number }

// ─── Random helpers ───────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
    return min + Math.random() * (max - min)
}

/** Standard normal sample (mean 0, std 1) via Box–Muller. */
function gaussian(): number {
    let u = 0, v = 0
    while (u === 0) u = Math.random()
    while (v === 0) v = Math.random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n))
}

// ─── Mouse path ───────────────────────────────────────────────────────────────

/**
 * Cubic Bézier path from `from` to `to`, bowed sideways by a random amount so
 * the cursor arcs like a hand rather than travelling a straight line. The step
 * count scales with distance (clamped 8–28) so short hops aren't over-sampled
 * and long sweeps stay smooth. Endpoints are included.
 */
export function bezierPath(from: Point, to: Point): Point[] {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist = Math.hypot(dx, dy)
    const steps = clamp(Math.round(dist / 18), 8, 28)

    // Perpendicular unit vector, used to bow the curve to one side.
    const len = dist || 1
    const px = -dy / len
    const py = dx / len
    const bow = rand(-0.18, 0.18) * dist   // curvature proportional to distance

    // Control points at ~1/3 and ~2/3 along the line, pushed off-axis.
    const c1: Point = { x: from.x + dx * 0.33 + px * bow, y: from.y + dy * 0.33 + py * bow }
    const c2: Point = { x: from.x + dx * 0.66 + px * bow, y: from.y + dy * 0.66 + py * bow }

    const path: Point[] = []
    for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const mt = 1 - t
        const x = mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x
        const y = mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y
        path.push({ x, y })
    }
    return path
}

/**
 * A landing point near the centre of a box but not dead-centre — a few pixels
 * of jitter so every click doesn't hit the exact same coordinate.
 */
export function landingPoint(box: { x: number; y: number; width: number; height: number }): Point {
    const jx = clamp(rand(-0.3, 0.3) * box.width, -box.width / 2 + 2, box.width / 2 - 2)
    const jy = clamp(rand(-0.3, 0.3) * box.height, -box.height / 2 + 2, box.height / 2 - 2)
    return { x: box.x + box.width / 2 + jx, y: box.y + box.height / 2 + jy }
}

// ─── Timing ───────────────────────────────────────────────────────────────────

const THINK_MIN = 120
const THINK_MAX = 4000
const THINK_DEFAULT = 500

/**
 * Pause before a step. Seeded from the *recorded* gap between this step and the
 * previous one (the cadence the human actually used), then perturbed with
 * log-normal jitter and clamped. Falls back to a default when no recorded gap
 * is available or it's implausible.
 */
export function thinkTime(recordedGapMs?: number): number {
    // Honor the recorded gap when present; very long idle pauses are reined in
    // by the final clamp to THINK_MAX rather than discarded down to the default.
    const base = recordedGapMs && recordedGapMs > 0 ? recordedGapMs : THINK_DEFAULT
    const jittered = base * Math.exp(gaussian() * 0.25)
    return Math.round(clamp(jittered, THINK_MIN, THINK_MAX))
}

const KEY_MIN = 30
const KEY_MAX = 220

/**
 * Delay between two keystrokes. Log-normal around a typical inter-key interval,
 * with an occasional longer hesitation (as if thinking mid-word).
 */
export function keystrokeDelay(): number {
    if (Math.random() < 0.08) return Math.round(rand(150, 500))   // hesitation
    const base = 75 * Math.exp(gaussian() * 0.3)
    return Math.round(clamp(base, KEY_MIN, KEY_MAX))
}

/** Number of discrete wheel ticks to break a scroll delta into. */
export function scrollTicks(deltaY: number): number {
    return clamp(Math.round(Math.abs(deltaY) / 120), 1, 12)
}
