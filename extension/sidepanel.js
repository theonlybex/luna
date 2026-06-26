// ═══════════════════════════════════════════════════════════════════════════════
// sidepanel.js — Luna Side Panel UI
//
// Communicates with background.js via chrome.runtime.sendMessage/onMessage.
// Two views: Agents and Automations, toggled by nav buttons.
// ═══════════════════════════════════════════════════════════════════════════════

const STATUS_COLORS = {
  thinking: '#94a3b8', running: '#6366f1',
  waiting: '#fbbf24', done: '#10b981',
  error: '#f43f5e', stopped: '#94a3b8'
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const agentsView  = document.getElementById('agents-view');
const autosView   = document.getElementById('automations-view');
const navAgents   = document.getElementById('nav-agents');
const navAutos    = document.getElementById('nav-autos');
const agentListEl = document.getElementById('agent-list');
const agentChatPanel = document.getElementById('agent-chat-panel');
const loginScreen = document.getElementById('login-screen');
const inputScreen = document.getElementById('input-screen');
const loginBtn    = document.getElementById('login-btn');
const apikeyForm  = document.getElementById('apikey-form');
const apikeyInp   = document.getElementById('apikey-inp');
const apikeyErr   = document.getElementById('apikey-err');
const apikeySave  = document.getElementById('apikey-save');
const apikeyCancel= document.getElementById('apikey-cancel');
const inputTa     = document.getElementById('input-ta');
const inputSubmit = document.getElementById('input-submit');
const stepOpts    = document.querySelectorAll('.step-opt');

// Automations
const autoListContainer = document.getElementById('auto-list-container');
const autoList          = document.getElementById('auto-list');
const autoDetail        = document.getElementById('auto-detail');
const autoDetailName    = document.getElementById('auto-detail-name');
const autoDetailBody    = document.getElementById('auto-detail-body');
const autoStartUrl      = document.getElementById('auto-start-url');
const recordBtn         = document.getElementById('record-btn');
const playBtn           = document.getElementById('play-btn');
const stopPlayBtn       = document.getElementById('stop-play-btn');
const delAutoBtn        = document.getElementById('del-auto-btn');
const loopCheckbox      = document.getElementById('loop-checkbox');
const recordingView     = document.getElementById('recording-view');
const recordingStepsEl  = document.getElementById('recording-steps');
const stopRecBtn        = document.getElementById('stop-rec-btn');
const recNameInput      = document.getElementById('rec-name-input');

// ─── State ────────────────────────────────────────────────────────────────────

const agentRegistry = new Map();
let activeTab = 'luna';
let currentView = 'agents';
let selectedAutoId = null;
let isRecording = false;
let automations = [];

// ─── View Navigation ──────────────────────────────────────────────────────────

navAgents.addEventListener('click', () => switchView('agents'));
navAutos.addEventListener('click', () => switchView('automations'));

function switchView(view) {
  currentView = view;
  navAgents.classList.toggle('active', view === 'agents');
  navAutos.classList.toggle('active', view === 'automations');
  agentsView.classList.toggle('active', view === 'agents');
  autosView.classList.toggle('active', view === 'automations');
  if (view === 'automations') refreshAutomations();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENTS
// ═══════════════════════════════════════════════════════════════════════════════

function switchTab(tabId) {
  activeTab = tabId;
  // Update list selection
  document.querySelectorAll('.agent-list-item').forEach(el => {
    el.classList.toggle('active', el.dataset.agentId === tabId);
  });
  if (tabId === 'luna') {
    loginScreen.style.display = 'none';
    inputScreen.style.display = 'flex';
    agentRegistry.forEach(d => { d.screenEl.style.display = 'none'; });
  } else {
    loginScreen.style.display = 'none';
    inputScreen.style.display = 'none';
    agentRegistry.forEach((d, id) => {
      d.screenEl.style.display = id === tabId ? 'flex' : 'none';
    });
  }
}

function ensureAgentTab(agent) {
  if (agentRegistry.has(agent.id)) return false;

  const screenEl = document.createElement('div');
  screenEl.className = 'agent-screen';
  screenEl.style.display = 'none';

  // Virtual scroll container — only renders visible entries
  const msgsEl = document.createElement('div');
  msgsEl.className = 'agent-msgs';

  const vSpacer = document.createElement('div');
  vSpacer.className = 'v-spacer';
  vSpacer.style.position = 'relative';
  vSpacer.style.width = '100%';
  msgsEl.appendChild(vSpacer);

  screenEl.appendChild(msgsEl);

  const barEl = document.createElement('div');
  barEl.className = 'agent-bar';
  barEl.style.display = 'none';

  const correctionTa = document.createElement('textarea');
  correctionTa.className = 'agent-correction';
  correctionTa.placeholder = 'Add context or correction…';
  correctionTa.style.display = 'none';

  const btnsEl = document.createElement('div');
  btnsEl.className = 'agent-bar-btns';
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'agent-bar-btn';
  pauseBtn.textContent = 'Pause';
  const stopBtn = document.createElement('button');
  stopBtn.className = 'agent-bar-btn stop';
  stopBtn.textContent = 'Stop';

  btnsEl.appendChild(pauseBtn);
  btnsEl.appendChild(stopBtn);
  barEl.appendChild(correctionTa);
  barEl.appendChild(btnsEl);
  screenEl.appendChild(barEl);
  agentChatPanel.appendChild(screenEl);

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stopAgent', agentId: agent.id });
  });

  pauseBtn.addEventListener('click', () => {
    const data = agentRegistry.get(agent.id);
    if (!data) return;
    if (data.paused) {
      const correction = correctionTa.value.trim();
      chrome.runtime.sendMessage({ type: 'resumeAgent', agentId: agent.id, correction: correction || undefined });
      correctionTa.value = '';
    } else {
      chrome.runtime.sendMessage({ type: 'pauseAgent', agentId: agent.id });
    }
  });

  // Virtual scroll: attach scroll handler for re-rendering visible entries
  let vRenderPending = false;
  msgsEl.addEventListener('scroll', () => {
    if (!vRenderPending) {
      vRenderPending = true;
      requestAnimationFrame(() => {
        vRenderVisible(agent.id);
        vRenderPending = false;
      });
    }
  });

  agentRegistry.set(agent.id, {
    screenEl, msgsEl, vSpacer, barEl, correctionTa, pauseBtn, stopBtn,
    stepsShown: 0, stepNum: 0, ended: false, paused: false,
    // Virtual scroll state
    allEntries: [],     // { type: 'sys'|'step'|'final', html: string, height: ROW_HEIGHT }
    autoScroll: true    // follow tail until user scrolls up
  });
  return true;
}

// ─── Virtual scroll constants ─────────────────────────────────────────────────

const V_ROW_SYS   = 28;   // estimated height of a system note row
const V_ROW_STEP  = 56;   // estimated height of a step bubble
const V_ROW_FINAL = 72;   // estimated height of the final answer
const V_BUFFER    = 5;    // extra rows to render above/below viewport

/**
 * vRenderVisible — re-renders only the entries visible in the scroll viewport.
 * Called on scroll (throttled via rAF) and after new entries are added.
 */
function vRenderVisible(agentId) {
  const data = agentRegistry.get(agentId);
  if (!data || data.allEntries.length === 0) return;

  const { msgsEl, vSpacer, allEntries } = data;
  const scrollTop = msgsEl.scrollTop;
  const viewH = msgsEl.clientHeight;

  // Calculate total height and find visible range
  let totalH = 0;
  const offsets = [];
  for (const entry of allEntries) {
    offsets.push(totalH);
    totalH += entry.height;
  }

  vSpacer.style.height = totalH + 'px';

  // Find first visible entry
  let startIdx = 0;
  for (let i = 0; i < allEntries.length; i++) {
    if (offsets[i] + allEntries[i].height > scrollTop) { startIdx = i; break; }
  }

  // Find last visible entry
  let endIdx = allEntries.length - 1;
  for (let i = startIdx; i < allEntries.length; i++) {
    if (offsets[i] > scrollTop + viewH) { endIdx = i; break; }
  }

  // Apply buffer
  startIdx = Math.max(0, startIdx - V_BUFFER);
  endIdx = Math.min(allEntries.length - 1, endIdx + V_BUFFER);

  // Clear and re-render only visible range
  // Keep the spacer, remove rendered entries
  while (vSpacer.firstChild) vSpacer.removeChild(vSpacer.firstChild);

  for (let i = startIdx; i <= endIdx; i++) {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = offsets[i] + 'px';
    el.style.left = '0';
    el.style.right = '0';
    el.innerHTML = allEntries[i].html;
    vSpacer.appendChild(el);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'getSettings' });
    if (s.apiKey) {
      showAgentInput();
    } else {
      showLogin();
    }
    // Get existing agents
    const agents = await chrome.runtime.sendMessage({ type: 'getAgents' });
    if (agents) renderAgents(agents);
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginScreen.style.display = 'flex';
  inputScreen.style.display = 'none';
}

function showAgentInput() {
  loginScreen.style.display = 'none';
  inputScreen.style.display = 'flex';
  activeTab = 'luna';
  document.querySelectorAll('.agent-list-item').forEach(el => {
    el.classList.remove('active');
  });
  agentRegistry.forEach(d => { d.screenEl.style.display = 'none'; });
}

// ─── API key ──────────────────────────────────────────────────────────────────

loginBtn.addEventListener('click', () => {
  loginBtn.style.display = 'none';
  apikeyForm.style.display = 'flex';
  apikeyInp.focus();
});

apikeyCancel.addEventListener('click', () => {
  apikeyForm.style.display = 'none';
  loginBtn.style.display = 'block';
});

apikeyInp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); apikeySave.click(); }
});

apikeySave.addEventListener('click', async () => {
  const key = apikeyInp.value.trim();
  if (!key.startsWith('sk-ant-')) { apikeyErr.style.display = 'block'; return; }
  apikeyErr.style.display = 'none';
  apikeySave.disabled = true;
  apikeySave.textContent = 'Saving…';
  await chrome.runtime.sendMessage({ type: 'saveApiKey', key });
  apikeySave.disabled = false;
  apikeySave.textContent = 'Save & continue';
  showAgentInput();
});

// Settings
document.getElementById('settings-btn').addEventListener('click', async () => {
  const s = await chrome.runtime.sendMessage({ type: 'getSettings' });
  apikeyInp.value = s.apiKey || '';
  showLogin();
  loginBtn.style.display = 'none';
  apikeyForm.style.display = 'flex';
  apikeyInp.focus();
});

// + New agent button
document.getElementById('new-agent-btn').addEventListener('click', () => showAgentInput());

// Step selector
stepOpts.forEach(btn => {
  btn.addEventListener('click', () => {
    stepOpts.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

function selectedMaxSteps() {
  const sel = document.querySelector('.step-opt.selected');
  return sel ? parseInt(sel.dataset.steps, 10) : 25;
}

// Submit agent
inputSubmit.addEventListener('click', async () => {
  const text = inputTa.value.trim();
  if (!text) return;
  inputSubmit.disabled = true;
  inputSubmit.textContent = 'Starting…';
  try {
    await chrome.runtime.sendMessage({ type: 'createAgent', goal: text, maxSteps: selectedMaxSteps() });
    inputTa.value = '';
  } finally {
    inputSubmit.disabled = false;
    inputSubmit.textContent = 'Run Agent';
  }
});

inputTa.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); inputSubmit.click(); }
});

// ─── Agent rendering ──────────────────────────────────────────────────────────

const SYS_PREFIXES = ['[tokens]', '[compact]', '[stuck]', '[retry]', '[correction]', '[plan]', '[data]'];

function isSysEntry(entry) {
  return SYS_PREFIXES.some(p => entry.startsWith(p));
}

function parseStep(entry) {
  const m = entry.match(/^\[([^\]]+)\]\s*(.*)$/s);
  return m ? { action: m[1], reason: m[2].trim() } : { action: null, reason: entry };
}

function renderAgents(agents) {
  // Rebuild the agent list panel
  agentListEl.innerHTML = '';
  if (agents.length === 0) {
    agentListEl.innerHTML = '<div class="agent-list-empty">No agents yet.<br>Click <strong>+ New</strong> to create one.</div>';
  }
  agents.forEach(agent => {
    const color = STATUS_COLORS[agent.status] || '#94a3b8';
    const active = agent.status === 'thinking' || agent.status === 'running';
    const goalLabel = agent.goal.length > 40 ? agent.goal.slice(0, 40) + '…' : agent.goal;

    const li = document.createElement('div');
    li.className = 'agent-list-item' + (agent.id === activeTab ? ' active' : '');
    li.dataset.agentId = agent.id;
    li.innerHTML = `
      <span class="agent-list-dot ${active ? 'pulse' : ''}" style="background:${color}"></span>
      <div class="agent-list-info">
        <div class="agent-list-goal">${esc(goalLabel)}</div>
        <div class="agent-list-status">${esc(agent.status)}</div>
      </div>
      <button class="agent-list-remove" title="Remove agent">×</button>`;
    li.querySelector('.agent-list-info').addEventListener('click', () => switchTab(agent.id));
    li.querySelector('.agent-list-dot').addEventListener('click', () => switchTab(agent.id));
    li.querySelector('.agent-list-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'removeAgent', agentId: agent.id });
      // Clean up local UI
      const data = agentRegistry.get(agent.id);
      if (data) { data.screenEl.remove(); agentRegistry.delete(agent.id); }
      if (activeTab === agent.id) showAgentInput();
    });
    agentListEl.appendChild(li);
  });

  // Update each agent's chat screen
  agents.forEach(agent => {
    const isNew = ensureAgentTab(agent);
    const data = agentRegistry.get(agent.id);
    if (!data) return;

    const active = agent.status === 'thinking' || agent.status === 'running';
    const paused = agent.status === 'waiting';
    const ended = agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped';
    const color = STATUS_COLORS[agent.status] || '#94a3b8';

    data.barEl.style.display = ended ? 'none' : 'flex';

    if (paused !== data.paused) {
      data.paused = paused;
      data.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      data.pauseBtn.classList.toggle('resume', paused);
      data.correctionTa.style.display = paused ? 'block' : 'none';
    }

    const newSteps = agent.log.slice(data.stepsShown);
    let stepNum = data.stepNum;
    let entriesAdded = false;

    newSteps.forEach(entry => {
      if (isSysEntry(entry)) {
        data.allEntries.push({
          type: 'sys',
          html: `<div class="sys-note">${esc(entry)}</div>`,
          height: V_ROW_SYS
        });
      } else {
        stepNum++;
        const { action, reason } = parseStep(entry);
        data.allEntries.push({
          type: 'step',
          html: `<div class="msg luna">` +
            `<div class="sender">Step ${stepNum}</div>` +
            `<div class="bubble">` +
            (action ? `<span class="step-tag">[${esc(action)}]</span>` : '') +
            esc(reason) + `</div></div>`,
          height: V_ROW_STEP
        });
      }
      entriesAdded = true;
    });
    data.stepNum = stepNum;
    data.stepsShown = agent.log.length;

    if (!data.ended && ended) {
      data.ended = true;
      if (agent.status === 'done' && agent.finalAnswer) {
        data.allEntries.push({
          type: 'final',
          html: `<div class="msg luna"><div class="sender">Luna</div><div class="bubble">${esc(agent.finalAnswer)}</div></div>`,
          height: V_ROW_FINAL
        });
      } else {
        const label = { done: 'Completed', error: 'Error', stopped: 'Stopped' };
        data.allEntries.push({
          type: 'final',
          html: `<div class="msg luna"><div class="sender">Agent</div><div class="bubble" style="color:${color}">${label[agent.status] || agent.status}</div></div>`,
          height: V_ROW_FINAL
        });
      }
      entriesAdded = true;
    }

    // Re-render virtual scroll and auto-scroll to bottom if following
    if (entriesAdded) {
      vRenderVisible(agent.id);
      if (data.autoScroll) {
        // Calculate total height and scroll to bottom
        const totalH = data.allEntries.reduce((sum, e) => sum + e.height, 0);
        data.vSpacer.style.height = totalH + 'px';
        data.msgsEl.scrollTop = data.msgsEl.scrollHeight;
        vRenderVisible(agent.id);
      }
    }

    if (isNew) switchTab(agent.id);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshAutomations() {
  const data = await chrome.runtime.sendMessage({ type: 'getAutomations' });
  automations = data.automations || [];
  isRecording = data.isRecording || false;
  renderAutomationList();
  updateRecordingUI(data);
}

function renderAutomationList() {
  autoList.innerHTML = '';
  if (automations.length === 0) {
    autoList.innerHTML = '<div class="auto-empty">No automations yet.<br>Click <strong>Record New</strong> to create one.</div>';
    return;
  }
  automations.forEach(auto => {
    const el = document.createElement('div');
    el.className = 'auto-item' + (auto.id === selectedAutoId ? ' selected' : '');
    const stepsLabel = `${auto.steps.length} step${auto.steps.length !== 1 ? 's' : ''}`;
    const status = auto.isRunning
      ? '<span class="auto-item-running">▶ Running</span>'
      : (auto.loopEnabled ? '🔁 Loop' : '');
    el.innerHTML = `
      <div class="auto-item-name">${esc(auto.name)}</div>
      <div class="auto-item-meta">
        <span class="auto-item-steps">${stepsLabel}</span>
        ${status}
      </div>`;
    el.addEventListener('click', () => selectAutomation(auto.id));
    autoList.appendChild(el);
  });
}

function selectAutomation(id) {
  selectedAutoId = id;
  const auto = automations.find(a => a.id === id);
  if (!auto) return;

  renderAutomationList();
  autoListContainer.style.display = 'none';
  recordingView.style.display = 'none';
  autoDetail.style.display = 'flex';

  autoDetailName.value = auto.name;
  loopCheckbox.checked = auto.loopEnabled || false;

  autoStartUrl.value = auto.startUrl || '';

  playBtn.style.display = auto.isRunning ? 'none' : 'flex';
  stopPlayBtn.style.display = auto.isRunning ? 'flex' : 'none';

  renderDetailSteps(auto.steps);
}

function renderDetailSteps(steps) {
  autoDetailBody.innerHTML = '';
  if (steps.length === 0) {
    autoDetailBody.innerHTML = '<div class="auto-empty">No steps recorded.</div>';
    return;
  }
  const ICONS = { click: '👆', type: '⌨️', keypress: '⏎', scroll: '↕️', navigate: '🌐', select: '📋', hover: '🖱️', extract: '📤' };
  steps.forEach((step, i) => {
    const el = document.createElement('div');
    el.className = 'recorded-step';
    const coords = step.x !== undefined ? `(${step.x}, ${step.y})` : '';
    el.innerHTML = `
      <span class="recorded-step-num">${i + 1}</span>
      <span class="recorded-step-icon">${ICONS[step.type] || '•'}</span>
      <span class="recorded-step-desc">${esc(step.description || step.type)}</span>
      ${coords ? `<span class="recorded-step-coords">${coords}</span>` : ''}`;
    autoDetailBody.appendChild(el);
  });
}

function backToList() {
  selectedAutoId = null;
  autoDetail.style.display = 'none';
  recordingView.style.display = 'none';
  autoListContainer.style.display = 'flex';
  renderAutomationList();
}

function updateRecordingUI(data) {
  if (data.isRecording) {
    autoListContainer.style.display = 'none';
    autoDetail.style.display = 'none';
    recordingView.style.display = 'flex';
    recordBtn.classList.add('recording');
    recordBtn.innerHTML = '<span class="rec-dot"></span> Recording...';

    // Show live steps
    recordingStepsEl.innerHTML = '';
    const ICONS = { click: '👆', type: '⌨️', keypress: '⏎', scroll: '↕️', navigate: '🌐', select: '📋', hover: '🖱️', extract: '📤' };
    (data.recordingSteps || []).forEach((step, i) => {
      const el = document.createElement('div');
      el.className = 'recorded-step';
      const coords = step.x !== undefined ? `(${step.x}, ${step.y})` : '';
      el.innerHTML = `
        <span class="recorded-step-num">${i + 1}</span>
        <span class="recorded-step-icon">${ICONS[step.type] || '•'}</span>
        <span class="recorded-step-desc">${esc(step.description || step.type)}</span>
        ${coords ? `<span class="recorded-step-coords">${coords}</span>` : ''}`;
      recordingStepsEl.appendChild(el);
    });
    recordingStepsEl.scrollTop = recordingStepsEl.scrollHeight;
  } else {
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#fff;flex-shrink:0"></span> Record New';
    if (recordingView.style.display === 'flex') {
      // Recording just stopped — go back to list
      backToList();
    }
  }
}

// ─── Automation event handlers ────────────────────────────────────────────────

recordBtn.addEventListener('click', () => {
  if (isRecording) return;
  chrome.runtime.sendMessage({ type: 'startRecording' });
  isRecording = true;
  autoListContainer.style.display = 'none';
  autoDetail.style.display = 'none';
  recordingView.style.display = 'flex';
  recordingStepsEl.innerHTML = '';
  recNameInput.value = '';
  recordBtn.classList.add('recording');
  recordBtn.innerHTML = '<span class="rec-dot"></span> Recording...';
});

stopRecBtn.addEventListener('click', () => {
  const name = recNameInput.value.trim();
  chrome.runtime.sendMessage({ type: 'stopRecording', name });
  isRecording = false;
  setTimeout(() => refreshAutomations(), 300);
});

playBtn.addEventListener('click', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'playAutomation', id: selectedAutoId });
  playBtn.style.display = 'none';
  stopPlayBtn.style.display = 'flex';
});

stopPlayBtn.addEventListener('click', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'stopAutomation', id: selectedAutoId });
  playBtn.style.display = 'flex';
  stopPlayBtn.style.display = 'none';
});

delAutoBtn.addEventListener('click', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'deleteAutomation', id: selectedAutoId });
  backToList();
  setTimeout(() => refreshAutomations(), 200);
});

loopCheckbox.addEventListener('change', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'toggleLoop', id: selectedAutoId, enabled: loopCheckbox.checked });
});

autoDetailName.addEventListener('change', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'renameAutomation', id: selectedAutoId, name: autoDetailName.value });
});

autoStartUrl.addEventListener('change', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'updateStartUrl', id: selectedAutoId, startUrl: autoStartUrl.value.trim() || null });
});

// Back button in detail view (click the automation list area to go back)
autoDetail.addEventListener('click', (e) => {
  // Only the header back area — handled via a small invisible back button
});

// ─── Add a back button to detail header ───────────────────────────────────────

const backBtn = document.createElement('button');
backBtn.className = 'detail-btn';
backBtn.textContent = '← Back';
backBtn.style.marginRight = '8px';
backBtn.addEventListener('click', backToList);
document.getElementById('auto-detail-hdr').insertBefore(backBtn, autoDetailName);

// ─── Replay status UI (human-behavior replay in the Playwright instance) ──────

const replayStatusEl = document.createElement('div');
replayStatusEl.id = 'replay-status';
replayStatusEl.style.cssText = 'display:none;font-size:12px;padding:8px 12px;margin-top:8px;border-radius:8px;background:rgba(99,102,241,0.12);color:#c7d2fe;line-height:1.45;';
autoDetail.appendChild(replayStatusEl);

const resumeBtn = document.createElement('button');
resumeBtn.className = 'detail-btn';
resumeBtn.textContent = 'Resume';
resumeBtn.style.display = 'none';
resumeBtn.addEventListener('click', () => {
  if (!selectedAutoId) return;
  chrome.runtime.sendMessage({ type: 'resumeAutomation', id: selectedAutoId });
  resumeBtn.style.display = 'none';
});
stopPlayBtn.parentNode.insertBefore(resumeBtn, stopPlayBtn.nextSibling);

function renderReplayStatus(s) {
  if (!s || s.status === 'idle') { replayStatusEl.style.display = 'none'; resumeBtn.style.display = 'none'; return; }
  const step = (s.stepIndex ?? 0) + 1;
  const total = s.totalSteps ?? 0;
  const loop = s.iteration > 1 ? ` · loop ${s.iteration}` : '';
  let txt = '';
  if (s.status === 'running')             txt = `▶ Running step ${step}/${total}${loop}${s.stepDescription ? ' — ' + esc(s.stepDescription) : ''}`;
  else if (s.status === 'paused-on-step') txt = `⏸ Paused on step ${step}/${total} — ${esc(s.reason || 'verification failed')}`;
  else if (s.status === 'failed')         txt = `✕ Failed: ${esc(s.reason || '')}`;
  else if (s.status === 'done')           txt = '✓ Done';
  else if (s.status === 'stopped')        txt = '■ Stopped';
  replayStatusEl.innerHTML = txt;
  replayStatusEl.style.display = 'block';

  const active = s.status === 'running' || s.status === 'paused-on-step';
  resumeBtn.style.display = s.status === 'paused-on-step' ? 'inline-flex' : 'none';
  playBtn.style.display = active ? 'none' : 'flex';
  stopPlayBtn.style.display = active ? 'flex' : 'none';
  if (!active) setTimeout(() => { replayStatusEl.style.display = 'none'; }, 4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER — push updates from background
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'agentUpdate') {
    renderAgents(msg.agents);
  }
  if (msg.type === 'replayStatus') {
    if (currentView === 'automations' && selectedAutoId) renderReplayStatus(msg);
  }
  if (msg.type === 'automationUpdate') {
    automations = msg.automations || [];
    isRecording = msg.isRecording || false;
    if (currentView === 'automations') {
      if (selectedAutoId) {
        const auto = automations.find(a => a.id === selectedAutoId);
        if (auto) {
          playBtn.style.display = auto.isRunning ? 'none' : 'flex';
          stopPlayBtn.style.display = auto.isRunning ? 'flex' : 'none';
        }
        renderAutomationList();
      } else if (!isRecording) {
        renderAutomationList();
      }
      updateRecordingUI(msg);
    }
  }
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
