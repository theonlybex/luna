// ═══════════════════════════════════════════════════════════════════════════════
// content.js — Luna Content Script
//
// Injected into every page. Handles:
//   1. Page analysis (DOM → accessibility tree for agents)
//   2. Action execution (click/type/scroll for agents)
//   3. Recording user actions (pixel-perfect coordinates for automations)
//   4. Replaying recorded steps
// ═══════════════════════════════════════════════════════════════════════════════

(() => {
  if (window.__lunaContentLoaded) return;
  window.__lunaContentLoaded = true;

  // ─── State ──────────────────────────────────────────────────────────────────

  let elementMap = [];    // DOM elements indexed by a11y tree number
  let recording = false;
  let overlay = null;

  // ─── Page Analysis ──────────────────────────────────────────────────────────

  const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'menuitem', 'tab', 'option',
    'switch', 'slider', 'spinbutton'
  ]);

  function getAccessibleName(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('aria-labelledby')) {
      const ref = document.getElementById(el.getAttribute('aria-labelledby'));
      if (ref) return ref.textContent.trim().slice(0, 60);
    }
    if (el.getAttribute('alt')) return el.getAttribute('alt');
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent.trim().slice(0, 60);
    }
    const text = el.textContent?.trim();
    if (text && text.length < 80) return text;
    return '';
  }

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    switch (el.tagName) {
      case 'BUTTON': return 'button';
      case 'A': return el.href ? 'link' : 'generic';
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      case 'SELECT': return 'combobox';
      case 'TEXTAREA': return 'textbox';
      default: return 'generic';
    }
  }

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function isInteractive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
    if (el.getAttribute('onclick') || el.getAttribute('tabindex')) return true;
    return false;
  }

  const MAX_ELEMENTS = 75;
  const MAX_CONTENT_CHARS = 3000;

  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
  }

  // Extract readable text content from the page (headings, paragraphs, data)
  function extractPageContent() {
    const sections = [];
    let totalChars = 0;

    // 1. Headings — page structure
    const headings = document.querySelectorAll('h1, h2, h3, h4');
    headings.forEach(h => {
      const text = h.innerText?.trim();
      if (text && text.length > 1 && text.length < 200 && isVisible(h)) {
        const tag = h.tagName.toLowerCase();
        const line = `[${tag}] ${text.slice(0, 100)}`;
        if (totalChars + line.length < MAX_CONTENT_CHARS) {
          sections.push(line);
          totalChars += line.length;
        }
      }
    });

    // 2. Content blocks — paragraphs, list items, table cells, key data
    const contentEls = document.querySelectorAll(
      'p, li, td, th, [class*="price"], [class*="rating"], [class*="review"], ' +
      '[class*="cost"], [class*="score"], [data-testid], ' +
      'span[class], div[class]'
    );

    const seenTexts = new Set();
    contentEls.forEach(el => {
      if (totalChars >= MAX_CONTENT_CHARS) return;
      if (!isVisible(el)) return;

      const text = el.innerText?.trim();
      if (!text || text.length < 3 || text.length > 300) return;

      // Skip if it's basically just a container with lots of children
      if (el.children.length > 5) return;

      // Skip duplicate text
      const shortText = text.slice(0, 80);
      if (seenTexts.has(shortText)) return;
      seenTexts.add(shortText);

      // Determine what type of content this is
      const tag = el.tagName.toLowerCase();
      const cls = (el.className || '').toLowerCase();
      let prefix = '';
      if (tag === 'p') prefix = '';
      else if (tag === 'li') prefix = '• ';
      else if (tag === 'td' || tag === 'th') prefix = '| ';
      else if (/price|cost/.test(cls)) prefix = '[$] ';
      else if (/rating|score|star/.test(cls)) prefix = '[★] ';
      else if (/review/.test(cls)) prefix = '[review] ';
      else if (tag === 'span' || tag === 'div') {
        // Only include short, data-like text from spans/divs
        if (text.length > 80) return;
        prefix = '';
      }

      const line = `${prefix}${text.slice(0, 150)}`;
      sections.push(line);
      totalChars += line.length;
    });

    return sections.join('\n');
  }

  function analyzePage() {
    elementMap = [];
    const inView = [];
    const offScreen = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while (node = walker.nextNode()) {
      if (!isInteractive(node)) continue;
      const role = getRole(node);
      const name = getAccessibleName(node);
      if (!name && role === 'generic') continue;
      if (isInViewport(node)) {
        inView.push({ node, role, name });
      } else {
        offScreen.push({ node, role, name });
      }
    }

    const all = [...inView, ...offScreen].slice(0, MAX_ELEMENTS);
    const lines = [];
    const seen = new Set();
    for (const { node, role, name } of all) {
      const truncName = (name || '').slice(0, 50);
      const dedupKey = `${role}|${truncName}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const idx = elementMap.length;
      elementMap.push(node);
      lines.push(`[${idx}] ${role} "${truncName || '(unnamed)'}"`);
    }

    if (lines.length === 0) {
      lines.push('(No interactive elements detected)');
    }

    // Extract readable page content
    const content = extractPageContent();

    return {
      url: location.href,
      title: document.title,
      tree: lines.join('\n'),
      content: content,
      elementCount: elementMap.length,
    };
  }

  // ─── Action Execution (for agents) ──────────────────────────────────────────

  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };

    // Check if something is covering this element (overlay/banner)
    const topEl = document.elementFromPoint(x, y);
    const target = (topEl && topEl !== el && !el.contains(topEl)) ? topEl : el;

    target.dispatchEvent(new MouseEvent('mouseover', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return target === el ? 'direct' : 'overlay-redirected';
  }

  function executeAction(action) {
    try {
      switch (action.action) {
        case 'click': {
          const el = elementMap[action.elementIndex];
          if (!el) return 'Element not found';
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          // Small delay for scroll to settle
          const how = simulateClick(el);
          return `Clicked [${action.elementIndex}] (${how})`;
        }
        case 'type': {
          const el = elementMap[action.elementIndex];
          if (!el) return 'Element not found';
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          if ('value' in el) {
            // Clear first, then type
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            // Set new value
            el.value = action.text || '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // Also dispatch keydown Enter for search boxes
          }
          return `Typed "${action.text}" into [${action.elementIndex}]`;
        }
        case 'scroll': {
          const dy = action.scrollDirection === 'up' ? -500 : 500;
          window.scrollBy(0, dy);
          return `Scrolled ${action.scrollDirection || 'down'}`;
        }
        default:
          return `Unknown action: ${action.action}`;
      }
    } catch (err) {
      return `Action failed: ${err.message}`;
    }
  }

  // ─── CSS Selector Generator ─────────────────────────────────────────────────

  // Escape a value for use inside an [attr="..."] selector.
  function cssAttrVal(v) { return String(v).replace(/(["\\])/g, '\\$1'); }
  function uniqueSelector(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  }

  function getSelector(el) {
    // Prefer stable, semantic anchors that survive redesigns and rebuilds, and
    // only accept them when they resolve to exactly one node. Falls back to the
    // structural nth-of-type/class chain below.
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) { const s = `[${attr}="${cssAttrVal(v)}"]`; if (uniqueSelector(s)) return s; }
    }
    if (el.id) { const s = `#${CSS.escape(el.id)}`; if (uniqueSelector(s)) return s; }
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) { const s = `${tag}[name="${cssAttrVal(name)}"]`; if (uniqueSelector(s)) return s; }
    const aria = el.getAttribute('aria-label');
    if (aria) { const s = `${tag}[aria-label="${cssAttrVal(aria)}"]`; if (uniqueSelector(s)) return s; }

    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).filter(c => c.length < 40 && !c.includes(':'));
        if (cls.length > 0) sel += '.' + cls.slice(0, 2).map(c => CSS.escape(c)).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function getStepDescription(el, type) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 40);
    const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    const label = text || name || tag;
    if (type === 'click') return `Click "${label}"`;
    if (type === 'type') return `Type into "${label}"`;
    return `${type} on "${label}"`;
  }

  // ─── Element Finder (multi-attribute scoring) ────────────────────────────────

  function findElement(step) {
    if (step.selector) {
      try {
        const el = document.querySelector(step.selector);
        if (el && isVisible(el)) return el;
      } catch {}
    }
    const descMatch = (step.description || '').match(/"([^"]+)"/);
    const targetLabel = descMatch ? descMatch[1].toLowerCase() : null;
    if (!targetLabel) return null;
    const pool = step.tagName
      ? document.querySelectorAll(step.tagName)
      : document.querySelectorAll('button,a,input,select,textarea,[role]');
    let best = null, bestScore = 0;
    for (const el of pool) {
      if (!isVisible(el)) continue;
      let score = 0;
      const name = (getAccessibleName(el) || '').toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase().slice(0, 80);
      if (name === targetLabel)            score += 10;
      else if (name.includes(targetLabel)) score += 5;
      if (text === targetLabel)            score += 8;
      else if (text.includes(targetLabel)) score += 3;
      if (step.tagName && el.tagName.toLowerCase() === step.tagName) score += 2;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return bestScore >= 3 ? best : null;
  }

  // ─── Wait For Element ────────────────────────────────────────────────────────

  function waitForElement(selector, timeoutMs = 5000) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      (function check() {
        try {
          const el = document.querySelector(selector);
          if (el && isVisible(el)) { resolve(true); return; }
        } catch {}
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(check, 150);
      })();
    });
  }

  // ─── Recording ──────────────────────────────────────────────────────────────

  let scrollTimer = null;
  let hoverTimer = null;
  let hoverTarget = null;
  const inputDebounceTimers = new Map();   // el -> timeout id
  const inputPendingEmit = new Map();      // el -> () => void (emit the type step now)

  // Heuristic for fields whose values must never be recorded/stored.
  const SENSITIVE_RE = /pass|pwd|secret|cvv|cvc|card-?num|ccnum|ssn|\botp\b|\bpin\b|security-?code/i;
  function isSensitiveField(el) {
    if (el.type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/cc-number|cc-csc|current-password|new-password|one-time-code/.test(ac)) return true;
    const meta = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`;
    return SENSITIVE_RE.test(meta);
  }
  function fieldValue(el) {
    return el.isContentEditable ? (el.textContent || '') : ('value' in el ? el.value : '');
  }

  // Flush any debounced `type` steps immediately, so their order relative to a
  // click/keypress/change isn't inverted by the 600ms input debounce.
  function flushPendingInputs() {
    for (const el of [...inputDebounceTimers.keys()]) {
      clearTimeout(inputDebounceTimers.get(el));
      const emit = inputPendingEmit.get(el);
      if (emit) emit();
    }
  }

  function onRecordClick(e) {
    if (e.target.closest('#__luna-rec-overlay')) return;
    if (e.target.tagName === 'SELECT' || e.target.closest('select')) return;
    flushPendingInputs();
    const step = {
      type: 'click',
      x: e.clientX,
      y: e.clientY,
      selector: getSelector(e.target),
      tagName: e.target.tagName.toLowerCase(),
      timestamp: Date.now(),
      description: getStepDescription(e.target, 'click'),
      delay: 600,
    };
    chrome.runtime.sendMessage({ type: 'recordedStep', step });
  }

  function onRecordInput(e) {
    const el = e.target;
    const editable = el.isContentEditable;
    if (!('value' in el) && !editable) return;
    if (inputDebounceTimers.has(el)) clearTimeout(inputDebounceTimers.get(el));
    const emit = () => {
      inputDebounceTimers.delete(el);
      inputPendingEmit.delete(el);
      const sensitive = isSensitiveField(el);
      const step = {
        type: 'type',
        selector: getSelector(el),
        // Never persist secrets; the user re-enters them at replay time.
        value: sensitive ? '' : fieldValue(el),
        tagName: el.tagName.toLowerCase(),
        timestamp: Date.now(),
        description: `Type into "${el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('aria-label') || el.tagName.toLowerCase()}"`,
        delay: 300,
      };
      if (sensitive) step.sensitive = true;
      if (editable) step.editable = true;
      chrome.runtime.sendMessage({ type: 'recordedStep', step });
    };
    inputPendingEmit.set(el, emit);
    inputDebounceTimers.set(el, setTimeout(emit, 600));
  }

  function onRecordChange(e) {
    const el = e.target;
    if (el.tagName !== 'SELECT') return;
    flushPendingInputs();
    const selected = el.options[el.selectedIndex];
    const step = {
      type: 'select',
      selector: getSelector(el),
      tagName: 'select',
      value: el.value,
      label: selected ? selected.text : el.value,
      timestamp: Date.now(),
      description: `Select "${selected ? selected.text : el.value}"`,
      delay: 300,
    };
    chrome.runtime.sendMessage({ type: 'recordedStep', step });
  }

  function onRecordHover(e) {
    const el = e.target;
    if (el === hoverTarget) return;
    if (el.closest('#__luna-rec-overlay')) return;
    clearTimeout(hoverTimer);
    hoverTarget = el;
    hoverTimer = setTimeout(() => {
      const step = {
        type: 'hover',
        selector: getSelector(el),
        tagName: el.tagName.toLowerCase(),
        x: e.clientX,
        y: e.clientY,
        timestamp: Date.now(),
        description: `Hover "${(getAccessibleName(el) || el.tagName).slice(0, 30)}"`,
        delay: 400,
      };
      chrome.runtime.sendMessage({ type: 'recordedStep', step });
    }, 1000);
  }

  function onRecordKeydown(e) {
    if (!['Enter', 'Tab', 'Escape'].includes(e.key)) return;
    // Emit the field's pending `type` step before this keypress so the order is
    // [type, Enter] — not [Enter, type] when the user hits Enter immediately.
    flushPendingInputs();
    const step = {
      type: 'keypress',
      key: e.key,
      timestamp: Date.now(),
      description: `Press ${e.key}`,
      delay: 400,
    };
    chrome.runtime.sendMessage({ type: 'recordedStep', step });
  }

  function onRecordScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const step = {
        type: 'scroll',
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        timestamp: Date.now(),
        description: `Scroll to (${Math.round(window.scrollX)}, ${Math.round(window.scrollY)})`,
        delay: 400,
      };
      chrome.runtime.sendMessage({ type: 'recordedStep', step });
    }, 300);
  }

  function showRecordingOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = '__luna-rec-overlay';
    overlay.innerHTML = `
      <div style="
        position:fixed; top:12px; right:12px; z-index:2147483647;
        display:flex; align-items:center; gap:8px;
        background:rgba(20,20,28,0.92); border:1px solid rgba(244,63,94,0.4);
        border-radius:10px; padding:8px 16px;
        font-family:-apple-system,Roboto,Arial,sans-serif;
        font-size:12px; font-weight:600; color:#f43f5e;
        box-shadow:0 4px 24px rgba(0,0,0,0.4);
        backdrop-filter:blur(8px);
        pointer-events:none;
      ">
        <span style="
          width:8px;height:8px;border-radius:50%;background:#f43f5e;
          animation:__lunaRecPulse 1.2s ease-in-out infinite;
        "></span>
        Recording...
      </div>
      <style>
        @keyframes __lunaRecPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        #__luna-rec-overlay * { pointer-events:none !important; }
      </style>
    `;
    document.body.appendChild(overlay);
  }

  function hideRecordingOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function startRecording() {
    recording = true;
    document.addEventListener('click',     onRecordClick,   true);
    document.addEventListener('input',     onRecordInput,   true);
    document.addEventListener('change',    onRecordChange,  true);
    document.addEventListener('keydown',   onRecordKeydown, true);
    document.addEventListener('scroll',    onRecordScroll,  true);
    document.addEventListener('mouseover', onRecordHover,   true);
    showRecordingOverlay();
  }

  function stopRecording() {
    recording = false;
    document.removeEventListener('click',     onRecordClick,   true);
    document.removeEventListener('input',     onRecordInput,   true);
    document.removeEventListener('change',    onRecordChange,  true);
    document.removeEventListener('keydown',   onRecordKeydown, true);
    document.removeEventListener('scroll',    onRecordScroll,  true);
    document.removeEventListener('mouseover', onRecordHover,   true);
    flushPendingInputs();
    inputDebounceTimers.forEach(t => clearTimeout(t));
    inputDebounceTimers.clear();
    inputPendingEmit.clear();
    clearTimeout(hoverTimer);
    hoverTarget = null;
    hideRecordingOverlay();
  }

  // ─── Replay ─────────────────────────────────────────────────────────────────

  function replayStep(step) {
    try {
      switch (step.type) {
        case 'click': {
          const el = findElement(step);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            el.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup',   { clientX: cx, clientY: cy, bubbles: true }));
            el.dispatchEvent(new MouseEvent('click',     { clientX: cx, clientY: cy, bubbles: true }));
          } else {
            const target = document.elementFromPoint(step.x, step.y);
            if (target) {
              target.dispatchEvent(new MouseEvent('mousedown', { clientX: step.x, clientY: step.y, bubbles: true }));
              target.dispatchEvent(new MouseEvent('mouseup',   { clientX: step.x, clientY: step.y, bubbles: true }));
              target.dispatchEvent(new MouseEvent('click',     { clientX: step.x, clientY: step.y, bubbles: true }));
            }
          }
          break;
        }
        case 'type': {
          const el = findElement(step);
          if (!el) break;
          if (step.sensitive) break;   // never auto-fill secrets — user enters them
          if (el.isContentEditable) {
            el.focus();
            el.textContent = step.value || '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else if ('value' in el) {
            el.focus();
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            for (const char of (step.value || '')) {
              el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true, cancelable: true }));
              el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));
              el.value += char;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          break;
        }
        case 'select': {
          const el = findElement(step);
          if (el && el.tagName === 'SELECT') {
            el.value = step.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input',  { bubbles: true }));
          }
          break;
        }
        case 'hover': {
          const el = findElement(step);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            el.dispatchEvent(new MouseEvent('mouseover', { clientX: cx, clientY: cy, bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
          }
          break;
        }
        case 'extract': {
          const el = findElement(step);
          if (el) {
            const value = 'value' in el ? el.value : (el.textContent || '').trim();
            return { ok: true, value };
          }
          return { ok: false, value: '' };
        }
        case 'keypress': {
          const active = document.activeElement || document.body;
          active.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));
          active.dispatchEvent(new KeyboardEvent('keyup',   { key: step.key, bubbles: true }));
          if (step.key === 'Enter') {
            const form = active.closest('form');
            if (form) form.dispatchEvent(new Event('submit', { bubbles: true }));
          }
          break;
        }
        case 'scroll': {
          window.scrollTo(step.scrollX || 0, step.scrollY || 0);
          break;
        }
        case 'navigate':
          break;
      }
    } catch (err) {
      console.warn('[Luna] Replay step failed:', err);
    }
    return { ok: true };
  }

  // ─── Message Listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'ping':
        sendResponse({ ok: true });
        return false;

      case 'analyzePage':
        sendResponse(analyzePage());
        return false;

      case 'executeAction':
        const result = executeAction(msg.action);
        sendResponse(result);
        return false;

      case 'startRecording':
        startRecording();
        sendResponse({ ok: true });
        return false;

      case 'stopRecording':
        stopRecording();
        sendResponse({ ok: true });
        return false;

      case 'waitForElement':
        waitForElement(msg.selector, msg.timeoutMs).then(found => sendResponse({ found }));
        return true;

      case 'replayStep':
        sendResponse(replayStep(msg.step));
        return false;
    }
  });
})();
