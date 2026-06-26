// ═══════════════════════════════════════════════════════════════════════════════
// background.js — Luna Chrome Extension Service Worker
//
// All logic lives here: AI client, agent manager, automation manager, settings.
// Communicates with sidepanel.js via chrome.runtime messages and with
// content.js via chrome.tabs.sendMessage.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  apiKey: '', apiKeys: '',
  aiModel: 'claude-sonnet-4-6',
  fallbackModel: 'claude-haiku-4-5-20251001',
  maxAgentSteps: 25,
};

async function getSettings() {
  const { lunaSettings } = await chrome.storage.local.get('lunaSettings');
  return { ...DEFAULT_SETTINGS, ...(lunaSettings || {}) };
}

async function saveSettings(updates) {
  const current = await getSettings();
  const merged = { ...current, ...updates };
  await chrome.storage.local.set({ lunaSettings: merged });
  return merged;
}

// ─── AI Client ───────────────────────────────────────────────────────────────

let currentKeys = [];
let currentKeyIndex = 0;

async function initKeys() {
  const s = await getSettings();
  const keys = [s.apiKey, ...(s.apiKeys || '').split(',').map(k => k.trim())].filter(Boolean);
  currentKeys = [...new Set(keys)];
  currentKeyIndex = 0;
}

async function callAnthropic(apiKey, model, system, messages, maxTokens) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.type = err?.error?.type || '';
    throw e;
  }
  return res.json();
}

const RATE_STRINGS = ['rate_limit', '429', 'quota', 'too many'];
const AUTH_STRINGS = ['invalid', 'unauthorized', '401', '403', 'authentication'];

function isRateLimit(err) {
  const m = String(err?.message ?? err).toLowerCase();
  return RATE_STRINGS.some(s => m.includes(s));
}
function isAuthError(err) {
  const m = String(err?.message ?? err).toLowerCase();
  return AUTH_STRINGS.some(s => m.includes(s));
}

async function callWithRotation(system, messages, maxTokens, model) {
  if (currentKeys.length === 0) await initKeys();
  const keys = currentKeys.length > 0 ? currentKeys : [''];
  model = model || (await getSettings()).aiModel;
  const fallback = (await getSettings()).fallbackModel;

  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const idx = (currentKeyIndex + i) % keys.length;
    try {
      const result = await callAnthropic(keys[idx], model, system, messages, maxTokens);
      currentKeyIndex = idx;
      return result;
    } catch (err) {
      lastErr = err;
      if (isRateLimit(err)) continue;
      if (isAuthError(err) && i < keys.length - 1) continue;
      break;
    }
  }
  // Fallback model
  if (fallback && fallback !== model) {
    for (let i = 0; i < keys.length; i++) {
      const idx = (currentKeyIndex + i) % keys.length;
      try {
        const result = await callAnthropic(keys[idx], fallback, system, messages, maxTokens);
        currentKeyIndex = idx;
        return result;
      } catch (err) { lastErr = err; if (isRateLimit(err)) continue; break; }
    }
  }
  throw lastErr;
}

function getText(response) {
  return (response.content?.[0]?.type === 'text') ? response.content[0].text.trim() : '';
}

async function testApiKey() {
  try {
    await callWithRotation('You are a test.', [{ role: 'user', content: 'hi' }], 1, 'claude-haiku-4-5-20251001');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ─── Agent System Prompts ────────────────────────────────────────────────────

const AGENT_SYSTEM = `You are a browser automation agent inside the Luna browser extension.
You receive THREE things about the current page:
1. A numbered list of INTERACTIVE elements (buttons, links, inputs) you can click/type
2. The page's readable TEXT CONTENT (headings, paragraphs, prices, ratings, reviews, etc.)
3. Your previous action history — use it to avoid repeating yourself
You do NOT receive screenshots — rely on the text content to understand the page.

BEFORE choosing an action, briefly PLAN your approach:
1. What is the current page state?
2. What have I already tried?
3. What is the most logical next step toward the goal?

Then choose your next single action.

For RESEARCH/COMPARISON goals ("find the best", "compare", "cheapest"):
- First, identify what factors matter for THIS specific goal (e.g. price and reviews for lodging, specs and benchmarks for tech, ingredients and ratings for restaurants — adapt to the domain)
- Look at MULTIPLE options, not just the first result
- Scroll down to see more options before deciding
- Use the "extract" action to save key data points for each option
- Only mark done when you have compared at least 3+ options

For ACTION goals ("book", "sign up", "click"):
- Execute steps directly and efficiently
- Handle popups and overlays by dismissing them

Respond ONLY with valid JSON:
{
  "plan": "<1-2 sentence plan of what you're doing and why>",
  "action": "navigate" | "click" | "type" | "scroll" | "go_back" | "wait" | "extract" | "done",
  "elementIndex": <number from the list, for click/type only>,
  "url": "<full https:// URL, for navigate only>",
  "text": "<text to enter, for type only>",
  "scrollDirection": "up" | "down",
  "extractedData": "<key data you want to remember, for extract action>",
  "reason": "<one-line explanation under 80 chars>",
  "isDone": true | false,
  "finalSummary": "<when isDone=true, your structured answer with data>"
}

Rules:
- click: set elementIndex to the number in [brackets] from the element list
- type: set elementIndex AND text
- navigate: set url (must start with https://)
- scroll: set scrollDirection — scroll to see more options
- extract: use to save important data (prices, ratings, names) for comparison
- done: set isDone=true AND finalSummary with your analysis
- NEVER repeat the same action 3 times — try something different
- If stuck, scroll or navigate to a different approach
- Raw JSON only — no markdown, no code fences`;

// ─── Agent Manager ───────────────────────────────────────────────────────────

const agents = new Map(); // id -> agent object
const agentHistories = new Map();
const agentTabs = new Map(); // agentId -> tabId
const cancelledAgents = new Set();
const pausedAgents = new Set();
const correctionQueue = new Map();

function broadcastAgents() {
  const list = [...agents.values()];
  chrome.runtime.sendMessage({ type: 'agentUpdate', agents: list }).catch(() => {});
}

const RESEARCH_KEYWORDS = /\b(find|search|best|cheapest|compare|review|recommend|top|look up|lookup|what is|how much|price|option|alternative)\b/i;

async function classifyGoal(goal) {
  // Simple keyword-based classification — fast, no API call needed
  return RESEARCH_KEYWORDS.test(goal) ? 'research' : 'action';
}

async function createAgent(goal, maxSteps) {
  const id = crypto.randomUUID();
  const agent = { id, type: 'agent', goal, status: 'thinking', log: [], finalAnswer: '', extractedData: [] };
  agents.set(id, agent);
  broadcastAgents();

  // Classify the goal
  const taskType = await classifyGoal(goal);
  agent.log.push(`[plan] Task type: ${taskType}`);

  // For research tasks, start with Google AI Mode for synthesized answers
  let startUrl;
  if (taskType === 'research') {
    // Google AI Mode: google.com/search?q=...&udm=50 triggers AI overview
    const query = encodeURIComponent(goal);
    startUrl = `https://www.google.com/search?q=${query}&udm=50`;
    agent.log.push('[plan] Using Google AI Mode for research synthesis');
  } else {
    startUrl = 'https://www.google.com';
  }

  const tab = await chrome.tabs.create({ url: startUrl, active: false });
  agentTabs.set(id, tab.id);

  await new Promise(resolve => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 8000);
  });

  broadcastAgents();
  runAgentLoop(agent, maxSteps || 25);
  return agent;
}

function stopAgent(agentId) {
  const a = agents.get(agentId);
  if (!a) return;
  cancelledAgents.add(agentId);
  a.status = 'stopped';
  a.log.push('Stopped by user');
  broadcastAgents();
}

function removeAgent(agentId) {
  // Stop it first if running
  cancelledAgents.add(agentId);
  // Close the agent's tab
  const tabId = agentTabs.get(agentId);
  if (tabId) { try { chrome.tabs.remove(tabId); } catch {} }
  // Clean up all state
  agents.delete(agentId);
  cleanup(agentId);
  broadcastAgents();
}

function pauseAgent(agentId) {
  const a = agents.get(agentId);
  if (!a || ['done','error','stopped'].includes(a.status)) return;
  pausedAgents.add(agentId);
  a.status = 'waiting';
  a.log.push('Paused by user');
  broadcastAgents();
}

function resumeAgent(agentId, correction) {
  const a = agents.get(agentId);
  if (!a || ['done','error','stopped'].includes(a.status)) return;
  if (correction?.trim()) correctionQueue.set(agentId, correction.trim());
  pausedAgents.delete(agentId);
  a.status = 'running';
  a.log.push('Resumed');
  broadcastAgents();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function captureScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 40 });
    return dataUrl.replace(/^data:image\/\w+;base64,/, '');
  } catch { return ''; }
}

// ─── Token Management ────────────────────────────────────────────────────────

const MAX_HISTORY_TURNS = 6;
const COMPACT_THRESHOLD = 20000; // ~20k tokens triggers compaction

function estimateTokens(messages) {
  let size = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') { size += m.content.length; }
    else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text') size += c.text.length;
        else if (c.type === 'image') size += 1500; // images ~1500 tokens
      }
    }
  }
  return Math.ceil(size / 4);
}

function stripImagesFromHistory(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const textOnly = m.content.filter(c => c.type === 'text');
    if (textOnly.length === 0) return { ...m, content: '(image)' };
    return { ...m, content: textOnly };
  });
}

async function compactHistory(goal, history) {
  if (estimateTokens(history) < COMPACT_THRESHOLD) return history;
  const keepCount = MAX_HISTORY_TURNS * 2;
  const toSummarize = history.slice(0, -keepCount);
  const toKeep = history.slice(-keepCount);
  if (toSummarize.length === 0) return history;

  const historyText = stripImagesFromHistory(toSummarize).map(m => {
    const text = typeof m.content === 'string' ? m.content :
      m.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
    return `[${m.role}]: ${text.slice(0, 300)}`;
  }).join('\n');

  try {
    const r = await callWithRotation(
      'Summarize this browser automation history concisely. Focus on: pages visited, actions taken, what was found, current state. Keep under 200 words.',
      [{ role: 'user', content: `Goal: "${goal}"\n\nHistory:\n${historyText}` }],
      256,
      'claude-haiku-4-5-20251001'
    );
    const summary = getText(r) || 'Previous steps summarized.';
    return [
      { role: 'user', content: `[Context summary]\n${summary}` },
      { role: 'assistant', content: 'Understood. Continuing.' },
      ...stripImagesFromHistory(toKeep)
    ];
  } catch {
    return stripImagesFromHistory(toKeep);
  }
}

async function waitForTabReady(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch { return false; }
    await sleep(500);
  }
  return false;
}

async function ensureContentScript(tabId) {
  // First, wait for the tab to finish loading
  await waitForTabReady(tabId, 15000);

  // Try pinging, if alive we're good
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      return true; // Content script is alive
    } catch {
      // Not loaded — inject it
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        await sleep(500 + attempt * 500); // Increasing wait
      } catch (e) {
        console.warn(`[Luna] Inject attempt ${attempt + 1} failed:`, e.message);
        await sleep(1000);
      }
    }
  }
  return false; // All retries failed
}

async function getPageAnalysis(tabId) {
  const ready = await ensureContentScript(tabId);
  if (!ready) return null;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'analyzePage' });
    return result;
  } catch { return null; }
}

async function executeOnTab(tabId, action) {
  await ensureContentScript(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'executeAction', action });
  } catch (err) { return `Action failed: ${err.message}`; }
}

const PLANNING_RE = /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i)\b/i;
const REASONING_RE = /\b(?:i (?:can )?see|i notice|the page (?:shows|displays|contains))\b/i;

async function runAgentLoop(agent, maxSteps) {
  agent.status = 'running';
  broadcastAgents();
  agentHistories.set(agent.id, []);
  await sleep(1000);

  const ceiling = maxSteps === 0 ? Infinity : maxSteps;
  let step = 0, apiRetries = 0;
  const recentKeys = [];

  while (true) {
    // Pause poll
    while (pausedAgents.has(agent.id)) await sleep(500);

    // Correction injection
    const correction = correctionQueue.get(agent.id);
    if (correction) {
      correctionQueue.delete(agent.id);
      const h = agentHistories.get(agent.id) || [];
      agent.log.push(`[correction] User: ${correction}`);
      agentHistories.set(agent.id, [
        ...h,
        { role: 'user', content: `User correction: ${correction}` },
        { role: 'assistant', content: 'Understood. Incorporating this.' }
      ]);
      broadcastAgents();
    }

    // Ceiling
    if (step >= ceiling) {
      agent.status = 'done';
      agent.log.push(`Reached ${maxSteps}-step ceiling`);
      cleanup(agent.id);
      broadcastAgents();
      return;
    }

    // Cancelled
    if (cancelledAgents.has(agent.id)) {
      cancelledAgents.delete(agent.id);
      agent.status = 'stopped';
      cleanup(agent.id);
      broadcastAgents();
      return;
    }

    // Get the agent's own tab
    let tabId = agentTabs.get(agent.id);
    if (!tabId) {
      agent.status = 'error';
      agent.log.push('Agent tab was closed');
      cleanup(agent.id);
      broadcastAgents();
      return;
    }
    // Verify tab still exists
    try { await chrome.tabs.get(tabId); } catch {
      agent.status = 'error';
      agent.log.push('Agent tab was closed');
      cleanup(agent.id);
      broadcastAgents();
      return;
    }

    // Analyze page — retry up to 3 times (background tabs can be slow)
    let analysis = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      analysis = await getPageAnalysis(tabId);
      if (analysis) break;
      agent.log.push(`[retry] Page analysis attempt ${attempt + 1} failed, retrying...`);
      broadcastAgents();
      await sleep(2000);
    }
    if (!analysis) {
      agent.status = 'error';
      agent.log.push('Page analysis failed after 3 attempts — content script not reachable');
      cleanup(agent.id);
      broadcastAgents();
      return;
    }

    // AI decision — compact history if needed, strip old images
    let history = agentHistories.get(agent.id) || [];
    const tokensBefore = estimateTokens(history);
    if (tokensBefore > COMPACT_THRESHOLD) {
      agent.log.push(`[compact] ~${Math.round(tokensBefore/1000)}k tokens — compacting`);
      broadcastAgents();
      history = await compactHistory(agent.goal, history);
      agentHistories.set(agent.id, history);
    }

    // Only keep last N turns, strip images from old ones
    const cappedHistory = stripImagesFromHistory(history.slice(-(MAX_HISTORY_TURNS * 2)));

    const userContent = [];
    const dataCtx = (agent.extractedData && agent.extractedData.length > 0)
      ? `\n\nData collected so far:\n${agent.extractedData.join('\n')}`
      : '';
    const pageContent = analysis.content ? `\n\nPage content:\n${analysis.content}` : '';
    userContent.push({
      type: 'text',
      text: `URL: ${analysis.url}\nTitle: ${analysis.title}\n\nInteractive elements:\n${analysis.tree}${pageContent}${dataCtx}\n\nGoal: "${agent.goal}"\nWhat is the next single action? JSON only.`
    });

    const messages = [...cappedHistory, { role: 'user', content: userContent }];

    let action;
    try {
      const response = await callWithRotation(AGENT_SYSTEM, messages, 300);
      const raw = getText(response);
      apiRetries = 0;

      if (!raw || raw.trim().length === 0) {
        agent.log.push('[retry] Empty response');
        broadcastAgents();
        step++;
        continue;
      }

      // Handle non-JSON responses
      if (!raw.trimStart().startsWith('{')) {
        if (PLANNING_RE.test(raw) || REASONING_RE.test(raw)) {
          agent.log.push('[retry] Got prose instead of action JSON — retrying');
          const retryMsgs = [...messages,
            { role: 'assistant', content: raw },
            { role: 'user', content: 'Respond ONLY with the JSON action object. No explanation.' }
          ];
          const r2 = await callWithRotation(AGENT_SYSTEM, retryMsgs, 300);
          const raw2 = getText(r2);
          const cleaned2 = raw2.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          try { action = JSON.parse(cleaned2); } catch {
            action = { action: 'done', reason: 'Could not parse response', isDone: true };
          }
          agentHistories.set(agent.id, [...messages, { role: 'assistant', content: raw2 }]);
        } else {
          const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          try { action = JSON.parse(cleaned); } catch {
            action = { action: 'done', reason: 'Unparseable response', isDone: true };
          }
          agentHistories.set(agent.id, [...messages, { role: 'assistant', content: raw }]);
        }
      } else {
        action = JSON.parse(raw);
        agentHistories.set(agent.id, [...messages, { role: 'assistant', content: raw }]);
      }
    } catch (err) {
      if (isRateLimit(err) && apiRetries < 3) {
        apiRetries++;
        agent.log.push(`[retry] Rate limited — waiting ${apiRetries * 2}s`);
        broadcastAgents();
        await sleep(apiRetries * 2000);
        continue;
      }
      if (isAuthError(err)) {
        agent.status = 'error';
        agent.log.push('API key invalid. Check Settings.');
      } else {
        agent.status = 'error';
        agent.log.push(`API error: ${err.message}`);
      }
      cleanup(agent.id);
      broadcastAgents();
      return;
    }

    agent.log.push(`[${action.action}] ${action.reason || action.plan || ''}`);
    broadcastAgents();

    // Handle extract action — save data for comparison
    if (action.action === 'extract' && action.extractedData) {
      if (!agent.extractedData) agent.extractedData = [];
      agent.extractedData.push(action.extractedData);
      agent.log.push(`[data] ${action.extractedData.slice(0, 100)}`);
      broadcastAgents();
      step++;
      await sleep(500);
      continue;
    }

    // Done
    if (action.isDone || action.action === 'done') {
      // Use Claude's own finalSummary if provided, otherwise generate one
      if (action.finalSummary) {
        agent.finalAnswer = action.finalSummary;
      } else {
        try {
          const snap = await getPageAnalysis(tabId);
          const dataContext = (agent.extractedData && agent.extractedData.length > 0)
            ? `\n\nExtracted data:\n${agent.extractedData.join('\n')}`
            : '';
          const pageText = snap?.content ? `\n\nPage content:\n${snap.content}` : '';
          if (snap) {
            const r = await callWithRotation(
              'You are Luna. The user gave you a goal and you finished browsing. Give a clear, direct answer in plain English. Be specific. If comparing options, present a structured recommendation with key data points. Keep it under 6 sentences.',
              [{ role: 'user', content: `Goal: "${agent.goal}"\nSteps:\n${agent.log.slice(-8).map((l,i) => `${i+1}. ${l}`).join('\n')}${dataContext}\nPage: ${snap.url} — ${snap.title}\nElements:\n${snap.tree}${pageText}\nDirect answer with recommendation?` }],
              256,
              'claude-haiku-4-5-20251001'
            );
            agent.finalAnswer = getText(r) || 'Task completed.';
          }
        } catch { agent.finalAnswer = action.reason || 'Task completed.'; }
      }
      agent.status = 'done';
      cleanup(agent.id);
      broadcastAgents();
      return;
    }

    // Loop detection
    const key = `${analysis.url}|${action.action}|${action.elementIndex ?? action.url ?? ''}`;
    recentKeys.push(key);
    if (recentKeys.length > 5) recentKeys.shift();
    if (recentKeys.length >= 3 && recentKeys.slice(-3).every(k => k === key)) {
      agent.log.push('[stuck] Same action repeated 3x — trying different approach');
      const h = agentHistories.get(agent.id) || [];
      agentHistories.set(agent.id, [...h,
        { role: 'user', content: 'The last 3 actions were identical. Try something completely different.' },
        { role: 'assistant', content: 'Understood. I will try a different approach.' }
      ]);
      broadcastAgents();
      step++;
      continue;
    }

    // Execute action
    if (action.action === 'navigate' && action.url) {
      try {
        await chrome.tabs.update(tabId, { url: action.url });
        await waitForTabReady(tabId, 15000);
        await sleep(500);
      } catch (e) { agent.log.push(`Navigate failed: ${e.message}`); }
    } else if (action.action === 'go_back') {
      try { await chrome.tabs.goBack(tabId); await waitForTabReady(tabId, 10000); }
      catch (e) { agent.log.push(`Go back failed: ${e.message}`); }
    } else if (action.action === 'wait') {
      await sleep(2000);
    } else {
      await executeOnTab(tabId, action);
    }

    await sleep(1500);
    step++;
  }
}

function cleanup(agentId) {
  agentHistories.delete(agentId);
  agentTabs.delete(agentId);
  pausedAgents.delete(agentId);
  correctionQueue.delete(agentId);
}

// ─── Automation Manager ──────────────────────────────────────────────────────

let automations = [];
let isRecording = false;
let recordingTabId = null;
let recordingSteps = [];
let recordingStartUrl = null;
let recordingName = '';
let runningAutomationId = null;
let automationStopped = false;

async function loadAutomations() {
  const { lunaAutomations } = await chrome.storage.local.get('lunaAutomations');
  automations = lunaAutomations || [];
}

async function persistAutomations() {
  await chrome.storage.local.set({ lunaAutomations: automations });
}

function broadcastAutomations() {
  chrome.runtime.sendMessage({ type: 'automationUpdate', automations, isRecording, recordingSteps, recordingStartUrl }).catch(() => {});
}

async function startRecording(tabId) {
  isRecording = true;
  recordingTabId = tabId;
  recordingSteps = [];
  try {
    const tab = await chrome.tabs.get(tabId);
    recordingStartUrl = (tab.url && !tab.url.startsWith('chrome')) ? tab.url : null;
  } catch {
    recordingStartUrl = null;
  }
  chrome.tabs.sendMessage(tabId, { type: 'startRecording' }).catch(() => {});
  broadcastAutomations();
}

function stopRecording(name) {
  isRecording = false;
  if (recordingTabId) {
    chrome.tabs.sendMessage(recordingTabId, { type: 'stopRecording' }).catch(() => {});
  }
  if (recordingSteps.length > 0) {
    const automation = {
      id: crypto.randomUUID(),
      name: name || `Recording ${new Date().toLocaleTimeString()}`,
      steps: [...recordingSteps],
      startUrl: recordingStartUrl || null,
      loopEnabled: false,
      isRunning: false,
      createdAt: Date.now(),
    };
    automations.push(automation);
    persistAutomations();
  }
  recordingSteps = [];
  recordingTabId = null;
  recordingStartUrl = null;
  broadcastAutomations();
}

function addRecordedStep(step) {
  if (!isRecording) return;
  recordingSteps.push(step);
  broadcastAutomations();
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 400); // brief settle after load
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function executeStepWithRetry(tabId, step, maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'replayStep', step });
    } catch {
      if (i < maxAttempts - 1) await sleep(800);
    }
  }
  return null;
}

async function playAutomation(id) {
  const auto = automations.find(a => a.id === id);
  if (!auto || auto.isRunning) return;
  auto.isRunning = true;
  runningAutomationId = id;
  automationStopped = false;
  broadcastAutomations();

  if (auto.startUrl) {
    const tabId = await getActiveTabId();
    if (tabId) {
      await chrome.tabs.update(tabId, { url: auto.startUrl });
      await waitForTabLoad(tabId);
    }
  }

  const variables = {};
  const ELEMENT_STEPS = new Set(['click', 'type', 'select', 'hover', 'extract']);

  do {
    for (const step of auto.steps) {
      if (automationStopped) break;
      const tabId = await getActiveTabId();
      if (!tabId) break;

      if (step.type === 'navigate') {
        await chrome.tabs.update(tabId, { url: step.url });
        await waitForTabLoad(tabId);
        continue;
      }

      // Wait for element before interacting
      if (step.selector && ELEMENT_STEPS.has(step.type)) {
        await chrome.tabs.sendMessage(tabId, { type: 'waitForElement', selector: step.selector, timeoutMs: 5000 }).catch(() => {});
      }

      // Interpolate {{varName}} in type step values
      const replayable = (step.type === 'type' && step.value?.includes('{{'))
        ? { ...step, value: step.value.replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k] ?? '') }
        : step;

      const result = await executeStepWithRetry(tabId, replayable);

      // Store extracted value as a named variable
      if (step.type === 'extract' && step.variable && result?.value !== undefined) {
        variables[step.variable] = result.value;
      }

      await sleep(step.delay || 800);
    }
    if (automationStopped) break;
    if (auto.loopEnabled) await sleep(1000);
  } while (auto.loopEnabled && !automationStopped);

  auto.isRunning = false;
  runningAutomationId = null;
  broadcastAutomations();
}

function stopAutomationPlayback(id) {
  automationStopped = true;
  const auto = automations.find(a => a.id === id);
  if (auto) auto.isRunning = false;
  broadcastAutomations();
}

function deleteAutomation(id) {
  if (runningAutomationId === id) automationStopped = true;
  automations = automations.filter(a => a.id !== id);
  persistAutomations();
  broadcastAutomations();
}

function toggleLoop(id, enabled) {
  const auto = automations.find(a => a.id === id);
  if (auto) { auto.loopEnabled = enabled; persistAutomations(); broadcastAutomations(); }
}

function renameAutomation(id, name) {
  const auto = automations.find(a => a.id === id);
  if (auto) { auto.name = name; persistAutomations(); broadcastAutomations(); }
}

function updateStartUrl(id, startUrl) {
  const auto = automations.find(a => a.id === id);
  if (auto) { auto.startUrl = startUrl; persistAutomations(); broadcastAutomations(); }
}

// ─── Tab navigation during recording ────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (isRecording && tabId === recordingTabId && changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { type: 'startRecording' }).catch(() => {});
    if (changeInfo.url) {
      addRecordedStep({ type: 'navigate', url: changeInfo.url, timestamp: Date.now(), description: `Navigate to ${changeInfo.url}` });
    }
  }
});

// ─── Extension lifecycle ─────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  loadAutomations();
});

chrome.tabs.onActivated.addListener(({ windowId }) => {
  chrome.sidePanel.open({ windowId }).catch(() => {});
});

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // Settings
    case 'getSettings':
      getSettings().then(s => sendResponse(s));
      return true;
    case 'saveSettings':
      saveSettings(msg.updates).then(s => { initKeys(); sendResponse(s); });
      return true;
    case 'saveApiKey':
      saveSettings({ apiKey: msg.key }).then(() => { initKeys(); sendResponse({ ok: true }); });
      return true;
    case 'testApiKey':
      initKeys().then(() => testApiKey()).then(r => sendResponse(r));
      return true;

    // Agents
    case 'createAgent':
      createAgent(msg.goal, msg.maxSteps).then(a => sendResponse({ ok: true, agentId: a.id }));
      return true;
    case 'stopAgent':
      stopAgent(msg.agentId);
      sendResponse({ ok: true });
      return false;
    case 'pauseAgent':
      pauseAgent(msg.agentId);
      sendResponse({ ok: true });
      return false;
    case 'resumeAgent':
      resumeAgent(msg.agentId, msg.correction);
      sendResponse({ ok: true });
      return false;
    case 'getAgents':
      sendResponse([...agents.values()]);
      return false;
    case 'removeAgent':
      removeAgent(msg.agentId);
      sendResponse({ ok: true });
      return false;

    // Automations
    case 'getAutomations':
      loadAutomations().then(() => sendResponse({ automations, isRecording, recordingSteps, recordingStartUrl }));
      return true;
    case 'startRecording':
      getActiveTabId().then(tabId => { if (tabId) startRecording(tabId); sendResponse({ ok: true }); });
      return true;
    case 'stopRecording':
      stopRecording(msg.name);
      sendResponse({ ok: true });
      return false;
    case 'playAutomation':
      playAutomation(msg.id);
      sendResponse({ ok: true });
      return false;
    case 'stopAutomation':
      stopAutomationPlayback(msg.id);
      sendResponse({ ok: true });
      return false;
    case 'deleteAutomation':
      deleteAutomation(msg.id);
      sendResponse({ ok: true });
      return false;
    case 'toggleLoop':
      toggleLoop(msg.id, msg.enabled);
      sendResponse({ ok: true });
      return false;
    case 'renameAutomation':
      renameAutomation(msg.id, msg.name);
      sendResponse({ ok: true });
      return false;
    case 'updateStartUrl':
      updateStartUrl(msg.id, msg.startUrl);
      sendResponse({ ok: true });
      return false;

    // Recording step from content script
    case 'recordedStep':
      addRecordedStep(msg.step);
      return false;

    // Side panel requests panel open
    case 'openPanel':
      if (sender.tab?.windowId) chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      return false;
  }
});

// Boot
loadAutomations();
