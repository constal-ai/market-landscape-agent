// Copyright 2026 Coresource AI, Inc. SPDX-License-Identifier: Apache-2.0
import { renderMarkdown } from './markdown.js';
const $ = (id) => document.getElementById(id);
const STORAGE = 'market-landscape-surveys';
const state = { busy: false, controller: null, current: null, history: [], timer: null };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});
const formatElapsed = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const formatDate = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const titleOf = (request) => request.trim().split('\n')[0].slice(0, 96);

function loadHistory() { try { const value = JSON.parse(localStorage.getItem(STORAGE) || '[]'); return Array.isArray(value) ? value.slice(0, 20) : []; } catch { return []; } }
function saveHistory() { try { localStorage.setItem(STORAGE, JSON.stringify(state.history.slice(0, 20))); } catch {} }

/** One request is one fresh Session; the report is the Run's final result. */
async function survey(request, signal, onProgress) {
  const requestId = crypto.randomUUID();
  const headers = { 'content-type': 'application/json', 'x-session-id': `ui-request-${requestId}`, 'idempotency-key': requestId, prefer: 'respond-async' };
  const body = JSON.stringify({ messages: [{ role: 'user', content: request }], stream: false });
  const deadline = Date.now() + 40 * 60 * 1000; let runId = null;
  while (Date.now() < deadline) {
    const response = runId ? await fetch(`/_constal/runs/${encodeURIComponent(runId)}`, { headers: { 'x-session-id': headers['x-session-id'] }, signal })
      : await fetch('/_constal/channel', { method: 'POST', headers, body, signal });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Your session expired. Open the workspace again from Console.');
    if (!response.ok) throw new Error(payload.error?.message ?? (typeof payload.error === 'string' ? payload.error : `The survey could not be started (${response.status}).`));
    runId = payload.runId ?? response.headers.get('x-session-run-id') ?? runId;
    if (['failed', 'stopped'].includes(payload.status)) throw new Error(payload.error ?? `The survey ${payload.status} before completion.`);
    if (response.status === 202 || (runId && payload.status !== 'complete')) { onProgress(payload.status ?? 'queued'); await delay(2000, signal); continue; }
    const text = payload.choices?.[0]?.message?.content ?? payload.result;
    if (typeof text !== 'string' || !text.trim()) throw new Error('The survey finished without a report.');
    return { runId, text };
  }
  throw new Error('The survey is still running. Reopen this page later to check again.');
}

function notice(message = '', error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function setBusy(busy) {
  state.busy = busy; $('start').disabled = busy; $('request').disabled = busy; $('progress').hidden = !busy;
  clearInterval(state.timer);
  if (busy) { const started = Date.now(); $('elapsed').textContent = '0:00'; state.timer = setInterval(() => { $('elapsed').textContent = formatElapsed(Date.now() - started); }, 1000); }
}
function showReport(entry) {
  state.current = entry;
  $('report').hidden = !entry; if (!entry) return;
  $('report-title').textContent = entry.title;
  $('report-meta').textContent = `${formatDate(entry.at)}${entry.runId ? ` · run ${entry.runId.slice(0, 8)}` : ''}`;
  $('report-body').innerHTML = renderMarkdown(entry.text);
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderHistory() {
  $('history-list').innerHTML = state.history.map((entry, index) => `<button class="history-row" data-entry="${index}"><strong>${escape(entry.title)}</strong><span>${escape(formatDate(entry.at))}</span></button>`).join('')
    || '<p class="empty">Reports you run will appear here.</p>';
  document.querySelectorAll('[data-entry]').forEach((button) => { button.onclick = () => { showReport(state.history[Number(button.dataset.entry)]); }; });
  $('history-clear').disabled = !state.history.length;
}
async function run(request) {
  if (state.busy) return;
  state.controller?.abort(); const controller = new AbortController(); state.controller = controller;
  setBusy(true); notice(); $('form-error').textContent = ''; $('progress-title').textContent = 'Starting…'; $('sync-status').textContent = 'Working…';
  try {
    const { runId, text } = await survey(request, controller.signal, (status) => {
      $('progress-title').textContent = status === 'queued' ? 'Waiting to start…' : 'Researching…';
    });
    const entry = { id: crypto.randomUUID(), title: titleOf(request), request, text, runId, at: Date.now() };
    state.history.unshift(entry); saveHistory(); renderHistory(); showReport(entry);
    $('sync-status').textContent = 'Report ready'; $('request').value = '';
  } catch (error) {
    if (controller.signal.aborted) return;
    $('form-error').textContent = error.message; $('sync-status').textContent = 'Ready';
  } finally { if (state.controller === controller) setBusy(false); }
}
$('survey-form').onsubmit = (event) => { event.preventDefault(); const request = $('request').value.trim(); if (request) run(request); };
$('request').onkeydown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('survey-form').requestSubmit(); };
document.querySelectorAll('[data-example]').forEach((chip) => { chip.onclick = () => { $('request').value = chip.dataset.example; $('request').focus(); }; });
$('history-toggle').onclick = () => { const open = $('history').hidden; $('history').hidden = !open; $('history-toggle').setAttribute('aria-expanded', String(open)); };
$('history-clear').onclick = () => { state.history = []; saveHistory(); renderHistory(); if (state.current) showReport(null); };
$('close-report').onclick = () => showReport(null);
$('copy').onclick = async () => { if (!state.current) return; try { await navigator.clipboard.writeText(state.current.text); notice('Copied the report as Markdown.'); setTimeout(() => notice(), 2500); } catch { notice('Copy is unavailable in this browser.', true); } };
state.history = loadHistory(); renderHistory();
if (['localhost', '127.0.0.1'].includes(location.hostname)) fetch('/preview-info').then((response) => response.json()).then((info) => { $('preview-badge').hidden = !info.demo; }).catch(() => {});
