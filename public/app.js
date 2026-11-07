import { classifyImportFile, extractImportDocument, extractDocument } from './vendor/file-import.bundle.js';
import { createPlainEnglish, bindPlainToggle } from './plain-ui.js';
import { createDocx, createPdf, documentFilename, downloadBytes } from './vendor/document-export.bundle.js';
import { createInterviewCache } from './interview-cache.js';
import { postingDetails } from './posting-details.js';
import { chooseNextStep } from './next-step.js';
import { pickDefaultWorkspace } from './default-workspace.js';
import { PREP_PACK_ORDER, prepPackText, interviewCountdown } from './prep-pack.js';
import { HUNT_STATUSES, CLOSED_HUNT_STATUSES, huntSummary, nextStepOverdue, jobHuntCsv } from './job-hunt.js';
import { createPendingJobRecovery } from './job-recovery.js';
import { waitForModelJob } from './model-job-poll.js';
import { createSampleGuest } from './sample-workspace.js';
import { readStoredObject, readGuestState, originalExtension, dateTimeInputValue } from './browser-state.js';

const $ = (id) => document.getElementById(id);
const sections = ['landing', 'start', 'auth', 'paste', 'ledger', 'practice', 'library', 'workspaces', 'writer', 'prep-pack', 'immerser', 'interview', 'voice-interview', 'story-dig', 'drills', 'real-capture', 'debrief'];
const guestKey = 'interview-coach-guest';
const guestDraftKey = 'interview-coach-guest-draft';
const guestAnswerKey = 'interview-coach-guest-answer';
const guestCacheSessionKey = 'interview-coach-cache-guest-id';
function clearInterviewCoachLocalStorage() {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('interview-coach-')) localStorage.removeItem(key);
    }
  } catch { /* Storage may be unavailable. */ }
}
let guest = false;
let state = {};
let workspaceId = sessionStorage.getItem('interview-coach-workspace');
let interviewId = sessionStorage.getItem('interview-coach-interview');
let pendingJob = readStoredObject(sessionStorage, 'interview-coach-job');
let pendingJobRecovery;
let currentUser = null;
let sessionEpoch = 0;
let voiceAvailable = false;
let guestVoiceLimits = null;
let currentWorkspace = null;
const selectedConflictFacts = new Set();
let selectedConflictWorkspaceId = workspaceId;
let currentPrepSections = [];
let guestVoice = null;
let voiceClient = null;
let voiceTimer = null;
let voiceCandidateTurns = [];
let digId = null;
let immersion = null;
let navigationVersion = 0;
const mapBuilding = new Set();
const mapFailed = new Set();
let progressTimer;
let hubWorkspaces = [];

function interviewCache() {
  try {
    let namespace;
    if (guest) {
      let id = sessionStorage.getItem(guestCacheSessionKey);
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(guestCacheSessionKey, id); }
      namespace = `guest:${id}`;
    } else if (currentUser) {
      const userKey = currentUser.id ?? currentUser.username;
      if (!userKey) return null;
      namespace = `account:${userKey}`;
    } else return null;
    return createInterviewCache(sessionStorage, namespace);
  } catch { return null; }
}

// Presentation state never enters the guest profile or an API payload.
const themeToggle = $('theme-toggle');
let theme = 'auto';
try {
  const savedTheme = localStorage.getItem('interview-coach-theme');
  if (['auto', 'light', 'dark'].includes(savedTheme)) theme = savedTheme;
} catch { /* Theme switching also works when persistent storage is unavailable. */ }
function applyTheme() {
  // One light theme . Clear any old saved dark choice.
  document.documentElement.dataset.theme = 'light';
  try { localStorage.removeItem('interview-coach-theme'); } catch { /* Nothing saved. */ }
  themeToggle.textContent = `Theme: ${theme}`;
}
themeToggle.addEventListener('click', () => {
  theme = { auto: 'light', light: 'dark', dark: 'auto' }[theme];
  try { localStorage.setItem('interview-coach-theme', theme); } catch { /* Keep this tab's preference. */ }
  applyTheme();
});
applyTheme();

// Sunrise Glass presentation layer. These enhancements are deliberately separate from
// product state: every control continues to work if a browser skips the effects.
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let bankCountFrame;
let countUpFrame;
let countUpTarget = null;
function observeGlassReveals(root = document) {
  const items = root.querySelectorAll?.([
    '.loop-strip article', '.hub-tile', '.quote-group', '.persona-card',
    '#auth form', '#paste form', '#library > form', '#library > .panel',
    '.doc-section', '.doc-line', '.week-route', '.scene-stage', '.consequence',
    '#immerser-action', '.turn', '#between-answer-coaching > *', '.practice-card',
    '#real-feed > *', '#report > *', '#story-dig form', '#voice-interview .actions'
  ].join(', ')) ?? [];
  for (const item of items) {
    if (item.dataset.glassObserved) continue;
    item.dataset.glassObserved = 'true';
    item.classList.add('reveal-on-scroll');
    // Anything already on screen (or scrolled past) shows right away; only content
    // below the fold waits to rise in. A blank gap reads as missing data.
    const top = item.getBoundingClientRect().top;
    if (!window.glassRevealObserver || prefersReducedMotion() || top < window.innerHeight) item.classList.add('is-revealed');
    else window.glassRevealObserver.observe(item);
  }
  // Safety net: nothing stays hidden, even if the observer never fires (fast scroll, capture tools).
  clearTimeout(observeGlassReveals.timer);
  observeGlassReveals.timer = setTimeout(() => {
    for (const item of document.querySelectorAll('.reveal-on-scroll:not(.is-revealed)')) item.classList.add('is-revealed');
  }, 1200);
}
function activatePrimaryMagnet(root = document) {
  for (const button of root.querySelectorAll?.('button:not(.secondary):not(.hub-tile)') ?? []) {
    button.classList.add('magnetic-action');
  }
}
if ('IntersectionObserver' in window && !prefersReducedMotion()) {
  window.glassRevealObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
}
document.addEventListener('pointermove', (event) => {
  if (prefersReducedMotion() || event.pointerType !== 'mouse') return;
  document.documentElement.style.setProperty('--spotlight-x', `${event.clientX}px`);
  document.documentElement.style.setProperty('--spotlight-y', `${event.clientY}px`);
  const button = event.target.closest('.magnetic-action');
  if (!button || button.disabled) return;
  const box = button.getBoundingClientRect();
  const x = (event.clientX - box.left - box.width / 2) * 0.12;
  const y = (event.clientY - box.top - box.height / 2) * 0.16;
  button.style.setProperty('--magnet-x', `${x}px`);
  button.style.setProperty('--magnet-y', `${y}px`);
});
document.addEventListener('pointerout', (event) => {
  const button = event.target.closest?.('.magnetic-action');
  if (button && !button.contains(event.relatedTarget)) {
    button.style.removeProperty('--magnet-x');
    button.style.removeProperty('--magnet-y');
  }
});
document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest?.('button');
  if (!button || button.disabled || prefersReducedMotion()) return;
  const box = button.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'tap-ripple';
  ripple.style.left = `${event.clientX - box.left}px`;
  ripple.style.top = `${event.clientY - box.top}px`;
  button.append(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});
function setBankProgress(confirmed, total) {
  const summary = $('bank-summary');
  const prior = Number(summary.dataset.confirmed);
  const safeTotal = Math.max(total, 1);
  summary.style.setProperty('--bank-progress', `${Math.round((confirmed / safeTotal) * 100)}%`);
  summary.dataset.confirmed = String(confirmed);
  summary.dataset.total = String(total);
  cancelAnimationFrame(bankCountFrame);
  const write = (value) => { summary.textContent = `${value} confirmed / ${total} career details`; };
  if (prefersReducedMotion() || !Number.isFinite(prior) || prior === confirmed || document.hidden) {
    write(confirmed);
    return;
  }
  const start = performance.now();
  const duration = 440;
  const tick = (now) => {
    if (document.hidden) { write(confirmed); return; }
    const progress = Math.min((now - start) / duration, 1);
    write(Math.round(prior + (confirmed - prior) * (1 - Math.pow(1 - progress, 3))));
    if (progress < 1) bankCountFrame = requestAnimationFrame(tick);
  };
  bankCountFrame = requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  cancelAnimationFrame(bankCountFrame);
  bankCountFrame = undefined;
  cancelAnimationFrame(countUpFrame);
  countUpFrame = undefined;
  if (countUpTarget) {
    countUpTarget.element.textContent = `${countUpTarget.value}${countUpTarget.suffix}`;
    countUpTarget = null;
  }
});
activatePrimaryMagnet();
observeGlassReveals();


// Plain-language labels. Never show raw status values, offsets, or ids to the user.
function friendlySource(fact) {
  const title = String(fact.source_title || '');
  if (/correction/i.test(title)) return 'Your correction';
  if (/practice|rep|transcript|interview/i.test(title)) return 'Something you said in practice';
  if (/dig/i.test(title)) return 'Your story dig';
  if (/linkedin/i.test(title)) return 'Your LinkedIn';
  if (/resume|résumé|cv/i.test(title)) return 'Your résumé';
  if (/job|jd|posting/i.test(title) || fact.domain === 'job') return 'The job posting';
  return title ? title : 'Your notes';
}
function friendlyStatus(fact) {
  const origin = { document: 'From your documents', user_confirmed: 'You confirmed this', draft: 'You mentioned this' }[fact.status] || 'Career detail';
  const review = { pending: 'Needs your OK', accepted: 'Confirmed', rejected: 'Set aside' }[fact.review_state] || '';
  const life = fact.lifecycle === 'superseded' ? 'Replaced by a newer version' : '';
  return [fact.domain === 'job' ? 'From the job posting' : origin, review, life].filter(Boolean).join(' · ');
}

function celebrate(text, card) {
  clearTimeout(progressTimer);
  $('progress-note').textContent = text;
  $('progress-note').hidden = false;
  card?.classList.add('proof-found');
  progressTimer = setTimeout(() => { $('progress-note').hidden = true; }, 3200);
}

const demoSteps = [
  { label: 'Fictional story / source note', title: 'A shift worth talking about.',
    text: '“I reassigned two team members to cover the front desk during a busy check-in.”',
    note: 'A specific action. A clear personal contribution.', action: 'Try the practice question →' },
  { label: 'Fictional mock / hiring manager', title: 'Put me in that moment.',
    text: '“How did you decide who to move, and what changed for the guests?”',
    note: 'Follow-ups look for decisions and evidence, not a perfect script.', action: 'See what needs detail →' },
  { label: 'Fictional debrief / next rep', title: 'Keep the action. Find the result.',
    text: 'The decision is specific. The outcome still needs evidence. What did you observe after the change?',
    note: 'No wait-time reduction gets invented. The next rep starts with a real detail.', action: 'Practice recalling it →' },
  { label: 'Fictional practice card', title: 'Recall the real detail.',
    text: 'What changed for the guests after the team member moved to the front desk?',
    note: 'A practice card brings details back for review. The app shows the next review date.', action: 'Start again at Learn ↻' },
];
function renderDemo(index) {
  const step = demoSteps[index];
  const card = $('demo-card');
  card.replaceChildren(node('span', step.label, 'chip'), node('h2', step.title),
    node('p', step.text), node('p', step.note, 'meta'));
  const next = node('button', step.action);
  next.addEventListener('click', () => {
    renderDemo((index + 1) % demoSteps.length);
    $('demo-card').querySelector('button').focus({ preventScroll: true });
  });
  card.append(next);
  document.querySelectorAll('[data-demo]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.demo) === index));
  });
}
document.querySelectorAll('[data-demo]').forEach((button) => {
  button.addEventListener('click', () => renderDemo(Number(button.dataset.demo)));
});
renderDemo(0);

const parentPanels = {
  interview: 'practice', 'voice-interview': 'practice', debrief: 'practice',
  library: 'ledger', 'story-dig': 'ledger', paste: 'workspaces',
};
const routePanels = {
  start: 'start', story: 'landing', jobs: 'workspaces', facts: 'ledger', prep: 'prep-pack',
  writing: 'writer', practice: 'practice', immerser: 'immerser', review: 'real-capture', drills: 'drills',
};
const initialPublicPanel = ({ '#/start': 'start', '#/story': 'landing' })[location.hash] ?? null;
const panelRoutes = Object.fromEntries(Object.entries(routePanels).map(([route, panel]) => [panel, route]));
function hasSession() { return Boolean(guest || currentUser); }
function updateRail() {
  const active = parentPanels[document.body.dataset.activePanel] ?? document.body.dataset.activePanel;
  for (const link of document.querySelectorAll('#app-rail [data-route]')) {
    link.toggleAttribute('aria-current', link.dataset.route === panelRoutes[active]);
    if (!link.hasAttribute('data-private-route')) continue;
    const startFirst = !hasSession();
    link.toggleAttribute('data-start-first', startFirst);
    link.setAttribute('aria-label', `${link.querySelector('span').textContent}${startFirst ? ', Start first' : ''}`);
  }
}
function closeRail({ restoreFocus = false } = {}) {
  const rail = $('app-rail');
  rail.classList.remove('is-open');
  rail.setAttribute('aria-hidden', String(window.innerWidth < 900));
  $('rail-toggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('rail-toggle').focus();
}
function show(name) {
  if (voiceClient && name !== 'voice-interview' && !confirm('End the live voice call before leaving this screen?')) return false;
  if (voiceClient && name !== 'voice-interview') stopVoice();
  navigationVersion += 1;
  clearTimeout(progressTimer);
  $('progress-note').hidden = true;
  $('message').hidden = true; // a notice belongs to the screen it was about
  for (const section of sections) $(section).hidden = section !== name;
  const heading = $(name).querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
  window.scrollTo(0, 0);
  document.body.dataset.activePanel = name;
  const route = panelRoutes[parentPanels[name] ?? name];
  if (route) history.replaceState(null, '', `#/${route}`);
  updateRail();
  observeGlassReveals($(name));
  activatePrimaryMagnet($(name));
  return true;
}

function go(target) {
  const panel = routePanels[target] ?? target;
  if (!hasSession() && !['landing', 'start', 'auth'].includes(panel)) return show('start');
  if (panel === 'workspaces') return openWorkspaceHub().catch((error) => message(error.message));
  if (panel === 'ledger') return api('ledger', { workspaceId }).then(renderLedger).catch((error) => message(error.message));
  if (panel === 'prep-pack') return openPrepPack().catch((error) => message(error.message));
  if (panel === 'writer') { show('writer'); return restoreWriterDraft(); }
  if (panel === 'practice') return openPractice();
  if (panel === 'drills') return openDrills();
  if (panel === 'immerser' || panel === 'real-capture') return $(panel === 'immerser' ? 'open-immerser' : 'open-real-capture')?.click();
  return show(panel);
}
function routeFromHash() {
  const match = location.hash.match(/^#\/([a-z-]+)$/);
  if (!match) return;
  const panel = routePanels[match[1]];
  if (!panel) return;
  go(match[1]);
}
for (const link of document.querySelectorAll('#app-rail [data-route]')) {
  link.addEventListener('click', (event) => { event.preventDefault(); closeRail(); go(link.dataset.route); });
}
$('rail-toggle').addEventListener('click', () => {
  const rail = $('app-rail'); const open = !rail.classList.contains('is-open');
  rail.classList.toggle('is-open', open); rail.setAttribute('aria-hidden', String(!open));
  $('rail-toggle').setAttribute('aria-expanded', String(open));
  if (open) rail.querySelector('a')?.focus();
});
document.addEventListener('keydown', (event) => {
  const rail = $('app-rail');
  if (!rail.classList.contains('is-open')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeRail({ restoreFocus: true }); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...rail.querySelectorAll('a[href], button:not([disabled])')];
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
window.addEventListener('hashchange', routeFromHash);
if (window.innerWidth < 900) $('app-rail').setAttribute('aria-hidden', 'true');
window.addEventListener('resize', () => {
  if (window.innerWidth >= 900) $('app-rail').setAttribute('aria-hidden', 'false');
  else if (!$('app-rail').classList.contains('is-open')) $('app-rail').setAttribute('aria-hidden', 'true');
});

$('message').addEventListener('click', () => { $('message').hidden = true; });
function plainError(text) {
  const raw = String(text ?? '');
  const rules = [
    [/spend_cap_reached|daily model spend cap/i, 'Interview Coach has used up its AI allowance for today. Your work is saved. Please try again tomorrow.'],
    [/accounting_unavailable|spend accounting/i, 'The AI helper is paused for a few minutes. Your work is saved. Please try again soon.'],
    [/model_unavailable|model provider unavailable|model job failed/i, 'The AI helper didn\'t answer this time. Your work is safe. Tap Try again, or wait a minute and retry.'],
    [/invalid_credentials/i, 'That username or password isn\'t right. Check the spelling, or tap Create account if you\'re new here.'],
    [/username is unavailable/i, 'That username is already taken. Try a different one.'],
    [/password must be/i, 'Your password needs at least 12 characters. A few random words together works well.'],
    [/authentication_required/i, 'Please sign in again to continue.'],
    [/choose_account_or_guest/i, 'Sign in, or choose Try it as a guest, to continue.'],
    [/rate_limited/i, 'That was a lot of taps in a row. Wait a minute and try again.'],
    [/same_origin_required|method_not_allowed|abuse_limits_unavailable/i, 'Something went wrong on our side. Refresh the page and try again.'],
    [/request_too_large/i, 'That\'s too much text or too big a file at once. Try a smaller piece.'],
    [/^Request failed$/i, 'That didn\'t work. Please try again.'],
  ];
  for (const [pattern, friendly] of rules) if (pattern.test(raw)) return friendly;
  return raw;
}

function message(text) {
  text = plainError(text);
  $('message').textContent = text;
  $('message').hidden = !text;
  if (text) {
    $('message').focus({ preventScroll: true });
    $('message').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// On a phone, whatever a tap opens or produces should come into view without hunting for it.
function reveal(element, block = 'start') {
  if (!element) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block, behavior: reduce ? 'auto' : 'smooth' });
}

function forgetWorkspace() {
  if (interviewId) interviewCache()?.clear(interviewId);
  workspaceId = null; interviewId = null;
  sessionStorage.removeItem('interview-coach-workspace');
  sessionStorage.removeItem('interview-coach-interview');
}

// Guest state travels with every request, so guest calls take turns: a background call
// finishing late must never overwrite a confirmation made in the meantime.
let guestChain = Promise.resolve();
async function api(op, data = {}) {
  const epoch = sessionEpoch;
  if (!guest) return send(op, data);
  // The job match only writes that job's requirement list, so it runs alongside
  // everything else and merges just that list back. Queuing it made every tap on
  // the hub wait ~30 seconds behind it.
  if (op === 'workspace_map') return send(op, data, { mergeRequirementsFor: data.workspaceId });
  const prior = guestChain;
  let release;
  guestChain = new Promise((resolve) => { release = resolve; });
  try {
    await prior;
    if (epoch !== sessionEpoch) throw new Error('The session changed. Open your current workspace and try again.');
    return await send(op, data);
  } finally { release(); }
}

async function send(op, data, { mergeRequirementsFor = null } = {}) {
  const epoch = sessionEpoch;
  let response;
  try {
    response = await fetch(`/api?op=${encodeURIComponent(op)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-coach-csrf': '1' },
      body: JSON.stringify({ ...data, ...(guest ? { guest: true, state } : {}) }),
    });
  } catch {
    throw new Error('Couldn\'t reach Interview Coach. Check your connection and try again. Your work is still here.');
  }
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error(response.ok ? 'Something came back garbled. Try that again.' : 'The server hiccuped. Try that again in a moment.');
    error.status = response.status;
    throw error;
  }
  if (epoch !== sessionEpoch) throw new Error('The session changed. Open your current workspace and try again.');
  if (!response.ok) {
    // A saved job from another session (guest vs. account) isn't this person's. Drop it and recover.
    if (response.status === 404 && /workspace not found/i.test(body.message || body.error || '') && op !== 'workspaces') {
      forgetWorkspace();
      setTimeout(() => renderWorkspaces().catch(() => show('paste')), 0);
      throw new Error('That job isn\'t in this session anymore. Pick one of your jobs, or add a new one.');
    }
    const error = new Error(body.message || body.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  if (guest && body.state && mergeRequirementsFor) {
    const theirs = (body.state.requirements ?? []).filter((item) => item.workspace_id === mergeRequirementsFor);
    state = { ...state, requirements: [...(state.requirements ?? []).filter((item) => item.workspace_id !== mergeRequirementsFor), ...theirs] };
    sessionStorage.setItem(guestKey, JSON.stringify(state));
  } else if (guest && body.state) {
    state = body.state;
    sessionStorage.setItem(guestKey, JSON.stringify(state));
  }
  return Object.hasOwn(body, 'result') ? body.result : body;
}

async function waitForJob(job) {
  pendingJob = job;
  message('Working on the model result. You can leave this tab and return.');
  return waitForModelJob(job, {
    api,
    saveJob: (saved) => {
      pendingJob = saved;
      sessionStorage.setItem('interview-coach-job', JSON.stringify(saved));
    },
    clearJob: () => {
      pendingJob = null;
      sessionStorage.removeItem('interview-coach-job');
      message('');
    },
    recovery: pendingJobRecovery,
    startWorker: async (jobId) => {
      const trigger = await fetch('/.netlify/functions/model-job-background', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-coach-csrf': '1' },
        body: JSON.stringify({ jobId }),
      });
      if (!trigger.ok && trigger.status !== 202) throw new Error('Could not start the background job. Refresh to retry.');
    },
  });
}

async function resumeJob() {
  if (!pendingJob || guest || !currentUser) return false;
  const job = pendingJob;
  const result = await waitForJob(job);
  if (job.kind === 'paste') {
    workspaceId = result.workspace.id;
    sessionStorage.setItem('interview-coach-workspace', workspaceId);
    renderLedger(result.facts);
    message('Extraction finished. If you selected files before refreshing, attach the originals beside their source quotes.');
  } else if (job.kind === 'rep_extract') renderLedger(result.facts);
  else if (job.kind === 'debrief') renderDebrief(result);
  else if (job.kind === 'ingest') {
    if (result.workspace) workspaceId = result.workspace.id;
    sessionStorage.setItem('interview-coach-workspace', workspaceId);
    renderLedger(await api('ledger', { workspaceId }));
    message('Extraction finished. If you uploaded a file, reattach it in the library to preserve the original.');
  } else if (job.kind === 'workspace_map') await renderWorkspaces();
  else if (job.kind === 'immerse_week') renderImmersion(result);
  return true;
}

async function resolveJob(result) {
  return result.job ? waitForJob(result.job) : result;
}

async function run(button, task, loadingText = null) {
  message('');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  if (button.type === 'submit' && button.form?.id === 'answer-form') button.textContent = 'Sending answer…';
  // Model calls can take 10 to 30 seconds. Say so instead of looking frozen.
  if (loadingText) {
    $('progress-note').textContent = loadingText;
    $('progress-note').hidden = false;
  }
  const slow = setTimeout(() => {
    $('progress-note').textContent = loadingText || 'Working on it. This can take up to 30 seconds.';
    $('progress-note').hidden = false;
  }, loadingText ? 0 : 2500);
  try { await task(); } catch (error) {
    message(button.id === 'start-voice' ?
      `${error.message} Your typed interview is available on this page.` : error.message);
  }
  finally {
    clearTimeout(slow);
    if ($('progress-note').textContent.startsWith('Working on it') || $('progress-note').textContent === loadingText) $('progress-note').hidden = true;
    button.disabled = false;
    if (button.id !== 'retry-pending-job') button.textContent = originalLabel;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  }
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function truncateLabel(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

function reviewDate(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'today';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(Number(timestamp)));
}

// Plain English. Its own request: no guest state goes out, none comes back, and it never
// waits behind a guest's other calls.
async function fetchPlain(text, kind) {
  const response = await fetch('/api?op=plain', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-coach-csrf': '1' },
    body: JSON.stringify({ text, kind, workspaceId, ...(guest ? { guest: true } : {}) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.result) throw new Error('plain_unavailable');
  return body.result;
}
const plain = createPlainEnglish({ fetchPlain });
bindPlainToggle($('plain-toggle'), plain);
$('plain-voice').checked = plain.isOn();
plain.onChange((on) => { $('plain-voice').checked = on; });
$('plain-voice').addEventListener('change', () => plain.setOn($('plain-voice').checked));

let proofIdentity = null;
function clearProofShelf() {
  $('proof-shelf').hidden = true;
  $('proof-shelf-list').replaceChildren();
  $('public-workspace-note').hidden = true;
}

function identity() {
  const nextIdentity = currentUser?.id ?? (guest ? 'guest' : null);
  if (nextIdentity !== proofIdentity) {
    sessionEpoch += 1;
    cancelSessionMedia();
    clearProofShelf();
    $('fact-list').replaceChildren();
    $('bank-summary').textContent = '';
    delete $('bank-summary').dataset.confirmed;
    delete $('bank-summary').dataset.total;
    cancelAnimationFrame(bankCountFrame);
    $('requirement-list').replaceChildren();
    proofIdentity = nextIdentity;
  }
  $('header-auth').hidden = Boolean(currentUser);
  $('identity').textContent = guest ? (state.workspaces?.some((item) => item.public_summary) ? 'Practice workspace' : 'Guest session') : currentUser?.username ?? '';
  $('end-session').hidden = !guest && !currentUser;
  $('delete-account').hidden = !currentUser;
  updateRail();
  $('resume').maxLength = guest ? 8000 : 12000;
  $('jd').maxLength = guest ? 8000 : 12000;
  $('answer').maxLength = guest ? 1000 : 4000;
  $('start-voice').hidden = !voiceAvailable || (!currentUser && !guest);
  $('plain-voice-setting').hidden = $('start-voice').hidden;
  $('voice-setup-note').hidden = !voiceAvailable || !currentUser;
  $('voice-guest-note').hidden = !guest || !voiceAvailable;
  const limits = guestVoiceLimits;
  const landingNote = $('guest-voice-limits');
  if (limits?.maxMinutes && limits?.callsPerDay) {
    landingNote.textContent = `Guests can make ${limits.callsPerDay} voice call${limits.callsPerDay === 1 ? '' : 's'} a day, up to ${limits.maxMinutes} minute${limits.maxMinutes === 1 ? '' : 's'} each. Typing has no limit.`;
    landingNote.hidden = false;
    $('voice-guest-note').textContent = `Voice calls for guests run up to ${limits.maxMinutes} minutes, ${limits.callsPerDay} time${limits.callsPerDay === 1 ? '' : 's'} a day. Your transcript comes back to this browser and we don't save it. Retell, the voice company, keeps a copy for a day.`;
  }
}

function applySessionDetails(body) {
  voiceAvailable = body.voiceAvailable;
  guestVoiceLimits = body.guestVoiceLimits ?? null;
  identity();
}

function restoreGuestDrafts() {
  const draft = readStoredObject(sessionStorage, guestDraftKey, {});
  $('job-label').value = draft.jobLabel ?? '';
  $('resume').value = draft.resume ?? '';
  $('jd').value = draft.jd ?? '';
  $('answer').value = sessionStorage.getItem(guestAnswerKey) ?? '';
}

for (const field of ['job-label', 'resume', 'jd']) {
  $(field).addEventListener('input', () => {
    if (!guest) return;
    sessionStorage.setItem(guestDraftKey, JSON.stringify({ jobLabel: $('job-label').value,
      resume: $('resume').value, jd: $('jd').value }));
  });
}
$('answer').addEventListener('input', () => {
  if (guest) sessionStorage.setItem(guestAnswerKey, $('answer').value);
});

// Résumé bullets arrive with their marker ("- ", "• "); the quote reads better without it.
function cleanLine(text) {
  return String(text).trim().replace(/^[-–•*·]\s+/, '');
}

function renderLedger(facts, { keepScroll = false } = {}) {
  const scrollY = window.scrollY;
  if (selectedConflictWorkspaceId !== workspaceId) selectedConflictFacts.clear();
  selectedConflictWorkspaceId = workspaceId;
  const validConflictIds = new Set(facts.filter((fact) => fact.domain !== 'job' && fact.lifecycle === 'active' &&
    fact.review_state !== 'rejected').map((fact) => fact.id));
  for (const factId of selectedConflictFacts) if (!validConflictIds.has(factId)) selectedConflictFacts.delete(factId);
  // Her own stories first; lines quoted from the job posting go last.
  facts = [...facts].sort((a, b) => (a.domain === 'job') - (b.domain === 'job'));
  const list = $('fact-list');
  list.replaceChildren();
  const posting = node('details', '', 'posting-details');
  posting.append(node('summary', "What they're asking for (nothing to confirm)"));
  const groups = new Map();
  const active = facts.filter((fact) => fact.lifecycle === 'active' &&
    fact.review_state !== 'rejected' && fact.domain !== 'job');
  const confirmed = active.filter((fact) => fact.review_state === 'accepted').length;
  setBankProgress(confirmed, active.length);
  for (const fact of facts) {
    const key = fact.source_id && fact.line_quote ?
      `${fact.source_id}:${fact.line_start}:${fact.line_end}` : fact.id;
    let group = groups.get(key);
    if (!group) {
      group = node('section', '', 'quote-group');
      group.storyFacts = [];
      group.append(node('span', fact.domain === 'job' ? 'From the job posting' :
        'Your career detail', 'chip'));
      group.append(node('h2', fact.line_quote ? `“${cleanLine(fact.line_quote)}”` : fact.display_text));
      group.append(node('p', fact.source_title ? `${friendlySource(fact)}${fact.page_number ? `, page ${fact.page_number}` : ''}${fact.section_label ? `, ${fact.section_label}` : ''}` : 'Your assertion', 'meta'));
      groups.set(key, group);
      if (fact.domain === 'job') posting.append(group);
      else list.append(group);
      if (!guest && fact.source_id) {
        const sourceFiles = node('details', '');
        sourceFiles.append(node('summary', 'Original source file'));
        group.append(sourceFiles);
        const attach = node('input', '');
        attach.type = 'file';
        attach.accept = '.pdf,.docx';
        attach.setAttribute('aria-label', `Attach original PDF or DOCX for ${fact.source_title}`);
        attach.addEventListener('change', () => run(attach, async () => {
          const file = attach.files[0];
          const parsed = await fileText(file);
          await uploadOriginal(file, fact.source_id, parsed.mimeType, parsed.text);
          message('Original file stored privately with this source.');
        }));
        sourceFiles.append(attach);
        const download = node('button', 'Download original', 'secondary');
        download.addEventListener('click', () => run(download, async () => {
          const uploads = await api('source_uploads', { sourceId: fact.source_id });
          if (!uploads.length) throw new Error('No original file is stored for this source.');
          const upload = uploads[0];
          const chunks = [];
          for (let part = 0; part < upload.chunkCount; part += 1) {
            const result = await api('download_chunk', { uploadId: upload.id, part });
            chunks.push(Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0)));
          }
          const url = URL.createObjectURL(new Blob(chunks, { type: upload.mimeType }));
          const link = document.createElement('a');
          link.href = url;
          link.download = `${fact.source_title}.${originalExtension(upload.mimeType)}`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        }));
        sourceFiles.append(download);
      }
    }
    group.storyFacts.push(fact);
    const card = node('article', '', 'fact');
    card.dataset.factId = fact.id;
    const detailText = fact.verbatim_quote || fact.display_text || 'Career detail';
    // When the detail is the whole line, the headline already shows it.
    if (!fact.line_quote || cleanLine(detailText) !== cleanLine(fact.line_quote)) card.append(node('h3', cleanLine(detailText)));
    card.append(node('p', friendlyStatus(fact), 'meta'));
    if (fact.discrepancy_note) card.append(node('p', `Correction note: ${fact.discrepancy_note}`));
    if (fact.supersedes_fact_id) card.append(node('p', 'Replaces an earlier version', 'meta'));
    if (fact.domain !== 'job' && fact.lifecycle === 'active' && fact.review_state !== 'rejected') {
      const choose = node('input', '');
      choose.type = 'checkbox';
      choose.checked = selectedConflictFacts.has(fact.id);
      choose.setAttribute('aria-label', `Select ${cleanLine(detailText)} to compare with another detail`);
      choose.addEventListener('change', () => {
        if (choose.checked) selectedConflictFacts.add(fact.id); else selectedConflictFacts.delete(fact.id);
        if (selectedConflictFacts.size > 2) {
          selectedConflictFacts.delete([...selectedConflictFacts][0]);
          renderLedger(facts, { keepScroll: true });
        }
        updateConflictSelection();
      });
      const chooseLabel = node('label', ' Compare with another detail');
      chooseLabel.prepend(choose);
      card.append(chooseLabel);
    }
    const deleteActions = node('div', '', 'actions');
    const deleteFact = node('button', 'Delete this', 'secondary');
    deleteFact.addEventListener('click', () => {
      if (confirm('Delete this fact and its correction history?')) {
        run(deleteFact, async () => renderLedger(await api('delete_fact', { workspaceId, factId: fact.id })));
      }
    });
    deleteActions.append(deleteFact);
    if (fact.source_id) {
      const deleteSource = node('button', 'Delete source and its facts', 'secondary');
      deleteSource.addEventListener('click', () => {
        if (confirm('Delete this source and its dependent facts? Deleting a job description also deletes its workspace.')) {
          run(deleteSource, async () => {
            const result = await api('delete_source', { workspaceId, sourceId: fact.source_id });
            if (result.workspaceDeleted) {
              workspaceId = null; interviewId = null;
              sessionStorage.removeItem('interview-coach-workspace');
              sessionStorage.removeItem('interview-coach-interview');
              show('paste');
            } else renderLedger(await api('ledger', { workspaceId }));
          });
        }
      });
      deleteActions.append(deleteSource);
    }
    const management = document.createElement('details');
    management.append(node('summary', 'More options'), deleteActions);
    card.append(management);
    if (fact.domain !== 'job' && fact.review_state === 'pending' && fact.lifecycle === 'active') {
      const actions = node('div', '', 'actions');
      for (const [label, action] of [['Confirm', 'confirm'], ['Reject', 'reject'], ['Correct', 'correct']]) {
        const button = node('button', label);
        button.type = 'button';
        button.className = 'secondary';
        button.addEventListener('click', () => reviewFact(button, fact.id, action));
        actions.append(button);
      }
      card.append(actions);
    } else if (fact.domain !== 'job' && fact.review_state === 'accepted' && fact.lifecycle === 'active') {
      const button = node('button', 'Correct this fact', 'secondary');
      button.addEventListener('click', () => reviewFact(button, fact.id, 'correct'));
      card.append(button);
    }
    group.append(card);
  }
  if (posting.children.length > 1) list.append(posting);
  for (const group of groups.values()) {
    if (group.storyFacts.every((fact) => fact.domain === 'job')) continue;
    const activeFacts = group.storyFacts.filter((fact) => fact.lifecycle === 'active' &&
      fact.review_state !== 'rejected');
    const accepted = activeFacts.filter((fact) => fact.review_state === 'accepted').length;
    group.dataset.complete = String(activeFacts.length > 0 && accepted === activeFacts.length);
    const progress = node('div', '', 'story-progress');
    progress.setAttribute('aria-hidden', 'true');
    for (const fact of activeFacts) progress.append(node('span', '',
      fact.review_state === 'accepted' ? 'confirmed' : ''));
    const caption = node('p', `${accepted} of ${activeFacts.length} details confirmed`, 'meta');
    group.insertBefore(caption, group.children[1]);
    const groupPending = activeFacts.filter((fact) => fact.review_state === 'pending');
    if (groupPending.length > 1) {
      const all = node('button', `Confirm all ${groupPending.length} from this line`, 'secondary');
      all.addEventListener('click', () => reviewMany(all, groupPending.map((fact) => fact.id), 'confirm'));
      group.insertBefore(all, caption.nextSibling);
    }
    group.insertBefore(progress, caption);
  }
  if (!active.length) list.append(node('p', facts.length ?
    'No current career details are available to confirm. Add résumé details or practice with what you have.' :
    'No career details were found in this source. You can add résumé details or practice without them.'));
  else if (!facts.some((fact) => fact.domain !== 'job')) list.append(node('p', 'No career details were found in this source. You can add résumé details or practice without them.'));
  renderFactConflictPanel(list, facts);
  $('see-debrief').hidden = !interviewId;
  $('view-saved-debrief').hidden = !interviewId;
  const pending = facts.filter((fact) => fact.review_state === 'pending' && fact.lifecycle === 'active' && fact.domain !== 'job');
  $('confirm-all').hidden = pending.length === 0;
  $('confirm-all').textContent = `Looks right, confirm all ${pending.length}`;
  $('confirm-all').dataset.ids = JSON.stringify(pending.map((fact) => fact.id));
  // Once everything is checked, practice becomes the obvious next tap.
  $('ledger-practice').className = pending.length ? 'secondary' : '';
  $('bank-hint').textContent = !active.length ?
    'There are no career details to confirm yet. Add résumé details or practice without them.' : pending.length ?
    'Tap Confirm on anything that\'s true. Fix anything that\'s off. Only confirmed details show up in your practice and your résumé.' :
    'All of your details are confirmed. These are what your practice and your résumé will use. The job posting\'s own lines never need confirming.';
  observeGlassReveals(list);
  activatePrimaryMagnet($('ledger'));
  if (keepScroll) window.scrollTo({ top: scrollY }); else show('ledger');
}

function updateConflictSelection() {
  const button = document.getElementById('report-fact-conflict');
  if (button) {
    button.disabled = selectedConflictFacts.size !== 2;
    button.textContent = selectedConflictFacts.size === 2 ? 'Review these two details' : 'Select two details to compare';
  }
}

function renderFactConflictPanel(list, facts) {
  const panel = node('section', '', 'fact-conflict-panel');
  panel.append(node('h2', 'Conflicting details'));
  panel.append(node('p', 'These are review prompts, not verdicts. The details may differ because they describe different contexts.'));
  const report = node('button', 'Select two details to compare', 'secondary');
  report.id = 'report-fact-conflict';
  report.disabled = selectedConflictFacts.size !== 2;
  report.addEventListener('click', () => run(report, async () => {
    const [factAId, factBId] = [...selectedConflictFacts];
    const reason = prompt('Why might these details conflict? Add a short note.');
    if (!reason?.trim()) return;
    selectedConflictFacts.clear();
    const pairs = await api('report_fact_conflict', { workspaceId, factAId, factBId, reason });
    renderFactConflictPairs(panel, pairs, facts);
    updateConflictSelection();
  }));
  panel.append(report);
  list.prepend(panel);
  api('fact_conflicts', { workspaceId }).then((pairs) => renderFactConflictPairs(panel, pairs, facts))
    .catch((error) => panel.append(node('p', `Conflict review is unavailable: ${error.message}`, 'meta')));
}

function renderFactConflictPairs(panel, pairs, facts) {
  panel.querySelectorAll('.fact-conflict-pair, .fact-conflict-empty').forEach((item) => item.remove());
  if (!pairs.length) {
    panel.append(node('p', 'No potential conflicts detected. You can still select two details above to flag them for review.', 'meta fact-conflict-empty'));
    return;
  }
  for (const pair of pairs) {
    const item = node('article', '', 'fact-conflict-pair');
    item.append(node('p', `${pair.kind === 'qualified_potential' ? 'Potential conflict, shared claim scope' : 'Reported pair'} · ${pair.status.replaceAll('_', ' ')}` , 'meta'));
    for (const fact of [pair.factA, pair.factB]) {
      const title = fact.source_title || 'Source';
      item.append(node('h3', title));
      item.append(node('blockquote', fact.verbatim_quote || fact.display_text || 'No source quote saved.'));
      item.append(node('p', `${friendlyStatus(fact)} · Claim: ${fact.display_text || 'No display text'}` +
        `${fact.qualifiers_json?.claim_scope ? ` · Scope: ${fact.qualifiers_json.claim_scope}` : ''}` +
        `${fact.page_number ? ` · Page ${fact.page_number}` : ''}${fact.section_label ? ` · ${fact.section_label}` : ''}`, 'meta'));
      const diagnostic = node('details', '', 'meta');
      diagnostic.append(node('summary', 'Source identifiers'));
      diagnostic.append(node('p', `Fact ${fact.id}; source ${fact.source_id || 'user assertion'}`));
      item.append(diagnostic);
    }
    if (pair.stale) item.append(node('p', 'The wording changed since the prior review. This pair is open again.', 'meta'));
    if (pair.reason) item.append(node('p', `Review note: ${pair.reason}`));
    if (pair.contextNote) item.append(node('p', `Context retained: ${pair.contextNote}`));
    if (pair.history?.length) {
      const history = node('details', '', 'meta');
      history.append(node('summary', 'Review history'));
      for (const entry of pair.history) history.append(node('p', `${new Date(entry.at).toLocaleString()} · ${entry.status}: ${entry.reason}`));
      item.append(history);
    }
    if (pair.reviewId) {
      const actions = node('div', '', 'actions');
      const choices = pair.status === 'resolved' ? [['Reopen review', 'open']] : pair.status === 'context_review' ?
        [['Update context note', 'context_review'], ['Resolve using this context', 'resolved']] :
        [['Both apply in different contexts', 'context_review'], ['Resolve this review', 'resolved']];
      for (const [label, status] of choices) {
        const button = node('button', label, 'secondary');
        button.addEventListener('click', () => run(button, async () => {
          const reason = prompt(status === 'context_review' ? 'What context explains why both details apply?' :
            status === 'open' ? 'Why should this pair be reviewed again?' : 'Why is this review resolved?');
          if (!reason?.trim()) return;
          const next = await api('update_fact_conflict', { workspaceId, reviewId: pair.reviewId, action: status, reason });
          renderFactConflictPairs(panel, next, facts);
        }));
        actions.append(button);
      }
      item.append(actions);
    } else {
      const start = node('button', pair.stale ? 'Review updated details' : 'Start review', 'secondary');
      start.addEventListener('click', () => run(start, async () => {
        const reason = prompt('Why might these details conflict? Add a short note.');
        if (!reason?.trim()) return;
        const next = await api('report_fact_conflict', { workspaceId, factAId: pair.factAId, factBId: pair.factBId, reason });
        renderFactConflictPairs(panel, next, facts);
      }));
      item.append(start);
    }
    panel.append(item);
  }
}

async function reviewMany(button, factIds, action) {
  await run(button, async () => {
    renderLedger(await api('review_many', { workspaceId, factIds, action }), { keepScroll: true });
    if (action === 'confirm') celebrate(`${factIds.length} details confirmed. Your bank just got stronger.`);
  });
}

async function reviewFact(button, factId, action) {
  if (action === 'correct') return openCorrection(button, factId);
  await run(button, async () => {
    const facts = await api('review', { workspaceId, factId, action });
    renderLedger(facts, { keepScroll: true });
    const updated = facts.find((fact) => fact.id === factId);
    if (action === 'confirm' && updated?.review_state === 'accepted') {
      const card = [...$('fact-list').querySelectorAll('[data-fact-id]')]
        .find((item) => item.dataset.factId === factId);
      celebrate('Proof found. One more detail you can stand behind.', card?.closest('.quote-group'));
    }
  });
}

// A normal, roomy text box right on the card, prefilled with the current wording.
function openCorrection(button, factId) {
  const card = button.closest('[data-fact-id]');
  if (!card || card.querySelector('.correction-editor')) return;
  const current = card.querySelector('h3')?.textContent ?? '';
  const editor = node('form', '', 'correction-editor');
  const label = node('label', 'How would you say it? Your words win.');
  const text = document.createElement('textarea');
  text.rows = 4; text.value = current; text.maxLength = 500; text.id = `correct-${factId}`;
  label.htmlFor = text.id;
  const noteLabel = node('label', 'What changed? (optional)');
  const note = document.createElement('input');
  note.id = `correct-note-${factId}`; note.maxLength = 300; note.placeholder = 'For example: my title was Director, not Manager';
  noteLabel.htmlFor = note.id;
  const actions = node('div', '', 'actions');
  const save = node('button', 'Save my version'); save.type = 'submit';
  const cancel = node('button', 'Cancel', 'secondary'); cancel.type = 'button';
  cancel.addEventListener('click', () => editor.remove());
  actions.append(save, cancel);
  editor.append(label, text, noteLabel, note, actions);
  editor.addEventListener('submit', (event) => {
    event.preventDefault();
    const correction = text.value.trim();
    if (!correction) { text.focus(); return; }
    run(save, async () => {
      renderLedger(await api('review', { workspaceId, factId, action: 'correct', correction,
        reason: note.value.trim() || 'Updated in my own words' }), { keepScroll: true });
    });
  });
  card.append(editor);
  text.focus({ preventScroll: true });
  reveal(editor, 'center');
}

function addTurn(speaker, text) {
  const turn = node('article', '', 'turn');
  turn.dataset.speaker = speaker;
  // AI turns get "Say it plain"; the person's own answers are never touched.
  turn.append(node('p', speaker, 'speaker'), speaker === 'Interviewer' ? plain.plainNode('p', text, 'question') : node('p', text));
  $('transcript').append(turn);
  if (interviewId) interviewCache()?.append(interviewId, { speaker, text });
  return turn;
}

function renderSelfDebrief(error) {
  const turns = interviewCache()?.read(interviewId)?.turns ?? [];
  const target = $('report');
  target.replaceChildren();
  target.append(node('h2', 'You can still review your interview'), node('p',
    'The coach could not finish its review. Your transcript is below. Use these prompts to review it now; retrying later will reuse any completed review.'));
  target.append(node('p', `Coach status: ${error.message || 'Review unavailable right now.'}`, 'meta'));
  target.append(node('h2', 'Your transcript'));
  for (const turn of turns) {
    const article = node('article', '', 'turn');
    article.append(node('p', turn.speaker, 'speaker'), turn.speaker === 'Interviewer' ?
      plain.plainNode('p', turn.text, 'question') : node('p', turn.text));
    target.append(article);
  }
  target.append(node('h2', 'Three questions to ask yourself'));
  for (const prompt of [
    'Did I answer the question directly before adding context?',
    'What did I personally decide or do, and what evidence supports that?',
    'What result can I state clearly, and what detail should I verify before the real interview?',
  ]) target.append(node('p', prompt));
  const retry = node('button', 'Try the coach review again');
  retry.type = 'button';
  retry.addEventListener('click', (event) => run(event.currentTarget, async () => {
    try { renderDebrief(await resolveJob(await api('debrief', { interviewId }))); }
    catch (failure) { renderSelfDebrief(failure); }
  }));
  target.append(retry);
  show('debrief');
}

function restoreCachedInterview() {
  if (!interviewId) return false;
  const cached = interviewCache()?.read(interviewId);
  const turns = cached?.turns ?? [];
  if (!cached || !turns.length) return false;
  $('transcript').replaceChildren();
  for (const turn of turns) {
    const article = node('article', '', 'turn');
    article.dataset.speaker = turn.speaker;
    article.append(node('p', turn.speaker, 'speaker'), turn.speaker === 'Interviewer' ?
      plain.plainNode('p', turn.text, 'question') : node('p', turn.text));
    $('transcript').append(article);
  }
  const savedFocus = readStoredObject(sessionStorage, 'interview-coach-focus');
  showInterviewFocus(savedFocus?.interviewId === interviewId ? savedFocus.focus : null);
  $('answer-form').hidden = cached.finished === true;
  if ($('answer-form').hidden) {
    renderSelfDebrief(new Error('Your interview ended before the coach review finished.'));
    if (guest) {
      const saved = (state.debriefs ?? []).findLast((item) => item.interview_id === interviewId);
      if (saved?.report) renderDebrief(saved.report);
    } else if (currentUser) {
      api('history', { interviewId }).then((saved) => {
        if (saved) $('view-saved-debrief').click();
      }).catch(() => {});
    }
  } else show('interview');
  return true;
}

// The focus for a drilled call stays visible above the question until a normal practice starts.
function showInterviewFocus(focus) {
  const target = $('interview-focus');
  target.textContent = focus ? `Focus for this round: ${focus}.` : '';
  target.hidden = !focus;
  if (focus) sessionStorage.setItem('interview-coach-focus', JSON.stringify({ interviewId, focus }));
  else sessionStorage.removeItem('interview-coach-focus');
}

function openFocusedPractice({ interview, question, focus }) {
  interviewId = interview.id;
  sessionStorage.setItem('interview-coach-interview', interviewId);
  interviewCache()?.clear(interviewId);
  $('transcript').replaceChildren();
  $('between-answer-coaching').replaceChildren();
  $('interview-heading').textContent = interview.practice_mode === 'coach' ? 'Coach mode' : 'Mock interview';
  showInterviewFocus(focus);
  $('answer-form').hidden = false;
  $('voice-transcript-tools').hidden = true;
  addTurn('Interviewer', question);
  show('interview');
}

function renderScores(title, scores, target) {
  target.append(node('h2', title));
  for (const [name, entry] of Object.entries(scores)) {
    const label = { relevance: 'Answered the question', ownership: 'Your part was clear', evidence: 'Proof', outcome: 'Result',
      structure: 'Shape of the story', clarity: 'Easy to follow', concision: 'Right length' }[name] || name;
    const score = node('div', `${label}: ${entry.score} of 5. `, 'score');
    score.append(plain.plainSpan(entry.reason, 'debrief'));
    score.style.setProperty('--score-fill', `${Math.max(0, Math.min(5, entry.score)) * 20}%`);
    target.append(score);
  }
}

function renderDebrief(report) {
  const target = $('report');
  target.replaceChildren();
  if (report.factGateUnavailable) target.append(node('p',
    'The evidence cross-check did not finish. Review any claims below against your own records before relying on them.', 'meta'));
  const feedbackParts = String(report.feedback ?? '').match(/^(.*?)(\s+Next time:\s*.+)$/is);
  target.append(node('h2', 'What worked'));
  target.append(plain.plainNode('p', feedbackParts?.[1] ?? report.feedback, 'debrief'));
  target.append(node('h2', 'Next time'));
  target.append(plain.plainNode('p', feedbackParts?.[2]?.trim() ?? 'Next time: choose one detail you can stand behind.', 'debrief'));
  const evidence = report.contentScores.evidence;
  const headline = node('section', '', 'evidence-headline');
  headline.style.setProperty('--proof-score', `${Math.max(0, Math.min(5, evidence?.score ?? 0)) * 20}%`);
  const bigNumber = node('div', evidence ? `0/5` : '—', 'big-number count-up');
  headline.append(bigNumber);
  if (evidence) requestAnimationFrame(() => countUp(bigNumber, evidence.score, '/5'));
  const explanation = node('div', '');
  explanation.append(node('p', 'Proof', 'eyebrow'),
    node('h2', 'How much proof came through?'), evidence?.reason ? plain.plainNode('p', evidence.reason, 'debrief') : node('p', 'Proof wasn\'t scored for this run.'),
    node('p', 'An AI coach\'s read of this one practice run, out of 5.', 'meta'));
  headline.append(explanation);
  target.append(headline);
  renderScores('What you said', report.contentScores, target);
  renderScores('How it came across', report.deliveryScores, target);
  target.append(node('p', `Not assessed: ${report.unassessed.join(', ')}`));
  if (!report.factGate?.length) {
    target.append(node('h2', 'Claims to check'));
    if (!report.unsupportedClaims.length) target.append(node('p', 'Nothing needed a source this time.'));
    for (const claim of report.unsupportedClaims) {
      target.append(plain.plainNode('p', claim, 'debrief'), node('p',
        'Add the real number if you have it, or say it without a number.', 'meta'));
    }
  }
  if (report.factGate?.length) target.append(node('h2', 'Check these before you use them'));
  for (const [index, item] of (report.factGate ?? []).entries()) {
    const label = item.lane === 'under_claim' ? 'You can say more precisely' :
      item.lane === 'gap' ? 'A detail to check' : 'A claim to revisit';
    const check = node('p', `${label}: “${item.answerQuote}” `);
    check.append(plain.plainSpan(item.note, 'debrief'), document.createTextNode(`. Options: ${item.options.join(' / ')}.`));
    target.append(check);
    if (item.supportQuotes?.length) target.append(node('p', `Your record: ${item.supportQuotes.join('; ')}`, 'meta'));
    const actions = node('div', '', 'actions');
    const choices = item.lane === 'under_claim' ? [['precise', 'Say it precisely'], ['qualitative', 'Keep my wording']] :
      item.lane === 'gap' ? [['confirm', 'Confirm detail'], ['use_range', 'Use a range'], ['qualitative', 'Keep it qualitative']] :
        [['confirm', 'Confirm my version'], ['use_range', 'Use a range'], ['drop', 'Drop it']];
    for (const [choice, labelText] of choices) {
      const button = node('button', labelText, 'secondary');
      button.addEventListener('click', () => {
        const note = choice === 'use_range' ? prompt('What range can you support?') :
          choice === 'confirm' && item.lane === 'gap' ? prompt('What missing detail can you confirm?') : null;
        if ((choice === 'use_range' || (choice === 'confirm' && item.lane === 'gap')) && !note) return;
        run(button, async () => {
          const result = await api('fact_gate_decision', { interviewId, itemIndex: index, choice, note });
          actions.replaceChildren(node('p', result.proposalId ?
            'New detail saved for review. Confirm it in My facts before using it.' : 'Choice saved.'));
        });
      });
      actions.append(button);
    }
    target.append(actions);
  }
  target.append(node('h2', 'Confirmed source wording'));
  if (report.styleApplied) target.append(node('p', 'Feedback uses your writing preferences. Confirmed source wording stays exact.', 'meta'));
  target.append(node('p', report.rewrite.ready ? report.rewrite.text : report.rewrite.missingDetailQuestion));
  if (report.rewrite.ready) target.append(node('p', 'Built from your confirmed evidence.', 'meta'));
  if (report.stronger) renderStronger(report.stronger, target);
  if (interviewId) {
    const drill = node('button', 'Drill this call', 'secondary');
    drill.type = 'button';
    drill.addEventListener('click', () => run(drill, async () => openFocusedPractice(await api('drill_call', { interviewId }))));
    target.append(drill);
  }
  if (!guest) {
    const flag = node('button', 'This feedback is off', 'secondary');
    const box = document.createElement('form'); box.hidden = true;
    const label = node('label', 'What should I do differently from now on?');
    const input = document.createElement('textarea'); input.maxLength = 500; input.rows = 3; input.required = true;
    const save = node('button', 'Save note'); save.type = 'submit';
    box.append(label, input, save);
    flag.addEventListener('click', () => { box.hidden = !box.hidden; if (!box.hidden) input.focus(); });
    box.addEventListener('submit', (event) => { event.preventDefault(); run(save, async () => {
      await api('flag_debrief', { interviewId, note: input.value });
      box.replaceChildren(node('p', "Got it. I'll do this in your future practice."));
    }); });
    target.append(flag, box);
  }
  show('debrief');
}

async function renderCoachNotes() {
  if (guest || !currentUser || !$('coach-note-list')) return;
  const target = $('coach-note-list'); target.replaceChildren();
  const notes = await api('coach_notes', { workspaceId });
  for (const note of notes) {
    const item = document.createElement('article');
    const text = document.createElement('textarea'); text.value = note.text; text.maxLength = 500; text.rows = 2;
    const save = node('button', 'Save', 'secondary'); const toggle = node('button', note.active ? 'Turn off' : 'Turn on', 'secondary');
    const remove = node('button', 'Delete', 'secondary');
    save.addEventListener('click', () => run(save, async () => { await api('coach_note_update', { id: note.id, text: text.value }); renderCoachNotes(); }));
    toggle.addEventListener('click', () => run(toggle, async () => { await api('coach_note_update', { id: note.id, active: !note.active }); renderCoachNotes(); }));
    remove.addEventListener('click', () => run(remove, async () => { await api('coach_note_delete', { id: note.id }); renderCoachNotes(); }));
    item.append(text, save, toggle, remove); target.append(item);
  }
}

async function startPrepJobs(jobs) {
  const responses = await Promise.all((jobs ?? []).map((job) => fetch('/.netlify/functions/model-job-background', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-coach-csrf': '1' },
    body: JSON.stringify({ jobId: job.id }),
  })));
  if (responses.some((response) => !response.ok && response.status !== 202)) {
    throw new Error('Could not start every Prep Pack section. Refresh the unfinished sections to retry.');
  }
}

function renderPrepPack(result) {
  currentPrepSections = result.sections;
  const byKey = new Map(result.sections.map((section) => [section.section_key, section]));
  const target = $('prep-sections'); target.replaceChildren();
  const ready = result.sections.filter((section) => section.status === 'ready').length;
  $('prep-progress').textContent = `${ready} of ${PREP_PACK_ORDER.length} ready`;
  const countdown = interviewCountdown(currentWorkspace?.interview_date);
  $('prep-countdown').hidden = !countdown;
  if (countdown) $('prep-countdown').textContent = `${countdown.days <= 0 ? 'Interview day' :
    `${countdown.days} day${countdown.days === 1 ? '' : 's'} left`}. Focus ${countdown.label}: strongest stories, hard questions, then your calm kit.`;
  for (const key of PREP_PACK_ORDER) {
    const section = byKey.get(key);
    if (!section) continue;
    const article = node('article', '', 'prep-section'); article.dataset.status = section.status;
    article.append(node('h2', section.title));
    if (section.status === 'ready') {
      const list = node('ul');
      for (const line of section.content_json?.lines ?? []) {
        const item = node('li'); item.append(plain.plainSpan(line.text, 'debrief')); list.append(item);
      }
      article.append(list, node('p', `Next step: ${section.content_json?.nextStep ?? ''}`, 'note'));
      if (section.content_json?.validationErrors?.length) article.append(node('p',
        `${section.content_json.validationErrors.length} unsupported line${section.content_json.validationErrors.length === 1 ? ' was' : 's were'} left out.`, 'meta'));
    } else {
      article.append(node('p', section.status === 'failed' ? 'This section did not finish.' :
        section.status === 'stale' ? 'Out of date, refresh.' : 'Building this section…', 'meta'));
    }
    const refresh = node('button', section.status === 'failed' ? 'Retry this section' : 'Refresh this section', 'secondary');
    refresh.addEventListener('click', () => run(refresh, async () => {
      const updated = await api('prep_section_refresh', { workspaceId, sectionKey: key });
      renderPrepPack(updated); await startPrepJobs(updated.jobs); await pollPrepPack();
    }));
    article.append(refresh); target.append(article);
  }
}

async function pollPrepPack() {
  for (let attempt = 0; attempt < 90 && !$('prep-pack').hidden; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = await api('prep_pack', { workspaceId });
    renderPrepPack(result);
    if (!result.sections.some((section) => ['queued', 'running'].includes(section.status))) return;
  }
}

async function openPrepPack() {
  if (guest) { message('Sign in to build and save a Prep Pack.'); return; }
  show('prep-pack');
  const result = await api('prep_pack', { workspaceId });
  renderPrepPack(result);
  await startPrepJobs(result.jobs);
  await pollPrepPack();
}

function renderStronger(draft, target = $('report')) {
  target.querySelector('#stronger-track')?.remove();
  const section = node('section', '', 'panel');
  section.id = 'stronger-track';
  section.append(node('h2', 'Stronger if true'), plain.plainNode('p', draft.text, 'debrief'));
  for (const slot of draft.slots) {
    if (slot.state !== 'pending') continue;
    const form = document.createElement('form');
    const label = node('label', 'Fill ');
    label.append(plain.plainSpan(slot.label, 'debrief'));
    const input = document.createElement('input');
    input.maxLength = 500;
    label.append(input);
    const fill = node('button', 'Propose detail');
    fill.type = 'submit';
    const waive = node('button', 'Leave it out', 'secondary');
    waive.type = 'button';
    form.append(label, fill, waive);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(fill, async () => {
        renderStronger(await api('resolve_stronger_slot', { slotId: slot.id, action: 'fill', value: input.value }));
        message('New detail saved for review. Confirm it in My facts before copying this draft.');
      });
    });
    waive.addEventListener('click', () => {
      const reason = prompt(`Why leave out ${slot.label}?`);
      if (!reason) return;
      run(waive, async () => renderStronger(await api('resolve_stronger_slot',
        { slotId: slot.id, action: 'waive', reason })));
    });
    section.append(form);
  }
  const copy = node('button', 'Copy stronger draft');
  copy.disabled = !draft.ready;
  copy.addEventListener('click', () => navigator.clipboard.writeText(draft.text));
  section.append(copy);
  if (!draft.ready) section.append(node('p', 'Fill and confirm each detail, or leave it out, to enable copying.'));
  target.append(section);
}

async function renderWorkspaces() {
  const version = navigationVersion;
  const stillOnHub = () => navigationVersion === version && !$('workspaces').hidden;
  const list = $('workspace-list');
  clearProofShelf();
  list.replaceChildren();
  $('requirement-list').replaceChildren();
  $('job-comparison-table').replaceChildren();
  const workspaces = await api('workspaces');
  if (!stillOnHub()) return;
  // Postgres hands dates back as full timestamps; the date inputs, rows and CSV all want YYYY-MM-DD.
  for (const workspace of workspaces) for (const key of ['applied_on', 'next_step_on']) if (workspace[key]) workspace[key] = String(workspace[key]).slice(0, 10);
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
    forgetWorkspace();
    if (!workspaces.length) {
      currentWorkspace = null;
      setWorkspaceHubEmptyState(true);
      return;
    }
    workspaceId = pickDefaultWorkspace(workspaces).id;
    sessionStorage.setItem('interview-coach-workspace', workspaceId);
  }
  setWorkspaceHubEmptyState(false);
  hubWorkspaces = workspaces;
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);
  currentWorkspace = selected ?? null;
  $('pay-details').value = selected?.pay_details ?? '';
  $('benefits-details').value = selected?.benefits_details ?? '';
  $('learned-details').value = selected?.learned_details ?? '';
  const comparison = $('job-comparison-table');
  comparison.replaceChildren();
  if (workspaces.length) {
    const table = node('table', '', 'comparison-table');
    const head = node('thead');
    const heading = node('tr');
    const columnTitles = ['Job', 'Role', 'Company', 'Pay', 'Benefits', 'Work mode', 'Interview', 'What I’ve learned'];
    for (const title of columnTitles) heading.append(node('th', title));
    head.append(heading);
    const body = node('tbody');
    for (const workspace of workspaces) {
      const row = node('tr');
      row.append(node('th', workspace.label));
      row.append(node('td', workspace.role_title?.trim() || 'Not known yet'));
      row.append(node('td', workspace.company_name?.trim() || 'Not known yet'));
      const addComparisonValue = (field, kind) => {
        const cell = node('td');
        if (field?.trim()) {
          cell.append(node('span', 'You added', 'comparison-origin'), node('p', field.trim()));
        } else {
          const quotes = postingDetails(workspace.jd_text, kind);
          if (quotes.length) {
            cell.append(node('span', 'From job posting', 'comparison-origin'));
            for (const quote of quotes) cell.append(node('q', quote));
          } else cell.append(node('span', 'Not known yet', 'unknown-value'));
        }
        row.append(cell);
      };
      addComparisonValue(workspace.pay_details, 'pay');
      addComparisonValue(workspace.benefits_details, 'benefits');
      row.append(node('td', workspace.listing_work_mode && workspace.listing_work_mode !== 'unspecified' ?
        workspace.listing_work_mode[0].toUpperCase() + workspace.listing_work_mode.slice(1) : 'Not known yet'));
      const interview = workspace.interview_date ? new Date(workspace.interview_date) : null;
      row.append(node('td', interview && !Number.isNaN(interview.valueOf()) ?
        interview.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not scheduled'));
      const notes = node('td');
      notes.append(workspace.learned_details?.trim() ? node('p', workspace.learned_details.trim()) :
        node('span', 'Not known yet', 'unknown-value'));
      row.append(notes);
      [...row.children].slice(1).forEach((cell, index) => cell.setAttribute('data-label', columnTitles[index + 1]));
      body.append(row);
    }
    table.append(head, body);
    comparison.append(table);
  }
  list.replaceChildren();
  $('job-hunt-summary').textContent = huntSummary(workspaces);
  $('remote-preference').value = selected?.remote_preference ?? 'unspecified';
  $('listing-work-mode').value = selected?.listing_work_mode ?? 'unspecified';
  $('role-title').value = selected?.role_title ?? selected?.label ?? '';
  $('company-name').value = selected?.company_name ?? '';
  $('interview-date').value = dateTimeInputValue(selected?.interview_date);
  const grouped = new Map(HUNT_STATUSES.map((status) => [status, []]));
  for (const workspace of workspaces) grouped.get(workspace.hunt_status ?? 'saved').push(workspace);
  for (const status of HUNT_STATUSES) {
    const group = grouped.get(status);
    if (!group.length) continue;
    const section = node('section', '', 'job-hunt-group');
    section.append(node('h2', statusLabel(status)));
    for (const workspace of group) {
    const row = node('div', '', 'job-hunt-row');
    const button = node('button', workspace.label, workspace.id === workspaceId ? '' : 'secondary');
    button.addEventListener('click', () => {
      workspaceId = workspace.id;
      interviewId = null;
      sessionStorage.setItem('interview-coach-workspace', workspaceId);
      sessionStorage.removeItem('interview-coach-interview');
      renderWorkspaces().catch((error) => message(error.message));
    });
    if (workspace.id === workspaceId) button.setAttribute('aria-current', 'true');
    row.append(button, node('span', `Status: ${statusLabel(workspace.hunt_status ?? 'saved')}`,
      CLOSED_HUNT_STATUSES.has(workspace.hunt_status) ? 'chip hunt-status-closed' : 'chip'));
    if (workspace.applied_on) row.append(node('span', `Applied ${shortDay(workspace.applied_on)}`, 'meta'));
    if (workspace.next_step) row.append(node('span', `Next: ${workspace.next_step}${workspace.next_step_on ? `, by ${shortDay(workspace.next_step_on)}` : ''}${nextStepOverdue(workspace) ? ', overdue' : ''}`, nextStepOverdue(workspace) ? 'meta hunt-overdue' : 'meta'));
    if (workspace.interview_date) row.append(node('span', `Interview ${new Date(workspace.interview_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, 'meta'));
    section.append(row);
    }
    list.append(section);
  }
  const add = node('button', '+ Add a job', 'secondary add-job');
  add.type = 'button';
  add.addEventListener('click', () => show('paste'));
  list.append(add);
  await renderJobHunt(selected);
  if (!stillOnHub()) return;
  $('hub-intro').textContent = selected?.public_summary ? `Look through the practice workspace for ${selected.label}. Read the confirmed facts, then try a practice interview.` : `You're working on: ${selected?.label ?? 'this job'}. Pick what to do next.`;
  const target = $('requirement-list');
  target.replaceChildren();
  const lanes = new Map();
  for (const [category, title, description] of [
    ['direct', 'You have proof', 'Something you did that shows it.'],
    ['adjacent', 'Close, needs a bridge', 'Related experience you can explain in the room.'],
    ['none', 'No story yet', 'Something to find in your past or get ready to talk through.'],
  ]) {
    const lane = node('section', '', 'map-lane');
    lane.dataset.lane = category;
    lane.append(node('h3', title), node('p', description, 'meta'));
    lanes.set(category, lane);
    target.append(lane);
  }
  const facts = workspaceId ? await api('ledger', { workspaceId }) : [];
  if (!stillOnHub()) return;
  $('public-workspace-note').hidden = !selected?.public_summary;
  const acceptedProof = facts.filter((fact) => fact.domain === 'candidate' && fact.review_state === 'accepted' && fact.lifecycle === 'active');
  $('proof-shelf').hidden = !acceptedProof.length;
  $('proof-shelf-list').replaceChildren(...acceptedProof.map((fact) => {
    const article = node('article'); article.append(node('p', fact.display_text || fact.verbatim_quote),
      node('p', fact.source_title || 'Confirmed source', 'meta')); return article;
  }));
  const progress = currentUser ? await api('workspace_progress', { workspaceId }) :
    { pending_facts: facts.filter((fact) => fact.domain === 'candidate' && fact.review_state === 'pending').length,
      has_prep_pack: false, has_practice: false, has_debrief: false };
  if (!stillOnHub()) return;
  const next = chooseNextStep({ pendingFacts: progress.pending_facts, hasPrepPack: progress.has_prep_pack,
    hasPractice: progress.has_practice, debriefWaiting: progress.has_debrief &&
      sessionStorage.getItem(`interview-coach-debrief-read:${workspaceId}`) !== '1', interviewDate: selected?.interview_date,
    guest });
  const nextButton = $('next-step-action'); nextButton.textContent = next.label;
  $('next-step-reason').textContent = next.reason;
  nextButton.onclick = () => {
    if (next.key === 'facts') api('ledger', { workspaceId }).then(renderLedger).catch((error) => message(error.message));
    else if (next.key === 'prep' || next.key === 'cram') openPrepPack().catch((error) => message(error.message));
    else if (next.key === 'debrief') {
      sessionStorage.setItem(`interview-coach-debrief-read:${workspaceId}`, '1');
      interviewId = progress.latest_debrief_interview_id;
      sessionStorage.setItem('interview-coach-interview', interviewId);
      $('view-saved-debrief').click();
    }
    else openPractice();
  };
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const requirements = workspaceId ? await api('requirements', { workspaceId }) : [];
  if (!stillOnHub()) return;
  // First visit to a job: build the match in the background instead of waiting for a tap.
  if (workspaceId && !requirements.length && !mapBuilding.has(workspaceId) && !mapFailed.has(workspaceId)) {
    const building = workspaceId;
    mapBuilding.add(building);
    api('workspace_map', { workspaceId: building }).then(resolveJob)
      .catch(() => mapFailed.add(building))
      .finally(() => {
        mapBuilding.delete(building); // clear before redrawing so the lanes stop saying "Matching"
        if (workspaceId === building && !$('workspaces').hidden) renderWorkspaces().catch(() => {});
      });
  }
  for (const requirement of requirements) {
    const card = node('article', '', 'fact');
    card.append(node('p', selected?.public_summary ? 'Practice focus' : ({ must: 'Must have', preferred: 'Nice to have', responsibility: 'Part of the job' })[requirement.type] || 'From the posting', 'eyebrow'));
    card.append(node('h3', requirement.text));
    card.append(node('p', `${({ direct: 'You have proof', adjacent: 'Close, transferable proof', none: 'No story yet' })[requirement.category] || ''} · ${requirement.competency}`));
    card.append(plain.plainNode('p', requirement.rationale, 'debrief'));
    card.append(plain.plainNode('p', `What would prove it: ${requirement.evidence_needed}`, 'debrief', 'meta'));
    card.append(node('p', selected?.public_summary ? 'Public rehearsal guidance, not an employer posting quote' : 'From the job posting', 'meta'));
    if (requirement.category === 'adjacent' && requirement.fact_ids.length) {
      card.append(node('p', 'Related proof from your experience. It helps, but it does not claim the full requirement.', 'meta'));
    }
    for (const factId of requirement.fact_ids) {
      const fact = factById.get(factId);
      const label = requirement.category === 'adjacent' ? 'Transferable proof' : 'Your proof';
      const link = node('button', `${label}: ${fact?.verbatim_quote ?? 'see your facts'}`, 'secondary');
      link.addEventListener('click', () => renderLedger([...factById.values()]));
      card.append(link);
    }
    (lanes.get(requirement.category) ?? lanes.get('none')).append(card);
  }
  for (const lane of lanes.values()) {
    if (!lane.querySelector('.fact')) lane.append(node('p', mapBuilding.has(workspaceId) ?
      'Matching your experience to the posting. About 30 seconds…' : mapFailed.has(workspaceId) ?
        'Couldn\'t build the match just now. Tap "Refresh the match" to try again.' : 'Nothing here for this job.', 'meta'));
  }
  observeGlassReveals($('workspaces'));
}

function shortDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}
function statusLabel(status) { return status.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()); }

async function renderJobHunt(selected) {
  const status = $('hunt-status');
  status.replaceChildren();
  for (const value of HUNT_STATUSES) {
    const option = node('option', statusLabel(value)); option.value = value; status.append(option);
  }
  status.value = selected?.hunt_status ?? 'saved';
  $('hunt-applied-on').value = selected?.applied_on ?? '';
  $('hunt-next-step').value = selected?.next_step ?? '';
  $('hunt-next-step-on').value = selected?.next_step_on ?? '';
  $('hunt-posting-link').value = selected?.posting_link ?? '';
  $('hunt-notes').value = selected?.hunt_notes ?? '';
  $('job-hunt-brief').textContent = [statusLabel(selected?.hunt_status ?? 'saved'),
    selected?.next_step ? `next: ${selected.next_step}${selected.next_step_on ? `, by ${shortDay(selected.next_step_on)}` : ''}` : 'tap to add dates, a next step and notes'].join(' · ');
  const today = new Date().toISOString().slice(0, 10);
  $('hunt-happened-on').value = today;
  $('hunt-log-happened-on').value = today;
  const history = selected ? await api('job_hunt_history', { workspaceId: selected.id }) : [];
  for (const entry of history) if (entry.happened_on) entry.happened_on = String(entry.happened_on).slice(0, 10);
  const target = $('job-hunt-history'); target.replaceChildren();
  if (!history.length) target.append(node('p', 'No updates yet. Add one when it helps.', 'meta'));
  for (const entry of history) {
    const item = node('article', '', 'fact');
    item.append(node('p', entry.action.replace(/^Status: (\w+)$/, (_m, value) => `Moved to ${statusLabel(value)}`)), node('p', `${shortDay(entry.happened_on)}${entry.note ? `: ${entry.note}` : ''}`, 'meta'));
    const remove = node('button', 'Delete log entry', 'secondary');
    remove.addEventListener('click', () => run(remove, async () => {
      await api('job_hunt_log_delete', { historyId: entry.id }); await renderWorkspaces();
    }));
    item.append(remove); target.append(item);
  }
}

function setWorkspaceHubEmptyState(isEmpty) {
  $('empty-workspace-state').hidden = !isEmpty;
  for (const item of document.querySelectorAll('[data-workspace-content]')) item.hidden = isEmpty;
}

function openWorkspaceHub() {
  show('workspaces');
  // Start from a valid empty state. This avoids briefly showing controls for a job that
  // may not exist while the guest workspace list is loading.
  setWorkspaceHubEmptyState(true);
  return renderWorkspaces();
}

function renderImmersion(result) {
  immersion = result;
  const target = $('immerser-content');
  const choices = $('immerser-choices');
  target.replaceChildren();
  choices.replaceChildren();
  const route = node('ol', '', 'week-route');
  route.setAttribute('aria-label', 'Scene itinerary');
  route.tabIndex = 0;
  for (const [index, scene] of result.plan.scenes.entries()) {
    const step = node('li', `${String(index + 1).padStart(2, '0')} · ${scene.day}`);
    if (!result.state.complete && scene.id === result.state.sceneId) step.setAttribute('aria-current', 'step');
    if (result.state.history.some((entry) => entry.sceneId === scene.id)) step.className = 'visited';
    route.append(step);
  }
  target.append(route);
  $('immerser-action').hidden = result.state.complete;
  const prior = result.state.history.at(-1);
  if (prior) {
    const consequence = node('article', '', 'consequence');
    consequence.append(node('h2', 'What followed'), plain.plainNode('p', prior.consequence, 'scenario'),
      node('p', 'Typical for this role · fictional consequence', 'meta'));
    if (prior.honesty) consequence.append(node('p', prior.honesty));
    target.append(consequence);
  }
  if (result.state.complete) {
    target.append(node('h2', 'Your week in review'));
    target.append(node('p', 'There is no grade. These are the trade-offs your choices raised.'));
    const list = document.createElement('ul');
    for (const item of result.debrief.tradeoffs) list.append(plain.plainNode('li', item, 'scenario'));
    target.append(list, node('h2', 'Use this in an interview'),
      plain.plainNode('p', result.debrief.first90Days, 'scenario'), plain.plainNode('p', result.debrief.caseQuestion, 'question'));
  } else {
    const scene = result.plan.scenes.find((item) => item.id === result.state.sceneId);
    if (!Object.keys(result.companySources).length) target.append(node('p',
      "No verified company facts are loaded for this workspace. These scenes use the JD and fictional role examples.", 'meta'));
    const stage = node('article', '', 'scene-stage');
    stage.append(node('p', `${scene.day} · Scene ${result.state.history.length + 1} of ${result.plan.scenes.length}`, 'meta'),
      node('h2', scene.title), plain.plainNode('p', scene.situation, 'scenario'),
      node('p', 'Typical for this role · fictional practice scene', 'meta'));
    for (const detail of scene.details) {
      const article = node('article', '', 'fact');
      article.append(node('p', detail.text));
      if (detail.provenance === 'jd') article.append(node('p', 'From the job description', 'meta'));
      else if (detail.provenance === 'typical') article.append(node('p', 'Typical for this role · fictional practice detail', 'meta'));
      else {
        const link = node('a', 'Verified company source', 'meta');
        link.href = result.companySources[detail.sourceId];
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        article.append(link);
      }
      stage.append(article);
    }
    stage.append(plain.plainNode('h3', scene.ask, 'question'));
    target.append(stage);
    for (const [index, choice] of scene.choices.entries()) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'immerser-choice'; input.value = choice.id;
      input.required = true; input.checked = index === 0;
      label.append(input, document.createTextNode(` ${choice.label}`));
      choices.append(label);
    }
    $('immerser-response').value = '';
  }
  show('immerser');
  if (result.state?.history?.length) reveal($('immerser-content'));
}

$('open-immerser').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const saved = await api('immerse_get', { workspaceId });
  renderImmersion(saved ?? await resolveJob(await api('immerse_start', { workspaceId })));
}));
$('immerser-new').addEventListener('click', (event) => run(event.currentTarget, async () =>
  renderImmersion(await resolveJob(await api('immerse_start', { workspaceId })))));
$('immerser-action').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const choiceId = $('immerser-choices').querySelector('input:checked')?.value;
    renderImmersion(await api('immerse_act', { immersionId: immersion.id, choiceId,
      response: $('immerser-response').value }));
  });
});
$('immerser-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('immerser-ledger').addEventListener('click', () => api('ledger', { workspaceId })
  .then(renderLedger).catch((error) => message(error.message)));

async function uploadOriginal(file, sourceId, mimeType, extractedText) {
  if (guest || !file) return;
  const partSize = 1400000;
  const parts = Math.ceil(file.size / partSize);
  const upload = await api('upload_init', { sourceId, name: file.name, mimeType,
    byteSize: file.size, chunkCount: parts, extractedText });
  for (let part = 0; part < parts; part += 1) {
    const bytes = new Uint8Array(await file.slice(part * partSize, (part + 1) * partSize).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await api('upload_chunk', { uploadId: upload.id, part, base64: btoa(binary) });
  }
  await api('upload_finish', { uploadId: upload.id });
}

async function fileText(file) {
  if (!file) return null;
  const parsed = await extractImportDocument(file);
  if (parsed.text.length > 12000) throw new Error('Extracted text exceeds 12,000 characters. Paste the most relevant passages.');
  return parsed;
}

async function renderSamples() {
  const profile = await api('writing_profile');
  const list = $('sample-list');
  list.replaceChildren();
  for (const sample of profile.samples) {
    const line = node('p', sample.title);
    const remove = node('button', 'Delete sample', 'secondary');
    remove.addEventListener('click', () => run(remove, async () => {
      await api('delete_writing_sample', { sourceId: sample.id });
      await renderSamples();
    }));
    line.append(remove);
    list.append(line);
  }
  $('style-preferences').value = profile.preferences;
  $('style-form').querySelector('button').disabled = profile.samples.length < 2 || profile.samples.length > 3;
  list.append(node('p', profile.enabled ? 'Your style preferences are active.' :
    `${profile.samples.length} of 2–3 samples added.`, 'meta'));
}

function openAuth() { message(''); show('auth'); }
$('show-auth').addEventListener('click', openAuth);
$('header-auth').addEventListener('click', openAuth);
$('header-home').addEventListener('click', () => show('landing'));
$('start-auth').addEventListener('click', openAuth);
$('start-sample').addEventListener('click', () => $('try-sample').click());
$('start-own-resume').addEventListener('click', () => {
  if (hasSession()) openWorkspaceHub().catch((error) => message(error.message));
  else $('try-guest').click();
});
$('public-workspace-back').addEventListener('click', () => show('landing'));
$('proof-shelf-open').addEventListener('click', () => api('ledger', { workspaceId }).then(renderLedger).catch((error) => message(error.message)));
$('try-guest').addEventListener('click', () => {
  message('');
  if (currentUser) { show('paste'); return; }
  guest = true;
  state = readGuestState(sessionStorage, guestKey) ?? {};
  if (state.workspaces?.some((item) => item.public_summary)) {
    state = {};
    sessionStorage.removeItem(guestKey);
    sessionStorage.removeItem(guestDraftKey);
    $('resume').value = ''; $('jd').value = ''; $('job-label').value = '';
  }
  if (!state || !Object.keys(state).length) forgetWorkspace();
  identity();
  restoreGuestDrafts();
  show('paste');
});
$('end-session').addEventListener('click', (event) => run(event.currentTarget, async () => {
  // A network failure must not pretend the server's session cookie was revoked.
  if (!guest) await api('logout');
  interviewCache()?.clearNamespace();
  clearInterviewCoachLocalStorage();
  sessionStorage.removeItem(guestKey);
  sessionStorage.removeItem(guestCacheSessionKey);
  sessionStorage.removeItem('interview-coach-workspace');
  sessionStorage.removeItem('interview-coach-interview');
  sessionStorage.removeItem('interview-coach-job');
  sessionStorage.removeItem(guestDraftKey);
  sessionStorage.removeItem(guestAnswerKey);
  guest = false; state = {}; workspaceId = null; interviewId = null; pendingJob = null; currentUser = null;
  identity(); show('landing');
}));
pendingJobRecovery = createPendingJobRecovery({
  button: $('retry-pending-job'),
  runAction: (button, task) => run(button, task),
  onCheckAgain: () => resumeJob(),
  onRetry: async () => {
    if (!pendingJob) throw new Error('No pending job.');
    const retriedJob = await api('retry_job', { jobId: pendingJob.id });
    pendingJob = retriedJob;
    sessionStorage.setItem('interview-coach-job', JSON.stringify(retriedJob));
    pendingJobRecovery.clear();
    await resumeJob();
  },
});
$('delete-account').addEventListener('click', (event) => {
  if (!confirm('Permanently delete your account and all its interview data?')) return;
  run(event.currentTarget, async () => {
    interviewCache()?.clearNamespace();
    await api('delete_account');
    clearInterviewCoachLocalStorage();
    currentUser = null; workspaceId = null; interviewId = null;
    sessionStorage.removeItem('interview-coach-workspace');
    sessionStorage.removeItem('interview-coach-interview');
    identity(); show('landing');
  });
});
$('auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.submitter;
  run(button, async () => {
    const form = new FormData(event.currentTarget);
    const response = await api(button.value, { username: form.get('username'), password: form.get('password') });
    currentUser = response.user;
    guest = false; state = {};
    sessionStorage.removeItem(guestKey);
    applySessionDetails(await fetch('/api?op=session', { credentials: 'same-origin' }).then((reply) => reply.json()));
    $('password').value = '';
    forgetWorkspace();
    identity();
    // A brand-new account has no jobs by definition, so take them straight to adding one.
    if (button.value === 'signup') show('paste'); else await openWorkspaceHub();
  });
});

// Shrink a screenshot so a few of them fit in a request, then return it as base64 JPEG.
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Screenshots become text in the box next to the picker, one image at a time, so she can fix any misread before it's used.
async function readScreenshots(files, textareaId) {
  const screenshotEpoch = sessionEpoch;
  const box = $(textareaId);
  const found = [];
  for (const [index, file] of files.entries()) {
    message(`Reading screenshot ${index + 1} of ${files.length}…`);
    try {
      const base64 = await shrinkImage(file);
      if (screenshotEpoch !== sessionEpoch) return;
      const reply = await api('read_image', { base64, mimeType: 'image/jpeg' });
      if (screenshotEpoch !== sessionEpoch) return;
      if (reply.text) found.push(reply.text);
      else message(`Screenshot ${index + 1} had no readable text.`);
    } catch (error) { message(`Couldn't read screenshot ${index + 1}: ${error.message}`); }
  }
  if (found.length) {
    const joined = [box.value.trim(), ...found].filter(Boolean).join('\n\n');
    box.value = joined.slice(0, box.maxLength > 0 ? box.maxLength : 12000);
    message(`Added text from ${found.length} screenshot${found.length === 1 ? '' : 's'}. Read it over and fix anything that looks off.`);
  }
}

// A picked file can always be removed, and a wrong type is cleared at once so it can't block pasting.
for (const [id, boxId] of [['resume-file', 'resume'], ['jd-file', 'jd'], ['library-file', null]]) {
  const input = $(id);
  if (!input) continue;
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove file'; remove.hidden = true;
  input.insertAdjacentElement('afterend', remove);
  remove.addEventListener('click', () => { input.value = ''; remove.hidden = true; });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) { remove.hidden = true; return; }
    try {
      const types = await Promise.all(files.map((file) => classifyImportFile(file)));
      const images = files.filter((_, index) => types[index].kind === 'image');
      if (images.length && boxId) {
        if (images.length !== files.length) throw new Error('Choose screenshots together, or one document at a time.');
        input.value = ''; remove.hidden = true;
        input.disabled = true;
        try { await readScreenshots(images, boxId); } finally { input.disabled = false; }
        return;
      }
      if (files.length > 1 || types[0].kind === 'image' || (boxId === null && !['pdf', 'docx', 'csv'].includes(types[0].kind))) {
        throw new Error(files.length > 1 ? 'Choose one document at a time.' :
          boxId ? 'That file is a screenshot. Choose it in the screenshot picker or paste its text.' : 'Choose a PDF, Word, or CSV file.');
      }
    } catch (error) {
      input.value = '';
      message(error.message || 'That file type cannot be read. Paste the text instead.');
    }
    remove.hidden = !input.files.length;
  });
}
$('paste-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const form = new FormData(event.currentTarget);
    const resumeFile = $('resume-file').files[0];
    const jdFile = $('jd-file').files[0];
    const resumeParsed = await fileText(resumeFile);
    const jdParsed = await fileText(jdFile);
    const input = { jobLabel: form.get('jobLabel'), resume: resumeParsed?.text ?? form.get('resume'),
      jd: jdParsed?.text ?? form.get('jd'), resumeOffsets: resumeParsed?.pageOffsets ?? [],
      jdOffsets: jdParsed?.pageOffsets ?? [], resumeSection: resumeParsed?.sectionLabel,
      jdSection: jdParsed?.sectionLabel };
    const result = await resolveJob(await api('paste', input));
    await uploadOriginal(resumeFile, result.resume.source.id, resumeParsed?.mimeType, resumeParsed?.text);
    await uploadOriginal(jdFile, result.jd.source.id, jdParsed?.mimeType, jdParsed?.text);
    workspaceId = result.workspace.id;
    sessionStorage.setItem('interview-coach-workspace', workspaceId);
    renderLedger(result.facts);
    if (guest) sessionStorage.removeItem(guestDraftKey);
    if (result.resume.dropped.length || result.jd.dropped.length) message('Some model quotes did not exactly match the source and were dropped.');
  });
});
$('open-workspaces').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('open-workspaces-ledger').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('empty-workspace-add').addEventListener('click', () => show('paste'));
$('refresh-map').addEventListener('click', (event) => run(event.currentTarget, async () => {
  mapFailed.delete(workspaceId);
  await resolveJob(await api('workspace_map', { workspaceId }));
  await renderWorkspaces();
}));
$('workspace-ledger').addEventListener('click', () => api('ledger', { workspaceId }).then(renderLedger).catch((error) => message(error.message)));
$('new-workspace').addEventListener('click', () => show('paste'));
$('workspace-settings').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('workspace_settings', { workspaceId,
      remotePreference: $('remote-preference').value,
      listingWorkMode: $('listing-work-mode').value,
      roleTitle: $('role-title').value, companyName: $('company-name').value });
    message('Workspace settings saved.');
  });
});
$('hunt-status').addEventListener('change', () => {
  if (['applied', 'interviewing'].includes($('hunt-status').value) && !$('hunt-applied-on').value) $('hunt-applied-on').value = new Date().toISOString().slice(0, 10);
});
$('job-hunt-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const result = await api('job_hunt_update', { workspaceId, status: $('hunt-status').value,
      appliedOn: $('hunt-applied-on').value || null, nextStep: $('hunt-next-step').value,
      nextStepOn: $('hunt-next-step-on').value || null, postingLink: $('hunt-posting-link').value,
      notes: $('hunt-notes').value, happenedOn: $('hunt-happened-on').value || undefined,
      note: $('hunt-log-note').value });
    $('hunt-log-note').value = '';
    await renderWorkspaces();
    if (result.promptInterviewDate) message('You marked this job as interviewing. Add the interview date when you have it.');
    else message('Job tracker saved.');
  });
});
$('job-hunt-log-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('job_hunt_log', { workspaceId, action: $('hunt-log-action').value,
      happenedOn: $('hunt-log-happened-on').value || undefined });
    $('hunt-log-action').value = ''; await renderWorkspaces();
  });
});
$('download-job-hunt').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([jobHuntCsv(hubWorkspaces)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'my-job-hunt.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
$('job-comparison-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('workspace_settings', { workspaceId,
      remotePreference: $('remote-preference').value, listingWorkMode: $('listing-work-mode').value,
      payDetails: $('pay-details').value.trim(), benefitsDetails: $('benefits-details').value.trim(),
      learnedDetails: $('learned-details').value.trim() });
    await renderWorkspaces();
    message('Job details saved.');
  });
});
$('open-library').addEventListener('click', () => {
  show('library');
  renderCoachNotes().catch(() => {});
  renderSamples().catch((error) => message(error.message));
});
$('back-ledger').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('library-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const form = new FormData(event.currentTarget);
    const file = $('library-file').files[0];
    const parsed = await fileText(file);
    const result = await resolveJob(await api('ingest', {
      kind: form.get('kind'), title: form.get('title'), text: parsed?.text ?? form.get('text'),
      pageOffsets: parsed?.pageOffsets ?? [], sectionLabel: parsed?.sectionLabel, workspaceId,
    }));
    await uploadOriginal(file, result.source.id, parsed?.mimeType, parsed?.text);
    if (result.workspace) workspaceId = result.workspace.id;
    sessionStorage.setItem('interview-coach-workspace', workspaceId);
    renderLedger(await api('ledger', { workspaceId }));
  });
});
$('sample-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  run(event.submitter, async () => {
    const form = new FormData(formElement);
    await api('writing_sample', { title: form.get('title'), text: form.get('text') });
    formElement.reset();
    await renderSamples();
  });
});
$('style-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('writing_profile', { preferences: $('style-preferences').value });
    await renderSamples();
  });
});
$('start-interview').addEventListener('click', (event) => {
  // Starting writes a new interview and asks the AI for the first question, so ask first
  // (the voice call does too). The "use text instead" fallback already got a yes.
  const button = event.currentTarget;
  const skipConfirm = button.dataset.skipConfirm === '1';
  delete button.dataset.skipConfirm;
  if (!skipConfirm && !window.confirm('Start a typed practice interview? The interviewer asks your first question right away, and the AI works on every answer you send. Choose Cancel to go back.')) return;
  startTypedInterview(button);
});
function startTypedInterview(button) { return run(button, async () => {
  const startNavigation = navigationVersion;
  const result = await api('start', { workspaceId, persona: $('persona').value,
    difficulty: Number($('difficulty').value), practiceMode: $('practice-mode').value });
  if (navigationVersion !== startNavigation) return;
  interviewId = result.interview.id;
  sessionStorage.setItem('interview-coach-interview', interviewId);
  interviewCache()?.clear(interviewId);
  $('transcript').replaceChildren();
  $('between-answer-coaching').replaceChildren();
  $('interview-heading').textContent = $('practice-mode').value === 'coach' ? 'Coach mode' : 'Mock interview';
  showInterviewFocus(null);
  $('answer-form').hidden = false;
  $('voice-transcript-tools').hidden = true;
  addTurn('Interviewer', result.question);
  show('interview');
}, 'Starting your typed interview. This can take up to 30 seconds…'); }

function voiceState(text) { $('voice-state').textContent = text; }
function stopVoice() {
  clearTimeout(voiceTimer);
  if (voiceClient) {
    try { voiceClient.stopCall(); } catch { /* Already disconnected. */ }
    voiceClient = null;
  }
  $('stop-voice').hidden = true;
  $('voice-review').hidden = false;
  voiceState('Call ended. The transcript and debrief may take a moment. You can review them here.');
}

$('start-voice').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const limit = `up to ${guest ? guestVoiceLimits?.maxMinutes ?? 5 : 30} minutes`;
  const privacy = guest ? ' Retell keeps a copy for one day.' : '';
  if (!window.confirm(`Start a live voice mock interview? This uses a paid call for ${limit}.${privacy} Choose Cancel to use text practice.`)) return;
  const voiceEpoch = sessionEpoch;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    message('Microphone access was denied or unavailable. Text practice is ready below.');
    return;
  } finally { stream?.getTracks().forEach((track) => track.stop()); }
  if (voiceEpoch !== sessionEpoch) return;
  const { RetellWebClient } = await import('/vendor/retell-client.js');
  if (voiceEpoch !== sessionEpoch) return;
  const result = await api('voice_start', { workspaceId, persona: $('persona').value,
    difficulty: Number($('difficulty').value), practiceMode: $('practice-mode').value,
    ...($('plain-voice').checked ? { plainEnglish: true } : {}) });
  interviewId = result.interviewId;
  sessionStorage.setItem('interview-coach-interview', interviewId);
  showInterviewFocus(null);
  // Guests get a short-lived token to fetch their own transcript; nothing is stored server-side.
  guestVoice = guest ? { callId: result.callId, guestToken: result.guestToken } : null;
  voiceClient = new RetellWebClient();
  voiceClient.on('call_started', () => voiceState('Connected. Your interviewer is listening.'));
  voiceClient.on('call_ended', stopVoice);
  voiceClient.on('error', (error) => {
    stopVoice();
    voiceState(/permission|denied|notallowed/i.test(error?.message || '')
      ? 'Microphone access was denied. You can use text practice.'
      : 'Voice disconnected. Review the transcript when it arrives, or use text practice.');
  });
  $('stop-voice').hidden = false;
  $('voice-review').hidden = true;
  voiceState('Connecting to the interviewer…');
  show('voice-interview');
  voiceTimer = setTimeout(stopVoice, result.maxMinutes * 60_000);
  try { await voiceClient.startCall({ callId: result.callId, accessToken: result.accessToken,
    transport: result.transport, iceServers: result.iceServers }); }
  catch (error) {
    stopVoice();
    voiceState(/permission|denied|notallowed/i.test(error?.message || '')
      ? 'Microphone access was denied. You can use text practice.'
      : 'Could not connect. You can use text practice.');
  }
}));
$('confirm-all').addEventListener('click', (event) => {
  const ids = JSON.parse(event.currentTarget.dataset.ids || '[]');
  if (ids.length) reviewMany(event.currentTarget, ids, 'confirm');
});
$('stop-voice').addEventListener('click', stopVoice);
$('voice-text-fallback').addEventListener('click', () => {
  stopVoice();
  $('start-interview').dataset.skipConfirm = '1';
  $('start-interview').click();
});
$('voice-review').addEventListener('click', (event) => run(event.currentTarget, async () => {
  if (guest) {
    if (!guestVoice) { voiceState('Start a voice call first.'); return; }
    const guestStatus = await api('voice_status', { interviewId, ...guestVoice });
    if (guestStatus.status === 'active') { voiceState('The call is still wrapping up. Try again in a moment.'); return; }
    if (!guestStatus.report) { voiceState('The call ended before you answered. Try again, or use text practice.'); return; }
    renderDebrief(guestStatus.report);
    return;
  }
  const status = await api('voice_status', { interviewId });
  if (!status.transcriptReady) { voiceState('Transcript is still processing. Try again shortly.'); return; }
  interviewCache()?.markFinished(interviewId);
  if (status.job?.status === 'failed') {
    const retried = await api('retry_job', { jobId: status.job.id });
    await resolveJob({ job: retried });
    message('Transcript processing retried. Review the new details before relying on the debrief.');
  }
  if (status.job?.status === 'queued') {
    // A webhook can save the transcript but lose its background handoff. This is the same
    // signed-in job trigger used elsewhere, and gives the existing review button a real retry.
    await fetch('/.netlify/functions/model-job-background', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-coach-csrf': '1' },
      body: JSON.stringify({ jobId: status.job.id }) });
    voiceState('Transcript processing is starting. Try review again in a moment.');
  }
  $('transcript').replaceChildren();
  for (const turn of status.turns) addTurn(turn.speaker === 'candidate' ? 'You' : 'Interviewer', turn.text);
  $('answer-form').hidden = true;
  $('voice-transcript-tools').hidden = false;
  const candidates = status.turns.filter((turn) => turn.speaker === 'candidate');
  voiceCandidateTurns = candidates;
  $('voice-turn-select').replaceChildren(...candidates.map((turn, index) => {
    const option = document.createElement('option');
    option.value = turn.id;
    option.textContent = `Answer ${index + 1}`;
    return option;
  }));
  $('voice-correction').value = candidates[0]?.text ?? '';
  $('see-debrief').hidden = !status.debriefReady;
  $('view-saved-debrief').hidden = !status.debriefReady;
  $('interview-heading').textContent = 'Voice transcript';
  show('interview');
}));
$('voice-turn-select').addEventListener('change', () => {
  $('voice-correction').value = voiceCandidateTurns.find((turn) => turn.id === $('voice-turn-select').value)?.text ?? '';
});
$('save-voice-correction').addEventListener('click', (event) => run(event.currentTarget, async () => {
  await resolveJob(await api('voice_correct', { interviewId, turnId: $('voice-turn-select').value,
    text: $('voice-correction').value }));
  message('Correction saved. Review its new details before using the new debrief.');
  $('voice-review').click();
}));
$('voice-debrief').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const stored = await api('history', { interviewId });
  if (!stored) throw new Error('Debrief is still processing. Try again shortly.');
  renderDebrief({ contentScores: stored.content_scores_json, deliveryScores: stored.delivery_scores_json,
    unassessed: stored.unassessed_json, feedback: stored.feedback_json,
    unsupportedClaims: stored.unsupported_claims_json, factGate: stored.fact_gate_json,
    factGateUnavailable: stored.fact_gate_unavailable ?? false,
    rewrite: stored.rewrite, stronger: await api('stronger_draft', { interviewId }) });
}));
$('open-dig').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const result = await api('dig_start', { workspaceId });
  digId = result.dig.id;
  $('dig-prompt').replaceChildren(plain.plainSpan(result.prompt, 'question'));
  $('dig-playback').hidden = true;
  $('dig-scene').value = '';
  show('story-dig');
}));
$('dig-scene-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const result = await api('dig_reflect', { digId, scene: $('dig-scene').value });
    $('dig-reflection').replaceChildren(plain.plainSpan(result.reflection, 'coaching'));
    $('dig-correction').value = result.scene_text;
    $('dig-playback').hidden = false;
  });
});
$('dig-confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const result = await api('dig_confirm', { digId, scene: $('dig-correction').value });
    renderLedger(result.facts);
    message('Your story added new details. Confirm the ones you want to use.');
  });
});
$('dig-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('dig-speak').addEventListener('click', () => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { message('Speech input is unavailable in this browser. Type the scene instead.'); return; }
  const recognition = new Recognition();
  speechInput?.abort();
  speechInput = recognition;
  const speechEpoch = sessionEpoch;
  recognition.lang = document.documentElement.lang || 'en-US';
  recognition.onresult = (event) => { if (speechEpoch !== sessionEpoch) return; $('dig-scene').value += `${$('dig-scene').value ? ' ' : ''}${event.results[0][0].transcript}`; };
  recognition.onerror = () => message('Speech input stopped. You can type or try again.');
  recognition.start();
});
$('interview-date-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('interview_date', { workspaceId, date: $('interview-date').value ? new Date($('interview-date').value).toISOString() : null });
    message('Interview date saved.');
  });
});
async function renderDrills(result = null, { autoBuild = false } = {}) {
  result ??= await api('drills', { workspaceId });
  if (autoBuild && !result.cards.length) {
    $('progress-note').textContent = 'Making your cards from the details you confirmed…';
    $('progress-note').hidden = false;
    try { result = await api('drill_build', { workspaceId }); }
    finally { $('progress-note').hidden = true; }
  }
  const countdown = result.hoursUntilInterview === null ? '' :
    ` Interview in ${result.hoursUntilInterview} hours.`;
  $('drill-mode').textContent = (result.cram ? 'Review all cards before your interview.' :
    'Cards return on their scheduled review date.') + countdown;
  $('drill-gaps').textContent = result.gaps.length ?
    `Still missing a story for: ${result.gaps.join('; ')}` : '';
  const list = $('drill-list');
  list.replaceChildren();
  if (!result.cards.length) list.append(node('p',
    'You\'re caught up. Nothing is due right now. Your next review date will appear when you review a card.'));
  // Five at a time keeps it a five-minute session instead of a wall of cards.
  const batch = result.cards.slice(0, 5);
  if (result.cards.length > batch.length) {
    list.append(node('p', `${batch.length} cards for this round. ${result.cards.length - batch.length} more are waiting after these.`, 'meta'));
  }
  for (const card of batch) {
    const form = node('form', '', 'practice-card');
    form.append(node('span', card.kind === 'intro' ? 'Introduction' : 'Story details', 'chip'));
    form.append(node('h2', card.kind === 'intro' ? `Your ${card.targetSeconds}-second introduction` : 'Bring this story back.'));
    form.append(node('p', `Next review: ${reviewDate(card.due)}`, 'meta'));
    form.append(plain.plainNode('p', card.prompt, 'drill'));
    const flip = node('button', 'Flip to practice ↻', 'secondary');
    flip.type = 'button';
    flip.setAttribute('aria-expanded', 'false');
    const back = node('div', '');
    back.hidden = true;
    const label = node('label', 'Say it in your own words');
    const answer = document.createElement('textarea');
    answer.rows = 5; answer.maxLength = 4000; answer.required = true;
    answer.setAttribute('aria-label', 'Your answer to this practice prompt');
    label.append(answer);
    const submit = node('button', 'Check what I remembered');
    submit.type = 'submit';
    back.append(label, submit);
    flip.addEventListener('click', () => {
      back.hidden = !back.hidden;
      flip.setAttribute('aria-expanded', String(!back.hidden));
      flip.textContent = back.hidden ? 'Flip to practice ↻' : 'Back to prompt ↻';
      form.classList.remove('is-flipped');
      requestAnimationFrame(() => form.classList.add('is-flipped'));
      if (!back.hidden) answer.focus();
    });
    form.append(flip, back);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(submit, async () => {
        const graded = await api('drill_review', { cardId: card.id, answer: answer.value });
        form.classList.add('is-practiced');
        form.querySelector('.chip').textContent = 'Review complete';
        back.replaceChildren(node('h3', `${graded.hitIds.length} details recalled · ${graded.missedIds.length} to revisit`),
          plain.plainNode('p', graded.note, 'coaching'));
        back.append(node('p', `Next review: ${reviewDate(graded.due)}`, 'meta'));
        const next = node('button', 'Continue with due cards');
        next.type = 'button';
        next.addEventListener('click', () => run(next, () => renderDrills()));
        back.append(next);
        flip.hidden = true;
        celebrate(`Review saved. This card is due again ${reviewDate(graded.due)}.`, form);
        next.focus();
      });
    });
    list.append(form);
  }
  show('drills');
}
function openPractice() {
  if (!workspaceId) { show('paste'); return; }
  show('practice');
}
function openDrills() {
  $('drill-list').replaceChildren();
  show('drills');
  return renderDrills(null, { autoBuild: true }).catch((error) => message(error.message));
}
$('ledger-practice').addEventListener('click', openPractice);
$('debrief-again').addEventListener('click', openPractice);
$('debrief-hub').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('interview-quit').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('practice-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
for (const card of document.querySelectorAll('.persona-card')) {
  card.addEventListener('click', () => {
    $('persona').value = card.dataset.persona;
    for (const other of document.querySelectorAll('.persona-card')) other.setAttribute('aria-checked', String(other === card));
  });
}
$('persona').addEventListener('change', () => {
  for (const card of document.querySelectorAll('.persona-card')) card.setAttribute('aria-checked', String(card.dataset.persona === $('persona').value));
});
$('build-drills').addEventListener('click', (event) => run(event.currentTarget, async () =>
  renderDrills(await api('drill_build', { workspaceId, refresh: true }))));
$('drill-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
function renderRealFeed(feed) {
  const target = $('real-feed');
  target.replaceChildren(node('h2', 'What we learned'));
  target.append(node('p', feed.prediction.asked ?
    `We saw ${feed.prediction.matched} of the ${feed.prediction.asked} questions they asked coming in your practice.` :
    'Nothing saved yet. Add what they asked above.'));
  if (feed.drillPriorities.length) target.append(node('p', `Practice next: ${feed.drillPriorities.join('; ')}`));
  if (feed.digTargets.length) target.append(node('p', `Stories worth telling us more about: ${feed.digTargets.join('; ')}`));
  for (const capture of feed.captures) {
    target.append(node('h3', `What they asked (${({ notes: 'your notes', transcript: 'transcript', voice: 'voice note' })[capture.capture_kind] ?? capture.capture_kind})`));
    for (const question of capture.questions_json) target.append(node('p', question));
    const remove = node('button', 'Delete this one', 'secondary');
    remove.addEventListener('click', () => {
      if (!confirm('Delete this real-interview capture and its recovery cards?')) return;
      run(remove, async () => {
        await api('delete_source', { workspaceId, sourceId: capture.source_id });
        renderRealFeed(await api('real_feed', { workspaceId }));
      });
    });
    target.append(remove);
  }
  show('real-capture');
}
$('open-real-capture').addEventListener('click', () => api('real_feed', { workspaceId })
  .then(renderRealFeed).catch((error) => message(error.message)));
$('real-capture-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const result = await api('real_capture', { workspaceId,
      captureKind: $('capture-kind').value, text: $('capture-text').value });
    $('capture-text').value = '';
    renderRealFeed(result.feed);
  });
});
let voiceRecorder = null;
let voiceStopTimer = null;
let voiceCaptureStream = null;
let speechInput = null;
function cancelSessionMedia() {
  clearTimeout(voiceStopTimer);
  if (voiceRecorder) {
    voiceRecorder.onstop = null;
    if (voiceRecorder.state === 'recording') voiceRecorder.stop();
    voiceRecorder = null;
  }
  voiceCaptureStream?.getTracks().forEach((track) => track.stop());
  voiceCaptureStream = null;
  if (speechInput) { speechInput.onresult = null; speechInput.abort(); speechInput = null; }
  if (voiceClient) stopVoice();
  guestVoice = null;
  $('capture-speak').textContent = 'Record voice note';
}

$('capture-speak').addEventListener('click', async () => {
  if (voiceRecorder?.state === 'recording') {
    clearTimeout(voiceStopTimer);
    voiceRecorder.stop();
    $('capture-speak').textContent = 'Record voice note';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    message('Recording is unavailable in this browser. Type or paste a note instead.');
    return;
  }
  const captureEpoch = sessionEpoch;
  const captureWorkspace = workspaceId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (captureEpoch !== sessionEpoch) { stream.getTracks().forEach((track) => track.stop()); return; }
    voiceCaptureStream = stream;
    const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg']
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { stream.getTracks().forEach((track) => track.stop()); throw new Error('No supported audio format.'); }
    const chunks = [];
    voiceRecorder = new MediaRecorder(stream, { mimeType });
    voiceRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    voiceRecorder.onstop = async () => {
      clearTimeout(voiceStopTimer);
      $('capture-speak').textContent = 'Record voice note';
      stream.getTracks().forEach((track) => track.stop());
      voiceCaptureStream = null;
      if (captureEpoch !== sessionEpoch || captureWorkspace !== workspaceId) return;
      const audio = new Blob(chunks, { type: mimeType });
      if (audio.size > 2000000) { message('Voice note is over 2 MB. Record a shorter note.'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          if (captureEpoch !== sessionEpoch || captureWorkspace !== workspaceId) return;
          const base64 = String(reader.result).split(',')[1];
          const result = await api('transcribe_voice', { workspaceId: captureWorkspace, base64, mimeType });
          if (captureEpoch !== sessionEpoch || captureWorkspace !== workspaceId) return;
          $('capture-kind').value = 'voice';
          $('capture-text').value = result.text;
          message('Transcription ready. Review and edit it before saving.');
        } catch (error) { message(error.message); }
      };
      reader.readAsDataURL(audio);
    };
    voiceRecorder.start();
    voiceStopTimer = setTimeout(() => {
      if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
    }, 5 * 60 * 1000);
    $('capture-speak').textContent = 'Stop recording';
    message('Recording. Stop when finished, then review the transcript.');
  } catch (error) { message(error.message); }
});
$('real-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('answer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const answer = $('answer').value;
    const result = await api('turn', { interviewId, answer });
    addTurn('You', answer);
    if (result.coaching) {
      const coach = node('p', 'Coach: ');
      coach.append(plain.plainSpan(result.coaching, 'coaching'));
      $('between-answer-coaching').replaceChildren(coach);
    }
    $('answer').value = '';
    if (guest) sessionStorage.removeItem(guestAnswerKey);
    if (result.done) {
      interviewCache()?.markFinished(interviewId);
      let completed = null;
      try { completed = await resolveJob(result); }
      catch { message('Your interview is finished. Saving new fact suggestions paused; the debrief can still continue.'); }
      // Stays up until the debrief screen replaces it, so the empty answer box never looks frozen.
      clearTimeout(progressTimer);
      $('progress-note').textContent = 'That\'s the whole interview. Building your debrief, about 20 seconds…';
      $('progress-note').hidden = false;
      $('answer-form').hidden = true;
      try { renderDebrief(await resolveJob(await api('debrief', { interviewId }))); }
      catch (error) { renderSelfDebrief(error); }
      const newDetails = (completed?.facts ?? []).filter((fact) => fact.review_state === 'pending' && fact.lifecycle === 'active').length;
      if (newDetails) message(`You mentioned ${newDetails} new detail${newDetails === 1 ? '' : 's'}. Tap "Check new details" to add them to your bank.`);
    } else reveal(addTurn('Interviewer', result.question)); // the next question comes into view on a phone
  });
});
$('skip-question').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const result = await api('turn', { interviewId, skip: true });
  addTurn('You', 'Skipped for now. I\'ll come back to it.');
  $('between-answer-coaching').replaceChildren();
  if (guest) sessionStorage.removeItem(guestAnswerKey);
  if (result.done) { message('That was the last question. Tap "See my debrief" to finish.'); return; }
  reveal(addTurn('Interviewer', result.question));
}));
$('see-debrief').addEventListener('click', (event) => run(event.currentTarget, async () => {
  try { renderDebrief(await resolveJob(await api('debrief', { interviewId }))); }
  catch (error) { renderSelfDebrief(error); }
}));
$('view-saved-debrief').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const stored = await api('history', { interviewId });
  if (!stored) throw new Error('No debrief saved yet. Generate one first.');
  const report = stored.report ?? {
    contentScores: stored.content_scores_json, deliveryScores: stored.delivery_scores_json,
    unassessed: stored.unassessed_json, feedback: stored.feedback_json,
    unsupportedClaims: stored.unsupported_claims_json, factGate: stored.fact_gate_json,
    factGateUnavailable: stored.fact_gate_unavailable ?? false,
    rewrite: stored.rewrite_status === 'invalidated' ?
      { ready: false, missingDetailQuestion: 'The evidence changed. Regenerate the debrief.', claims: [] } : stored.rewrite,
  };
  report.stronger = await api('stronger_draft', { interviewId });
  renderDebrief(report);
}));
$('review-proposals').addEventListener('click', async () => renderLedger(await api('ledger', { workspaceId })));

const savedGuest = readGuestState(sessionStorage, guestKey);
if (savedGuest) {
  guest = true;
  state = savedGuest;
  identity();
  restoreGuestDrafts();
  if (restoreCachedInterview()) { /* Keep the session in its current room after refresh. */ }
  else if (workspaceId && state.workspaces?.some((item) => item.id === workspaceId && item.public_summary)) openWorkspaceHub().catch(() => show('paste'));
  else if (workspaceId) api('ledger', { workspaceId }).then(renderLedger).catch(() => show('paste'));
  else show('paste');
  // A returning guest still needs to know whether voice is on.
  fetch('/api?op=session', { credentials: 'same-origin' }).then((response) => response.json())
    .then(applySessionDetails).catch(() => {});
} else {
  fetch('/api?op=session', { credentials: 'same-origin' }).then((response) => response.json()).then((body) => {
    if (guest) {
      applySessionDetails(body);
      return;
    }
    currentUser = body.user;
    applySessionDetails(body);
    if (currentUser && pendingJob) resumeJob().catch((error) => message(error.message));
    else if (currentUser && restoreCachedInterview()) { /* Restore an active practice room. */ }
    else if (currentUser && workspaceId) api('ledger', { workspaceId }).then(renderLedger).catch(() => show('paste'));
    else show(currentUser ? 'paste' : (initialPublicPanel ?? 'landing'));
  }).catch(() => { if (!guest) show(initialPublicPanel ?? 'landing'); });
}


// Job hub: big plain-language tiles that route to each tool.
for (const tile of document.querySelectorAll('.hub-tile')) {
  tile.addEventListener('click', () => {
    const target = tile.dataset.go;
    const destinations = { 'hub-writer': 'writing', 'hub-prep': 'prep', 'hub-drills': 'drills', 'hub-practice': 'practice', 'workspace-ledger': 'facts', 'open-real-capture': 'review', 'open-immerser': 'immerser' };
    go(destinations[target] ?? target);
  });
}

let activeWriterKind = null;
const writerDraftKey = (kind) => `interview-coach-writer:${workspaceId}:${kind}`;
const writerLatestKey = () => `interview-coach-writer-latest:${workspaceId}`;
function readWriterDraft(kind) {
  try { return JSON.parse(localStorage.getItem(writerDraftKey(kind)) || 'null'); }
  catch { return null; }
}
function writeWriterDraft() {
  if (!activeWriterKind) return;
  const current = readWriterDraft(activeWriterKind) ?? {};
  const draft = {
    ...current,
    text: $('writer-text').value,
    font: $('writer-font').value,
    color: $('writer-color').value,
  };
  try {
    localStorage.setItem(writerDraftKey(activeWriterKind), JSON.stringify(draft));
    localStorage.setItem(writerLatestKey(), activeWriterKind);
    $('writer-save-state').textContent = 'Saved in this browser for this job.';
  } catch {
    $('writer-save-state').textContent = 'Could not save locally. Keep this tab open and download your draft.';
  }
  refreshWriterPreview();
}
function refreshWriterPreview() {
  if (!$('writer-text')) return;
  const text = $('writer-text').value;
  $('writer-preview-text').textContent = text;
  $('writer-preview').dataset.font = $('writer-font').value;
  $('writer-preview').dataset.color = $('writer-color').value;
  $('writer-copy').dataset.text = text;
}
function safeWriterDoc(doc) {
  return {
    kind: doc.kind,
    text: String(doc.text ?? ''),
    flagged: Number(doc.flagged) || 0,
    gaps: Array.isArray(doc.gaps) ? doc.gaps.slice(0, 10).map(String) : [],
    sections: Array.isArray(doc.sections) ? doc.sections.map((section) => ({
      heading: String(section.heading ?? ''),
      lines: Array.isArray(section.lines) ? section.lines.map((line) => ({ text: String(line.text ?? ''), check: line.check ? String(line.check) : null })) : [],
    })) : [],
  };
}
function renderDocument(rawDoc, { restore = false } = {}) {
  const doc = safeWriterDoc(rawDoc);
  const out = $('writer-output');
  out.replaceChildren();
  if (doc.flagged) out.append(node('p', `${doc.flagged} line${doc.flagged === 1 ? '' : 's'} need a look before you use this. They're marked below. These checks refer to the generated wording.`, 'note'));
  for (const section of doc.sections) {
    const block = node('section', '', 'doc-section');
    block.append(node('h2', section.heading));
    for (const line of section.lines) {
      const row = node('div', '', line.check ? 'doc-line flagged' : 'doc-line');
      row.append(node('p', line.text));
      if (line.check) row.append(node('p', line.check, 'meta'));
      block.append(row);
    }
    out.append(block);
  }
  if (doc.gaps.length) {
    out.append(node('h2', 'What the job asks for that you haven\'t confirmed yet'));
    const list = document.createElement('ul');
    for (const gap of doc.gaps) { const item = document.createElement('li'); item.append(plain.plainSpan(gap, 'debrief')); list.append(item); }
    out.append(list, node('p', 'Add these to your story bank if they\'re true, then write it again.', 'meta'));
  }
  activeWriterKind = doc.kind;
  const saved = restore ? readWriterDraft(doc.kind) : null;
  const edit = saved?.text != null ? saved : null;
  $('writer-editor').hidden = false;
  $('writer-text').value = edit ? String(edit.text) : doc.text;
  $('writer-font').value = edit && ['Noto Sans', 'Noto Serif', 'Noto Sans Mono'].includes(edit.font) ? edit.font : 'Noto Sans';
  $('writer-color').value = edit && ['teal', 'navy', 'plum', 'slate'].includes(edit.color) ? edit.color : 'teal';
  $('writer-save-state').textContent = edit ? 'Your saved edits are restored for this job.' : 'Edits save here as you type.';
  try {
    if (!edit) localStorage.setItem(writerDraftKey(doc.kind), JSON.stringify({ ...doc, font: 'Noto Sans', color: 'teal' }));
    localStorage.setItem(writerLatestKey(), doc.kind);
  } catch { /* The draft remains editable for this tab if storage is unavailable. */ }
  refreshWriterPreview();
  observeGlassReveals(out);
  reveal(out);
  $('writer-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function restoreWriterDraft() {
  activeWriterKind = null;
  $('writer-output').replaceChildren();
  $('writer-editor').hidden = true;
  if (!workspaceId) return;
  let kind = null;
  try { kind = localStorage.getItem(writerLatestKey()); } catch { return; }
  if (!['resume', 'cover_letter'].includes(kind)) return;
  const saved = readWriterDraft(kind);
  if (saved?.kind) renderDocument(saved, { restore: true });
}
for (const [id, kind] of [['write-resume', 'resume'], ['write-cover', 'cover_letter']]) {
  $(id).addEventListener('click', (event) => {
    const existing = readWriterDraft(kind);
    if (existing?.text && !confirm('You have an editable draft for this job. Replace it with a newly generated draft?')) return;
    try { localStorage.removeItem(writerDraftKey(kind)); } catch { /* Continue in memory. */ }
    run(event.currentTarget, async () => {
      message('Writing from your confirmed facts. This takes about 20 seconds.');
      renderDocument(await resolveJob(await api('write_document', { workspaceId, kind,
        lane: kind === 'resume' ? $('writer-lane').value : undefined })));
      message('');
    });
  });
}
$('writer-text').addEventListener('input', writeWriterDraft);
for (const id of ['writer-font', 'writer-color']) $(id).addEventListener('change', writeWriterDraft);
$('writer-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('writer-text').value); message('Copied.'); }
  catch { message('Copy did not work here. Select the text and copy it.'); }
});
$('writer-export-docx').addEventListener('click', async (event) => run(event.currentTarget, async () => {
  const kind = activeWriterKind;
  const blob = await createDocx($('writer-text').value, { font: $('writer-font').value, color: $('writer-color').value, title: kind === 'cover_letter' ? 'Cover letter' : 'Résumé' });
  downloadBytes(blob, documentFilename(kind, 'docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  message('Word document downloaded.');
}));
$('writer-export-pdf').addEventListener('click', async (event) => run(event.currentTarget, async () => {
  const kind = activeWriterKind;
  const bytes = await createPdf($('writer-text').value, { font: $('writer-font').value, color: $('writer-color').value, title: kind === 'cover_letter' ? 'Cover letter' : 'Résumé' });
  downloadBytes(bytes, documentFilename(kind, 'pdf'), 'application/pdf');
  message('PDF downloaded.');
}));
$('writer-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));

$('prep-back').addEventListener('click', () => openWorkspaceHub().catch((error) => message(error.message)));
$('prep-export').addEventListener('click', async (event) => run(event.currentTarget, async () => {
  const text = prepPackText(currentPrepSections);
  if (!text) throw new Error('Wait for at least one section before downloading.');
  const blob = await createDocx(text, { title: 'Interview Prep Pack' });
  downloadBytes(blob, 'interview-coach-prep-pack.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  message('Prep Pack downloaded.');
}));


// Upload a real interview file: transcripts are read in the browser; short audio is transcribed.
$('capture-file').addEventListener('change', async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const fileEpoch = sessionEpoch;
  const fileWorkspace = workspaceId;
  const currentFileContext = () => fileEpoch === sessionEpoch && fileWorkspace === workspaceId;
  try {
    if (file.type.startsWith('audio/')) {
      if (file.size > 2000000) { message('That recording is over 2 MB. Upload its transcript instead, or record a short voice note.'); return; }
      message('Transcribing your recording…');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      if (!currentFileContext()) return;
      const result = await api('transcribe_voice', { workspaceId: fileWorkspace, base64, mimeType: file.type });
      if (!currentFileContext()) return;
      $('capture-kind').value = 'voice';
      $('capture-text').value = result.text;
    } else if (/\.(txt|vtt|srt)$/i.test(file.name)) {
      const text = (await file.text()).replace(/^\d+\s*$|^[\d:.,]+\s*-->.*$/gm, '').replace(/^WEBVTT.*$/m, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!currentFileContext()) return;
      $('capture-kind').value = 'transcript';
      $('capture-text').value = text.slice(0, 12000);
    } else {
      const parsed = await extractDocument(file);
      if (!currentFileContext()) return;
      $('capture-kind').value = 'transcript';
      $('capture-text').value = String(parsed.text ?? '').slice(0, 12000);
    }
    message('Loaded. Look it over, then Save and analyze.');
  } catch (error) { message(error.message || 'Could not read that file. Paste the text instead.'); }
});


// Opening a collapsed section brings its contents into view on small screens.
document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.open) return;
  const rect = details.getBoundingClientRect();
  if (rect.bottom > window.innerHeight || rect.top < 0) reveal(details, 'start');
}, true);


// Count a number up when it lands (the debrief headline). Respects reduced motion.
function countUp(element, target, suffix = '') {
  if (!element) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { element.textContent = `${target}${suffix}`; return; }
  countUpTarget = { element, value: target, suffix };
  const start = performance.now();
  const step = (now) => {
    if (document.hidden) return;
    const t = Math.min(1, (now - start) / 700);
    element.textContent = `${Math.round(target * (1 - Math.pow(1 - t, 3)))}${suffix}`;
    if (t < 1) countUpFrame = requestAnimationFrame(step);
    else { countUpFrame = undefined; countUpTarget = null; }
  };
  cancelAnimationFrame(countUpFrame);
  countUpFrame = requestAnimationFrame(step);
}

$('auth-guest-link')?.addEventListener('click', (event) => { event.preventDefault(); $('try-guest').click(); });

let publicProfileRequest = null;
function publicProfile() {
  publicProfileRequest ??= fetch('/sample-profile.json', { credentials: 'omit' }).then((response) => {
    if (!response.ok) throw new Error("The sample didn't load. Try again.");
    return response.json();
  }).catch((error) => { publicProfileRequest = null; throw error; });
  return publicProfileRequest;
}
async function practiceRole() {
  if (currentUser) {
    await openWorkspaceHub();
    message("You're signed in. Your own saved jobs and career facts stay in your account. End your session to open the practice workspace.");
    return;
  }
  // Don't replace a visitor's own imported work when they explore the public story.
  if (guest && (state.sources?.length || state.workspaces?.length) && !state.workspaces?.some((item) => item.public_summary)) {
    await openWorkspaceHub();
    message("Your guest work is still here. End this session before opening the practice workspace.");
    return;
  }
  const profile = await publicProfile();
  const example = createSampleGuest(profile);
  interviewCache()?.clearNamespace();
  guest = true; state = example.state; forgetWorkspace(); workspaceId = example.workspaceId;
  sessionStorage.setItem(guestKey, JSON.stringify(state));
  sessionStorage.setItem('interview-coach-workspace', workspaceId);
  sessionStorage.removeItem(guestDraftKey); sessionStorage.removeItem(guestAnswerKey);
  currentWorkspace = null; identity();
  await openWorkspaceHub();
}
$('try-sample').addEventListener('click', (event) => run(event.currentTarget, () => practiceRole()));
for (const button of document.querySelectorAll('[data-sample-demo]')) button.addEventListener('click', () => run(button, () => practiceRole()));
