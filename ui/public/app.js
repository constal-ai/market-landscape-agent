// Copyright 2026 Coresource AI, Inc. SPDX-License-Identifier: Apache-2.0
import { renderMarkdown } from './markdown.js';
const $ = (id) => document.getElementById(id);
const OWNER_KEY = 'mls-owner', OWN_KEY = 'mls-own', REPORT_KEY = (id) => `mls-report-${id}`;
const POLL_VISIBLE = 3000, POLL_HIDDEN = 20000, RUN_POLL = 2000, HEARTBEAT = 30000, RUN_DEADLINE = 40 * 60 * 1000;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const read = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const owner = (() => { let value = read(OWNER_KEY, null); if (typeof value !== 'string' || value.length < 16) { value = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''); write(OWNER_KEY, value); } return value; })();
const state = { feed: [], version: null, now: Date.now(), skew: 0, own: read(OWN_KEY, {}), current: null, busy: false, pollTimer: null, tickTimer: null };
const saveOwn = () => write(OWN_KEY, state.own);
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});
const formatElapsed = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const formatDate = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const serverNow = () => Date.now() + state.skew;
const titleOf = (request) => request.trim().split('\n')[0].slice(0, 96);
const reportUrl = (id) => `${location.origin}/r/${id}`;

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}
/** Retry idempotent bookkeeping in the background; the survey itself never waits on it. */
async function persist(path, init, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await api(path, init); }
    catch (error) { if (/not the survey owner|invalid|taken|not found/.test(error.message) || attempt === attempts - 1) throw error; await delay(500 * 2 ** attempt); }
  }
}

function notice(message = '', error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function setBusy(busy) { state.busy = busy; $('start').disabled = busy; $('request').disabled = busy; }

// Feed: everyone's surveys, running or finished. Rendered from the server's list, with local entries merged in
// optimistically until the server has seen them.
function mergedFeed() {
  const seen = new Set(state.feed.map((item) => item.id));
  const pending = Object.values(state.own).filter((item) => item.optimistic && !seen.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, status: item.status ?? 'running', createdAt: item.createdAt, updatedAt: item.createdAt, completedAt: null, hasReport: false }));
  return [...pending, ...state.feed].sort((a, b) => b.updatedAt - a.updatedAt);
}
function statusText(item) {
  if (item.status === 'running') return item.started || state.own[item.id] ? 'Researching' : 'Starting';
  return { complete: 'Ready', failed: 'Failed', stalled: 'Stalled' }[item.status] ?? item.status;
}
function renderFeed() {
  const items = mergedFeed(); const live = items.filter((item) => item.status === 'running');
  $('feed-count').textContent = live.length ? `${live.length} running` : '';
  $('feed-list').innerHTML = items.map((item) => `<button class="feed-row status-${item.status}" data-open="${item.id}" ${item.status === 'complete' || state.own[item.id]?.status === 'complete' ? '' : 'data-passive'}>
    <span class="feed-main"><strong>${escape(item.title)}</strong><span class="feed-meta">${state.own[item.id] ? '<em>You</em> · ' : ''}${escape(formatDate(item.createdAt))}</span></span>
    <span class="chip chip-${item.status}">${item.status === 'running' ? '<i class="pulse"></i>' : ''}${escape(statusText(item))}${item.status === 'running' ? ` <time data-since="${item.createdAt}">${formatElapsed(serverNow() - item.createdAt)}</time>` : ''}</span></button>`).join('')
    || '<p class="empty">No surveys yet. Yours will be the first.</p>';
  document.querySelectorAll('[data-open]').forEach((row) => { row.onclick = () => openReport(row.dataset.open, true); });
}
function tick() { document.querySelectorAll('time[data-since]').forEach((node) => { node.textContent = formatElapsed(serverNow() - Number(node.dataset.since)); }); if (state.running) $('elapsed').textContent = formatElapsed(Date.now() - state.running.startedAt); }
async function pollFeed() {
  clearTimeout(state.pollTimer);
  try {
    const payload = await api(`/api/feed?since=${encodeURIComponent(state.version ?? '')}`);
    state.skew = payload.now - Date.now();
    if (payload.changed) { state.version = payload.version; state.feed = payload.surveys; for (const item of state.feed) if (state.own[item.id]?.optimistic) { delete state.own[item.id].optimistic; saveOwn(); } renderFeed(); }
    $('sync-status').textContent = state.running ? 'Working…' : 'Live';
  } catch { $('sync-status').textContent = 'Reconnecting…'; }
  state.pollTimer = setTimeout(pollFeed, document.visibilityState === 'visible' ? POLL_VISIBLE : POLL_HIDDEN);
}

// Reports: render from the local cache instantly when we have it, then confirm with the server.
function showReport(entry, push = false) {
  state.current = entry; $('report').hidden = !entry;
  if (!entry) { if (push && location.pathname !== '/') history.pushState({}, '', '/'); return; }
  $('report-title').textContent = entry.title; $('report-meta').textContent = `${formatDate(entry.completedAt ?? entry.createdAt)}${entry.runId ? ` · run ${entry.runId.slice(0, 8)}` : ''}`;
  $('report-body').innerHTML = entry.report ? renderMarkdown(entry.report) : entry.status === 'failed' ? `<p class="empty">This survey failed${entry.error ? `: ${escape(entry.error)}` : '.'}</p>` : '<p class="empty">This survey is still running. The report appears here when it finishes.</p>';
  $('copy').disabled = !entry.report;
  if (push && location.pathname !== `/r/${entry.id}`) history.pushState({ id: entry.id }, '', `/r/${entry.id}`);
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function openReport(id, push = false) {
  const cached = read(REPORT_KEY(id), null);
  if (cached) showReport(cached, push);
  try {
    const { survey } = await api(`/api/surveys/${id}`);
    if (survey.report) write(REPORT_KEY(id), survey);
    if (!cached || cached.report !== survey.report || cached.status !== survey.status) showReport(survey, push);
  } catch (error) { if (!cached) { notice(error.message, true); showReport(null, push); } }
}

// Runs: one fresh Session per survey. The browser that started it polls the Run and reports back.
async function pollRun(id, session, runId, signal) {
  const deadline = Date.now() + RUN_DEADLINE;
  while (Date.now() < deadline) {
    const response = await fetch(`/_constal/runs/${encodeURIComponent(runId)}`, { headers: { 'x-session-id': session }, signal });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Your session expired. Reload and try again.');
    if (!response.ok) throw new Error(payload.error?.message ?? (typeof payload.error === 'string' ? payload.error : `Run read failed (${response.status})`));
    if (['failed', 'stopped'].includes(payload.status)) throw new Error(payload.error ?? `The survey ${payload.status} before completion.`);
    if (payload.status === 'complete') {
      const text = payload.result;
      if (typeof text !== 'string' || !text.trim()) throw new Error('The survey finished without a report.');
      return text;
    }
    await delay(RUN_POLL, signal);
  }
  throw new Error('The survey is still running. Reopen this page later to check again.');
}
async function drive(entry, startBody) {
  const controller = new AbortController(); state.running = { id: entry.id, startedAt: entry.createdAt, controller };
  $('progress').hidden = false; $('progress-title').textContent = entry.runId ? 'Researching…' : 'Starting…'; $('sync-status').textContent = 'Working…';
  const heartbeat = setInterval(() => { persist(`/api/surveys/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ owner }) }, 1).catch(() => {}); }, HEARTBEAT);
  try {
    if (!entry.runId) {
      const response = await fetch('/_constal/channel', { method: 'POST', signal: controller.signal, body: startBody,
        headers: { 'content-type': 'application/json', 'x-session-id': entry.session, 'idempotency-key': entry.id, prefer: 'respond-async' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message ?? (typeof payload.error === 'string' ? payload.error : `The survey could not be started (${response.status}).`));
      entry.runId = payload.runId ?? response.headers.get('x-session-run-id') ?? null;
      if (!entry.runId && payload.status === 'complete') entry.report = payload.choices?.[0]?.message?.content ?? null;
      if (!entry.runId && !entry.report) throw new Error('The platform accepted the request without a Run id. Try again.');
      saveOwn();
      if (entry.runId) persist(`/api/surveys/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ owner, runId: entry.runId }) }).catch(() => {});
    }
    $('progress-title').textContent = 'Researching…';
    const report = entry.report ?? await pollRun(entry.id, entry.session, entry.runId, controller.signal);
    const finished = { ...entry, status: 'complete', report, completedAt: Date.now() };
    write(REPORT_KEY(entry.id), finished); state.own[entry.id] = { ...entry, status: 'complete' }; saveOwn();
    showReport(finished, true); renderFeed(); notice('Report ready. Share the link to let anyone read it.');
    await persist(`/api/surveys/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ owner, status: 'complete', report }) });
  } catch (error) {
    if (controller.signal.aborted) return;
    state.own[entry.id] = { ...entry, status: 'failed' }; saveOwn(); renderFeed();
    $('form-error').textContent = error.message;
    persist(`/api/surveys/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ owner, status: 'failed', error: error.message.slice(0, 1000) }) }).catch(() => {});
  } finally {
    clearInterval(heartbeat); if (state.running?.id === entry.id) { state.running = null; $('progress').hidden = true; setBusy(false); $('sync-status').textContent = 'Live'; }
    pollFeed();
  }
}
async function startSurvey(request) {
  if (state.busy) return;
  setBusy(true); notice(); $('form-error').textContent = ''; showReport(null, true);
  const id = crypto.randomUUID();
  const entry = { id, title: titleOf(request), request, session: `ui-request-${id}`, runId: null, status: 'running', createdAt: Date.now(), optimistic: true };
  state.own[id] = entry; saveOwn(); renderFeed(); $('request').value = '';
  persist('/api/surveys', { method: 'POST', body: JSON.stringify({ id, owner, request }) }).then(() => { delete state.own[id]?.optimistic; saveOwn(); pollFeed(); }).catch(() => {});
  await drive(entry, JSON.stringify({ messages: [{ role: 'user', content: request }], stream: false }));
}
function resumeOwn() {
  for (const entry of Object.values(state.own)) {
    if (entry.status !== 'running') continue;
    if (!entry.runId || !entry.session || Date.now() - entry.createdAt > RUN_DEADLINE) { entry.status = 'failed'; saveOwn(); continue; }
    setBusy(true); drive(entry); return; // one active survey per browser
  }
}

$('survey-form').onsubmit = (event) => { event.preventDefault(); const request = $('request').value.trim(); if (request) startSurvey(request); };
$('request').onkeydown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('survey-form').requestSubmit(); };
document.querySelectorAll('[data-example]').forEach((chip) => { chip.onclick = () => { $('request').value = chip.dataset.example; $('request').focus(); }; });
$('close-report').onclick = () => showReport(null, true);
$('copy').onclick = async () => { if (!state.current?.report) return; try { await navigator.clipboard.writeText(state.current.report); notice('Copied the report as Markdown.'); setTimeout(() => notice(), 2500); } catch { notice('Copy is unavailable in this browser.', true); } };
$('share').onclick = async () => {
  if (!state.current) return; const url = reportUrl(state.current.id);
  try { if (navigator.share) await navigator.share({ title: state.current.title, url }); else { await navigator.clipboard.writeText(url); notice('Link copied. Anyone can open it.'); setTimeout(() => notice(), 2500); } }
  catch (error) { if (error?.name !== 'AbortError') notice(url); }
};
window.onpopstate = () => { const id = location.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1]; if (id) openReport(id); else showReport(null); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollFeed(); });
if (['localhost', '127.0.0.1'].includes(location.hostname)) fetch('/preview-info').then((response) => response.json()).then((info) => { $('preview-badge').hidden = !info.demo; }).catch(() => {});
renderFeed(); pollFeed(); state.tickTimer = setInterval(tick, 1000);
const shared = location.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1]; if (shared) openReport(shared);
resumeOwn();
