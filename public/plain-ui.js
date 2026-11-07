// Plain English in the browser: a "Say it plain" button on every AI-written message, and a
// global switch that shows the plain version everywhere. Off by default. The person's own
// answers are never wrapped, so they are never changed.
import { decodeTerms } from './plain-decoder.js';

export const PLAIN_SETTING_KEY = 'interview-coach-plain-english';
const CACHE_PREFIX = 'interview-coach-plain:';
const QUESTION_KINDS = new Set(['question', 'followup', 'drill']);

async function digest(text) {
  try {
    const bytes = new TextEncoder().encode(text);
    const hashed = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    let value = 2166136261; // FNV-1a, only when Web Crypto is missing
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619) >>> 0;
    }
    return `f${value.toString(16)}-${text.length}`;
  }
}

export function createPlainEnglish({ fetchPlain, doc = document, session = null, local = null } = {}) {
  const sessionStore = session ?? (() => { try { return window.sessionStorage; } catch { return null; } })();
  const localStore = local ?? (() => { try { return window.localStorage; } catch { return null; } })();
  let on = false;
  try { on = localStore?.getItem(PLAIN_SETTING_KEY) === 'on'; } catch { /* Off when storage is blocked. */ }
  const entries = new Set();
  const memory = new Map();
  const listeners = new Set();

  // At most two translations in flight, so turning the switch on over a long debrief
  // doesn't fire a dozen requests at once.
  const waiting = [];
  let active = 0;
  function enqueue(task) {
    return new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < 2 && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      task().then(resolve, reject).finally(() => { active -= 1; pump(); });
    }
  }

  async function translate(text, kind) {
    const id = `${kind}:${await digest(text)}`;
    if (memory.has(id)) return memory.get(id);
    try {
      const saved = sessionStore?.getItem(CACHE_PREFIX + id);
      if (saved) { const value = JSON.parse(saved); memory.set(id, value); return value; }
    } catch { /* Fetch again. */ }
    const pending = enqueue(() => fetchPlain(text, kind)).then((result) => {
      // Only a real translation is kept; a fallback is retried next time.
      if (result?.source === 'model' || result?.source === 'cache') {
        try { sessionStore?.setItem(CACHE_PREFIX + id, JSON.stringify(result)); } catch { /* Memory only. */ }
      } else memory.delete(id);
      return result;
    }).catch(() => {
      memory.delete(id);
      return { text: null, glossary: decodeTerms(text), source: 'decoder', degraded: 'offline' };
    });
    memory.set(id, pending);
    return pending;
  }

  function el(tag, className, text = '') {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function hintsFor(glossary) {
    if (!glossary?.length) return '';
    return `Words to know: ${glossary.map((item) => `“${item.term}” means ${item.plain}.`).join(' ')}`;
  }

  async function render(entry, mode) {
    entry.mode = mode;
    entry.wrap.dataset.mode = mode;
    const { body, hints, badge, button } = entry;
    if (mode === 'original') {
      entry.ticket += 1;
      body.textContent = entry.text;
      hints.textContent = ''; hints.hidden = true; badge.hidden = true;
      button.textContent = 'Say it plain';
      button.setAttribute('aria-pressed', 'false');
      button.disabled = false; button.removeAttribute('aria-busy');
      return;
    }
    const ticket = ++entry.ticket;
    button.setAttribute('aria-pressed', 'true');
    if (!entry.result) {
      // Instant hints from the word list while the plain version loads.
      const instant = hintsFor(decodeTerms(entry.text));
      hints.textContent = instant; hints.hidden = !instant;
      button.textContent = 'Making it plain…';
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      const result = await translate(entry.text, entry.kind);
      if (ticket !== entry.ticket) return; // switched back while it loaded
      entry.result = result;
    }
    const result = entry.result;
    button.disabled = false; button.removeAttribute('aria-busy');
    button.textContent = 'Show original';
    body.textContent = (result.text || entry.text).replace(/^\s*in plain words\s*:\s*/i, '');
    badge.textContent = result.source === 'decoder' ? 'Plain English, saved wording' : 'Plain English';
    badge.hidden = !(result.text && !QUESTION_KINDS.has(entry.kind));
    const hint = hintsFor(result.glossary);
    hints.textContent = hint || (result.text ? '' : 'This one is already in plain words.');
    hints.hidden = !hints.textContent;
  }

  // An inline wrapper safe to put inside a <p>, <li>, <h3>, or <div>.
  function plainSpan(text, kind) {
    const wrap = el('span', 'plainable');
    wrap.dataset.kind = kind;
    const badge = el('span', 'plain-badge', 'Plain English');
    badge.hidden = true;
    const body = el('span', 'plain-text', text);
    body.setAttribute('aria-live', 'polite');
    const hints = el('span', 'plain-hints');
    hints.hidden = true;
    const button = el('button', 'secondary plain-btn', 'Say it plain');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    wrap.append(badge, body, hints, button);
    const entry = { wrap, body, hints, badge, button, text: String(text ?? ''), kind,
      mode: 'original', result: null, ticket: 0 };
    button.addEventListener('click', () => {
      render(entry, entry.mode === 'plain' ? 'original' : 'plain').catch(() => {});
    });
    if (entries.size > 300) for (const old of entries) if (!old.wrap.isConnected) entries.delete(old);
    entries.add(entry);
    if (on) render(entry, 'plain').catch(() => {});
    return wrap;
  }

  function plainNode(tag, text, kind, className) {
    const element = el(tag, className);
    element.append(plainSpan(text, kind));
    return element;
  }

  function setOn(value) {
    on = Boolean(value);
    try { localStore?.setItem(PLAIN_SETTING_KEY, on ? 'on' : 'off'); } catch { /* This tab only. */ }
    for (const entry of [...entries]) {
      if (!entry.wrap.isConnected) { entries.delete(entry); continue; }
      render(entry, on ? 'plain' : 'original').catch(() => {});
    }
    for (const listener of listeners) listener(on);
  }

  return { plainSpan, plainNode, setOn, isOn: () => on, onChange: (fn) => listeners.add(fn), translate };
}

// The header switch.
export function bindPlainToggle(button, plain) {
  const paint = (value) => {
    button.setAttribute('aria-checked', String(value));
    button.textContent = `Plain English: ${value ? 'On' : 'Off'}`;
    button.classList.toggle('is-on', value);
  };
  paint(plain.isOn());
  button.addEventListener('click', () => plain.setOn(!plain.isOn()));
  plain.onChange(paint);
}
