/**
 * page-analyzer.ts — Extracts page state for AI consumption
 *
 * Given a Playwright Page, this module produces:
 *   1. Clean body text — main content with nav/ads/boilerplate stripped
 *   2. A serialized Accessibility Tree — numbered list of interactive elements
 *   3. An elementMap — maps each index to its ARIA role+name for Playwright to act on
 *
 * WHY BODY TEXT EXTRACTION:
 *   The ARIA tree only captures interactive elements. Static content (prices,
 *   descriptions, article text, search results) lives in plain <p>/<div> nodes
 *   that the A11y tree ignores. We strip boilerplate and extract innerText from
 *   the main content area — the same technique Firecrawl uses.
 *
 * WHY NUMBERED ELEMENTS:
 *   Instead of asking Claude to guess a CSS selector, we pre-assign an index
 *   to every interactive element. Claude picks a number. We find the element
 *   by its ARIA role + name. No guessing, no broken selectors.
 */

import { Page } from 'playwright'
import { AnalyzedPage, ElementInfo } from '../agents/types'

// ARIA roles we consider "interactive" — Claude can click/type on these
const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'menuitem', 'tab', 'option',
    'spinbutton', 'slider', 'switch', 'treeitem', 'listitem'
])

// Matches ARIA snapshot lines like:  - button "Submit"  or  - textbox "Search":
// Groups: [1] role, [2] accessible name (optional)
const ARIA_LINE_RE = /^\s*-\s+([\w-]+)(?:\s+"([^"]*)")?/

/**
 * analyzePage — the main export. Call this each agent loop iteration.
 *
 * Returns everything Claude needs to decide its next action.
 */
export async function analyzePage(page: Page): Promise<AnalyzedPage> {
    // Run structured content extraction, body text fallback, and A11y snapshot in parallel
    const [structuredBlocks, bodyText, yamlSnapshot] = await Promise.all([
        // ── Visual-hierarchy-aware content extraction ──────────────────────────
        // BACKGROUND-TAB SAFE: uses only getComputedStyle + DOM order.
        // Does NOT use getBoundingClientRect or window.innerHeight — those
        // return zeros in inactive/background tabs and would skip everything.
        page.evaluate(() => {
            const BOILERPLATE = 'script, style, noscript, iframe, svg, [aria-hidden="true"]'
            const NAV_ROLES = new Set(['navigation', 'banner', 'complementary', 'contentinfo'])
            const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

            type RawBlock = {
                text: string
                tag: 'HEADING' | 'CONTENT' | 'DETAIL' | 'NAV'
                weight: number
                aboveFold: boolean  // approximated: first ~40% of elements by DOM order
            }

            const blocks: RawBlock[] = []
            const seen = new Set<string>()

            // Walk all elements that could contain meaningful text
            const candidates = document.body.querySelectorAll(
                'h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, blockquote, ' +
                'span, a, label, figcaption, summary, [role="heading"]'
            )

            // First pass: collect valid blocks
            let domIndex = 0
            const totalCandidates = candidates.length

            for (const el of candidates) {
                if ((el as HTMLElement).closest(BOILERPLATE)) { domIndex++; continue }

                const htmlEl = el as HTMLElement
                // Use textContent (no layout needed) with innerText as fallback
                const text = (htmlEl.textContent ?? '').trim()
                if (!text || text.length < 3) { domIndex++; continue }

                // Deduplicate — avoid scoring the same text from nested elements
                const textKey = text.slice(0, 100)
                if (seen.has(textKey)) { domIndex++; continue }
                seen.add(textKey)

                // getComputedStyle works in background tabs — no layout trigger
                const style = window.getComputedStyle(htmlEl)
                if (style.display === 'none' || style.visibility === 'hidden') { domIndex++; continue }

                const fontSize = parseFloat(style.fontSize) || 16
                const fontWeight = parseInt(style.fontWeight) || 400

                // Determine tag category based on element semantics + computed style
                let tag: 'HEADING' | 'CONTENT' | 'DETAIL' | 'NAV' = 'CONTENT'
                if (HEADING_TAGS.has(htmlEl.tagName) || htmlEl.getAttribute('role') === 'heading') {
                    tag = 'HEADING'
                } else if (fontSize < 13 || (fontWeight <= 300 && fontSize < 15)) {
                    tag = 'DETAIL'
                }

                // Check if inside nav/header/footer/aside
                const ancestor = htmlEl.closest('nav, footer, aside, header, [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"]')
                if (ancestor) {
                    const role = ancestor.getAttribute('role') ?? ''
                    if (NAV_ROLES.has(role) || ['NAV', 'FOOTER', 'ASIDE', 'HEADER'].includes(ancestor.tagName)) {
                        tag = 'NAV'
                    }
                }

                // ── Layout-free scoring ──────────────────────────────────────
                // Score by font metrics (from getComputedStyle — always works)
                // and text length as a proxy for visual area.
                // DOM order position approximates above/below fold.
                const weightMultiplier = fontWeight > 500 ? 1.5 : 1.0
                const textLenFactor = Math.min(text.length, 300) / 50   // longer text = more visual area
                const tagBonus = tag === 'HEADING' ? 3.0 : tag === 'NAV' ? 0.3 : 1.0
                // Earlier in DOM ≈ higher on page ≈ more likely above fold
                const positionBonus = domIndex < totalCandidates * 0.4 ? 2.0 : 1.0
                const weight = fontSize * weightMultiplier * textLenFactor * tagBonus * positionBonus

                blocks.push({
                    text: text.slice(0, 600),
                    tag,
                    weight: Math.round(weight * 100) / 100,
                    aboveFold: domIndex < totalCandidates * 0.4
                })

                domIndex++
            }

            // Sort by visual weight descending — most prominent content first
            blocks.sort((a, b) => b.weight - a.weight)

            // Budget: keep top blocks within ~12k chars
            let charCount = 0
            const budgeted: RawBlock[] = []
            for (const block of blocks) {
                if (charCount + block.text.length > 12000) continue
                charCount += block.text.length
                budgeted.push(block)
            }

            return budgeted
        }).catch(() => [] as Array<{ text: string; tag: string; weight: number; aboveFold: boolean }>),

        // ── Fallback: existing body text extraction (kept for reliability) ─────
        page.evaluate(() => {
            const clone = document.body.cloneNode(true) as HTMLElement
            clone.querySelectorAll(
                'script, style, nav, footer, header, aside, ' +
                '[role="navigation"], [role="banner"], [role="complementary"], ' +
                'iframe, noscript, [aria-hidden="true"]'
            ).forEach(el => el.remove())
            const main = clone.querySelector('main, article, [role="main"]')
            const source = (main ?? clone) as HTMLElement
            return source.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000)
        }).catch(() => ''),

        // ── Accessibility tree ────────────────────────────────────────────────
        page.locator('body').ariaSnapshot({ mode: 'default' }).catch(() => '')
    ])

    // ── Build structured content string ──────────────────────────────────────
    let structuredContent = ''
    if (structuredBlocks.length > 0) {
        // Group by tag for readable output
        const headings = structuredBlocks.filter(b => b.tag === 'HEADING')
        const content  = structuredBlocks.filter(b => b.tag === 'CONTENT')
        const details  = structuredBlocks.filter(b => b.tag === 'DETAIL')

        const sections: string[] = []

        if (headings.length > 0) {
            sections.push('=== HEADINGS (prominent text) ===\n' +
                headings.map(b => `${b.aboveFold ? '▸' : ' '} ${b.text}`).join('\n'))
        }
        if (content.length > 0) {
            sections.push('=== MAIN CONTENT ===\n' +
                content.map(b => `${b.aboveFold ? '▸' : ' '} ${b.text}`).join('\n'))
        }
        if (details.length > 0) {
            sections.push('=== DETAILS (fine print) ===\n' +
                details.slice(0, 10).map(b => b.text).join('\n'))
        }

        structuredContent = sections.join('\n\n')
    }

    const elementMap: ElementInfo[] = []
    const lines: string[] = []

    // Parse the YAML aria snapshot, number every interactive element
    if (yamlSnapshot) {
        parseAriaSnapshot(yamlSnapshot, elementMap, lines)
    }

    // If nothing interactive found (e.g. page still loading), add a fallback
    if (lines.length === 0) {
        lines.push('(No interactive elements detected — page may still be loading)')
    }

    return {
        url: page.url(),
        title: await page.title(),
        bodyText,
        structuredContent,
        accessibilityTree: lines.join('\n'),
        elementMap
    }
}

/**
 * parseAriaSnapshot — walks the YAML aria snapshot string line by line.
 * Assigns an index to every interactive node and records it in elementMap + lines.
 *
 * Playwright's ariaSnapshot() returns YAML like:
 *   - list "Links":
 *     - listitem:
 *       - link "About"
 *   - button "Subscribe"
 *   - textbox "Email"
 */
function parseAriaSnapshot(yaml: string, elementMap: ElementInfo[], lines: string[]): void {
    for (const line of yaml.split('\n')) {
        const match = ARIA_LINE_RE.exec(line)
        if (!match) continue

        const role = match[1].toLowerCase()
        const name = (match[2] ?? '').trim()

        if (INTERACTIVE_ROLES.has(role) && name) {
            const index = elementMap.length
            elementMap.push({ role, name })
            // Format: [0] button "Search"
            lines.push(`[${index}] ${role} "${name}"`)
        }
    }
}

/**
 * actOnElement — executes a click or type action using the elementMap.
 *
 * Uses Playwright's getByRole locator — robust against DOM changes,
 * works across frames, handles ARIA-hidden correctly.
 */
export async function actOnElement(
    page: Page,
    elementIndex: number,
    elementMap: ElementInfo[],
    action: 'click' | 'type',
    text?: string
): Promise<void> {
    const info = elementMap[elementIndex]
    if (!info) {
        console.warn(`[PageAnalyzer] No element at index ${elementIndex}`)
        return
    }

    try {
        // getByRole is Playwright's preferred, most reliable locator
        const locator = page.getByRole(info.role as any, { name: info.name }).first()

        if (action === 'click') {
            await locator.click({ timeout: 5000 })
        } else if (action === 'type' && text !== undefined) {
            await locator.fill(text, { timeout: 5000 })
        }
    } catch (err) {
        console.warn(`[PageAnalyzer] Failed to ${action} element [${elementIndex}] "${info.role}:${info.name}": ${err}`)
    }
}
