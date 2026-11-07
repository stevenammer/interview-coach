// "Say it plain": turns one piece of AI-written text into plain English.
// The model only proposes wording. Code decides whether it may be shown: every name and
// number survives, nothing gets harsher, strengths stay first, the next step stays, and a
// question is still one plain question. Anything that fails falls back to the rules-only
// decoder, which never invents and always has something helpful to show.
// Style rules: docs/PLAIN_ENGLISH_VOICE.md.
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decodePlain, DECODER_TERMS } from '../public/plain-decoder.js';
import { isText } from './model.js';

export const PLAIN_KINDS = Object.freeze(['question', 'followup', 'coaching', 'debrief', 'drill', 'scenario']);
export const PLAIN_MAX_INPUT = 5000;
const QUESTION_KINDS = new Set(['question', 'followup', 'drill']);
const PREFIX = 'In plain words:';

export const PLAIN_VOICE_RULES = [
  'Write like a warm, direct friend explaining it across a kitchen table. Talk to one person: "you".',
  'Short sentences. Everyday words. Contractions always (you\'re, don\'t, it\'s).',
  'No corporate words or buzzwords. If a work term can\'t be avoided, keep it and explain it in a few words in parentheses.',
  'Explain the why with an everyday comparison only when it makes it clearer, and only when it adds no new facts.',
  'Never talk down. Assume the reader is smart and just hasn\'t heard it said this way.',
  'Never use em dashes or en dashes. Use commas, periods, or parentheses.',
  'Keep every name, number, date, place, company, and fact exactly as written. Add no new facts, numbers, or names.',
  'Do not make it much longer. Plain is usually shorter.',
  'Warm and kind, never judgmental. Nothing may sound harsher than the original.',
].join('\n');

const KIND_RULES = {
  question: `This is an interview question. Start with "${PREFIX}" and then ask it the way a friendly person would, as ONE plain question that ends with a question mark. Keep what they're really asking for.`,
  followup: `This is an interviewer's follow-up question. Start with "${PREFIX}" and then ask it the way a friendly person would, as ONE plain question that ends with a question mark.`,
  drill: `This is a practice prompt. Start with "${PREFIX}" and then say what to practice in a friendly, plain way. Keep any number of seconds exactly.`,
  coaching: 'This is coaching for the person. Keep every strength first, in the same order. Keep the next step. Never turn a positive into a negative and never add a criticism.',
  debrief: 'This is debrief feedback on a practice answer. Keep every strength first, in the same order. Keep the next step. Never turn a positive into a negative and never add a criticism. Keep any score words as they are.',
  scenario: 'This is a scene from a practice "week in the job". Keep who, what, and when. Say plainly what is going on and what they are being asked to decide.',
};

export function plainPrompt(text, kind, standingInstructions = '') {
  return `Rewrite the text below in plain English.\n${PLAIN_VOICE_RULES}\n${KIND_RULES[kind]}\n` +
    `${standingInstructions ? `${standingInstructions}\n` : ''}` +
    'Return JSON {"plain":"..."} and nothing else.\n' +
    `Text:\n${text}`;
}

export const plainSchema = (value) => value && isText(value.plain, 4000);

// ---- Guardrails, all deterministic -------------------------------------------------
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
function numbers(text) {
  const found = [...String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => match[0].replaceAll(',', ''));
  for (const match of String(text).toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const index = NUMBER_WORDS.indexOf(match[0]);
    // "one" is too often a pronoun ("the one thing") to count as a number.
    if (index > 1) found.push(String(index));
  }
  return found;
}

// The no-model fallback changes only known work terms. It keeps names, numbers, and every
// other piece of source wording in place, so it is useful even when a full rewrite is unsafe.
function decoderRewrite(text) {
  let rewritten = String(text ?? '');
  for (const entry of DECODER_TERMS) {
    const flags = entry.pattern.flags.includes('i') ? 'gi' : 'g';
    rewritten = rewritten.replace(new RegExp(entry.pattern.source, flags), entry.plain);
  }
  return rewritten;
}

const ACRONYM_TERMS = new Set(DECODER_TERMS.filter((entry) => entry.term === entry.term.toUpperCase())
  .map((entry) => entry.term.replace(/[^A-Z&]/g, '')));
// Capitalized words that are not the first word of a sentence: names, places, companies.
function namedWords(text) {
  const words = [];
  const pattern = /[\p{L}\p{N}][\p{L}\p{N}&'.-]*/gu;
  for (const match of String(text).matchAll(pattern)) {
    const word = match[0].replace(/[.'-]+$/, '');
    if (!/^\p{Lu}/u.test(word) || word === 'I' || /^I['’]/.test(word)) continue;
    const raw = String(text).slice(0, match.index);
    if (/(?:^|\n)[\s"'“”‘’(\[\-•*]*$/u.test(raw)) continue; // first word of the text or of a line
    const before = raw.replace(/[\s"'“”‘’(\[\-•*]+$/u, '');
    if (!before || /[.!?:;]$/.test(before)) continue;
    words.push(word);
  }
  return words;
}

const HARSH = /\b(?:fail(?:ed|ure|ures|s|ing)?|poor(?:ly)?|weak(?:ness|nesses|er|est)?|lack(?:ed|ing|s)?|bad(?:ly)?|wrong|mistakes?|avoid(?:ed|ing|s)?|deflect(?:ed|ing|s)?|evasive|vague|unclear|missed|didn['’]?t|did not|never|nobody|no one|problems?|struggl\w*|confus\w*|rambl\w*|unprofessional|terrible|awful|shouldn['’]?t|should|must|need(?:s|ed)? to|have to|has to|only|lazy|careless|sloppy|inadequate|insufficient)\b/gi;
const POSITIVE = /\b(?:well|good|great|strong(?:er|est)?|solid|clear(?:ly)?|nice|worked|works|landed|helped|helpful|specific|smart|thoughtful|confident|real|right|best|nailed|showed|shows|did)\b/i;
const NEXT_STEP = /\b(?:next time|next step|try|practice|add|name|lead with|start with|open with|you could|you can|consider|aim|keep|bring|say|mention|tell|share|use)\b/i;
const harshCount = (text) => (String(text).match(HARSH) ?? []).length;
const sentences = (text) => String(text).split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);

export function cleanPlain(text) {
  return String(text ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+--\s+/g, ', ')
    .replace(/\s+/g, ' ').trim().replace(/^["“]+|["”]+$/g, '').replace(/,\s*,/g, ',').trim();
}

const bodyOf = (text) => text.startsWith(PREFIX) ? text.slice(PREFIX.length).trim() : text;

export function checkPlain(original, candidate, kind) {
  const source = String(original ?? '');
  let text = cleanPlain(candidate);
  if (!text) return { ok: false, reason: 'empty' };
  if (QUESTION_KINDS.has(kind)) {
    if (/^in plain words\s*:/i.test(text)) text = `${PREFIX}${text.replace(/^in plain words\s*:/i, '')}`;
    else text = `${PREFIX} ${text}`;
  } else if (/^in plain words\s*:/i.test(text)) text = text.replace(/^in plain words\s*:\s*/i, '');
  const body = bodyOf(text);
  if (body.length < 2) return { ok: false, reason: 'empty' };
  if (body.length > Math.max(source.length * 1.6 + 40, 120)) return { ok: false, reason: 'too_long' };

  const originalNumbers = numbers(source);
  const plainNumbers = numbers(body);
  if (originalNumbers.some((number) => !plainNumbers.includes(number))) return { ok: false, reason: 'number_dropped' };
  if (plainNumbers.some((number) => !originalNumbers.includes(number))) return { ok: false, reason: 'number_added' };

  const lowerSource = source.toLowerCase();
  for (const word of namedWords(source)) {
    if (ACRONYM_TERMS.has(word.replace(/[^A-Z&]/g, '')) && word === word.toUpperCase()) continue;
    if (!body.includes(word)) return { ok: false, reason: 'name_dropped', word };
  }
  for (const word of namedWords(body)) {
    if (!lowerSource.includes(word.toLowerCase())) return { ok: false, reason: 'name_added', word };
  }

  if (harshCount(body) > harshCount(source)) return { ok: false, reason: 'harsher' };
  if (QUESTION_KINDS.has(kind) && kind !== 'drill') {
    if (source.includes('?') && !body.trim().endsWith('?')) return { ok: false, reason: 'not_a_question' };
    const asked = (body.match(/\?/g) ?? []).length;
    if (asked > Math.max(1, (source.match(/\?/g) ?? []).length)) return { ok: false, reason: 'stacked_questions' };
  }
  if (kind === 'coaching' || kind === 'debrief') {
    const first = sentences(source)[0] ?? '';
    const plainFirst = sentences(body)[0] ?? '';
    if (POSITIVE.test(first) && harshCount(first) === 0 &&
      (!POSITIVE.test(plainFirst) || harshCount(plainFirst) > 0)) return { ok: false, reason: 'strength_not_first' };
    // Sentence by sentence: the plain version never piles more harsh words into one sentence
    // than the harshest sentence of the original had.
    const worst = Math.max(0, ...sentences(source).map(harshCount));
    if (sentences(body).some((sentence) => harshCount(sentence) > worst)) return { ok: false, reason: 'harsher' };
    if (NEXT_STEP.test(source) && !NEXT_STEP.test(body)) return { ok: false, reason: 'next_step_dropped' };
  }
  return { ok: true, text };
}

// ---- Cache --------------------------------------------------------------------------
// Keyed by an HMAC of the exact text, and sealed with a key derived from that same text,
// so a stored entry can only be read by someone who already has the original wording.
export function plainCacheKey(text, kind, secret = '') {
  return createHmac('sha256', `plain-cache-v1:${secret}`).update(`${kind}\n${text}`).digest('hex');
}
function sealKey(text, kind) {
  return createHash('sha256').update(`plain-seal-v1\n${kind}\n${text}`).digest();
}
export function sealPlain(value, text, kind) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(text, kind), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...value, writtenAt: Date.now() }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function openPlain(sealed, text, kind) {
  try {
    const raw = Buffer.from(String(sealed), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', sealKey(text, kind), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { return null; }
}

const withTimeout = (promise, ms) => Promise.race([promise,
  new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.(); })]);

export async function cachedPlain(cache, text, kind, secret) {
  if (!cache) return null;
  try {
    const sealed = await withTimeout(cache.get(plainCacheKey(text, kind, secret)), 1500);
    const key = plainCacheKey(text, kind, secret);
    const value = sealed ? openPlain(sealed, text, kind) : null;
    if (value && (!Number.isFinite(value.writtenAt) || Date.now() - value.writtenAt > 7 * 24 * 60 * 60 * 1000)) {
      await withTimeout(Promise.resolve(cache.delete?.(key)).catch(() => null), 1500);
      return null;
    }
    return value && typeof value.text === 'string' ? { ...value, source: 'cache' } : null;
  } catch { return null; }
}

// One translation. Model first (fast lane), guardrails in code, decoder if anything fails.
export async function translatePlain({ text, kind, model, cache = null, secret = '', allowModel = true,
  standingInstructions = '', owner = null }) {
  const fallback = () => {
    const decoded = decodePlain(text, kind);
    return { ...decoded, text: decoded.text ?? (decoded.glossary.length ? decoderRewrite(text) : null) };
  };
  if (!allowModel || !model) return { ...fallback(), degraded: !allowModel ? 'capped' : 'no_model' };
  try {
    const response = await model.generate(`plain_${kind}`, plainPrompt(text, kind, standingInstructions), plainSchema,
      { preferFast: true, timeoutMs: 9000, ...(owner ? { owner } : {}) });
    const checked = checkPlain(text, response.data.plain, kind);
    if (!checked.ok) {
      // A structurally valid answer can still lose a name or number. Give the model one
      // concrete repair instruction before using the deterministic, source-preserving fallback.
      const repaired = await model.generate(`plain_${kind}`, `${plainPrompt(text, kind, standingInstructions)}\n\n` +
        `Your first wording was rejected because it ${checked.reason.replaceAll('_', ' ')}. Keep every source name and number exactly.`,
      plainSchema, { preferFast: true, timeoutMs: 9000, ...(owner ? { owner } : {}) });
      const retry = checkPlain(text, repaired.data.plain, kind);
      if (retry.ok) {
        const result = { text: retry.text, glossary: [], source: 'model' };
        if (cache) await withTimeout(Promise.resolve(cache.set(plainCacheKey(text, kind, secret), sealPlain(result, text, kind)))
          .catch(() => null), 1500);
        return result;
      }
      return { ...fallback(), degraded: retry.reason };
    }
    const result = { text: checked.text, glossary: [], source: 'model' };
    if (cache) {
      await withTimeout(Promise.resolve(cache.set(plainCacheKey(text, kind, secret), sealPlain(result, text, kind)))
        .catch(() => null), 1500);
    }
    return result;
  } catch (error) {
    return { ...fallback(), degraded: error?.code ?? 'model_error' };
  }
}

// Voice: the questions handed to the Retell agent, already in plain words. A question that
// can't be translated safely in time stays exactly as written.
export const PLAIN_INTERVIEWER_INSTRUCTION = 'PLAIN ENGLISH INTERVIEWER IS ON for this call. ' +
  'Use short, everyday words. Ask one short question at a time. No buzzwords or corporate jargon. ' +
  'If you have to use a work term, explain it in a few words. Keep a warm, patient tone and never rush: ' +
  'give them all the time they need. The planned questions are already in plain words, so ask them that way.';

export async function plainQuestionPlan(plan, model, { timeoutMs = 7000 } = {}) {
  const translated = await withTimeout(Promise.all(plan.map(async (question) => {
    const result = await translatePlain({ text: question, kind: 'question', model });
    return result.source === 'model' && result.text ? bodyOf(result.text) : question;
  })), timeoutMs);
  return translated ?? plan;
}
