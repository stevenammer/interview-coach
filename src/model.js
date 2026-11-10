import { randomUUID } from 'node:crypto';
import { perUserDailyCapMicros } from './repository.js';

// Vertex AI when VERTEX_API_KEY is set;
// Netlify deployments require Vertex. Local tools may use the Gemini Developer API.
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const VERTEX_ENDPOINT = 'https://aiplatform.googleapis.com/v1/publishers/google/models';
export function providerFor(env) {
  if (env.VERTEX_API_KEY || env.REQUIRE_VERTEX === 'true' || env.NETLIFY === 'true' || env.CONTEXT === 'production') {
    return { endpoint: VERTEX_ENDPOINT, key: env.VERTEX_API_KEY };
  }
  return { endpoint: GEMINI_ENDPOINT, key: env.GEMINI_API_KEY };
}
// Model names change often; check your provider's current list. Defaults:
// 3.8-flash (newest Flash), 3.5-flash-lite (only 3.x Lite), 3.1-pro-preview (only 3.x Pro).
// gemini-2.5-flash-lite is retired for new users (404).
export const MODEL_CONFIG = Object.freeze({
  primary: 'gemini-3.8-flash',
  fallback: 'gemini-3.5-flash-lite',
  minimumReservationUsd: 0.25,
  maximumUsdPerAttempt: 0.25, // legacy minimum reservation, not a provider billing cap
  maxInputBytes: 4_000_000,
  maxOutputTokens: 8192,
  thinkingBudget: 0,
  timeoutMs: 25000,
});
// USD per million tokens used by the spend guard, not provider invoices.
// Standard global Flash 3.6–3.8 introductory rates end December 31, 2026.
// Lite is conservatively reserved at the heavy Flash rate until reconciled.
export const PRICE_PER_MILLION_USD = Object.freeze({
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash-lite': { input: 0.75, output: 3.75 },
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
});

// 2.5 models take a token budget (0 = off); 3.x models take a level and reject budget 0 on
// some variants. Thinking tokens count against maxOutputTokens either way.
export function thinkingConfigFor(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: MODEL_CONFIG.thinkingBudget };
}

export function usageMicros(model, usage, at = Date.now()) {
  const price = PRICE_PER_MILLION_USD[model];
  const input = usage?.promptTokenCount;
  const candidate = usage?.candidatesTokenCount;
  if (!price || !Number.isFinite(input) || !Number.isFinite(candidate)) return null;
  const thought = Number.isFinite(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount :
    Math.max(0, (usage.totalTokenCount ?? 0) - input - candidate);
  if (input < 0 || candidate < 0 || thought < 0) return null;
  const factor = /^gemini-3\.(?:[678]-flash|5-flash-lite)$/.test(model)
    && Number(at) >= Date.UTC(2027, 0, 1) ? 2 : 1;
  return Math.ceil((input * price.input + (candidate + thought) * price.output) * factor);
}

export class ModelOutputError extends Error {
  constructor(task) {
    super(`Invalid ${task} model output after one repair attempt`);
    this.code = 'invalid_model_output';
  }
}

export function parseStructured(raw, validate) {
  try {
    const value = JSON.parse(raw);
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

// The per-account share must be sized to this call, not to a 30 minute voice call, or a low
// daily cap would let one account spend all of it.
export const modelUserCapMicros = (capMicros, micros) => perUserDailyCapMicros(capMicros, micros);

export class GeminiAdapter {
  constructor({ repo, fetchImpl = fetch, env = process.env } = {}) {
    this.repo = repo;
    this.fetch = fetchImpl;
    this.env = env;
  }

  forGuest(guestSubject) {
    return {
      generate: (task, prompt, validate, options = {}) => this.generate(task, prompt, validate, { ...options, guestSubject }),
      transcribe: (base64, mimeType, options = {}) => this.transcribe(base64, mimeType, { ...options, guestSubject }),
      readImage: (base64, mimeType, options = {}) => this.readImage(base64, mimeType, { ...options, guestSubject }),
    };
  }

  // options.preferFast tries the lighter model first (short rewrites like "Say it plain");
  // options.passes: 1 skips the repair pass; options.timeoutMs shortens each attempt.
  async generate(task, prompt, validate, options = {}) {
    const models = [this.env.GEMINI_MODEL_PRIMARY || MODEL_CONFIG.primary,
      this.env.GEMINI_MODEL_FALLBACK || MODEL_CONFIG.fallback];
    if (options.preferFast) models.reverse();
    const passes = options.passes === 1 ? 1 : 2;
    if (task === 'followup') prompt += '\nReturn one JSON object with a nonempty question string of at most 350 characters. No other fields are needed.';
    let lastError;
    for (let pass = 0; pass < passes; pass += 1) {
      const request = pass === 0 ? prompt : `${prompt}\n\nYour previous response was invalid. Return only JSON matching the requested shape, no markdown.`;
      for (const model of models) {
        try {
          const result = await this.call(model, task, request, null, options.timeoutMs, options.owner ?? null, options);
          const parsed = parseStructured(result.text, validate);
          if (parsed) return { data: parsed, modelId: model };
          // Shape only, never content: enough to tell a cut-off reply from a schema miss in the function logs.
          try {
            const raw = JSON.parse(result.text);
            console.error('[model] invalid output', task, model, JSON.stringify({ reason: 'schema', keyCount: Object.keys(raw ?? {}).length,
              sections: Array.isArray(raw?.sections) ? raw.sections.map((section) => ({ heading: typeof section?.heading, lines: Array.isArray(section?.lines) ? section.lines.length : null,
                badLine: Array.isArray(section?.lines) ? section.lines.filter((line) => typeof line?.text !== 'string').length : null })).slice(0, 12) : null }));
          } catch { console.error('[model] invalid output', task, model, JSON.stringify({ reason: 'json', length: String(result.text ?? '').length, tail: String(result.text ?? '').slice(-1) })); }
          lastError = new ModelOutputError(task);
          break; // malformed output gets one repair call, not a model switch
        } catch (error) {
          if (['spend_cap_reached', 'accounting_unavailable', 'model_pricing_unavailable', 'model_input_too_large'].includes(error.code)) throw error;
          lastError = error;
          if (!error.retryable) break;
        }
      }
      if (lastError instanceof ModelOutputError && pass === passes - 1) throw lastError;
      if (!(lastError instanceof ModelOutputError)) break;
    }
    const error = new Error('Model provider unavailable. Your inputs are still in this browser; retry shortly.');
    error.code = 'model_unavailable';
    error.retryable = true;
    error.cause = lastError;
    throw error;
  }

  async transcribe(base64, mimeType, options = {}) {
    if (typeof options === 'string') options = { owner: options };
    if (typeof base64 !== 'string' || base64.length > 2800000 ||
      !['audio/webm', 'audio/mp4', 'audio/ogg'].includes(mimeType)) {
      throw new Error('Unsupported or oversized audio note');
    }
    const models = [this.env.GEMINI_MODEL_PRIMARY || MODEL_CONFIG.primary,
      this.env.GEMINI_MODEL_FALLBACK || MODEL_CONFIG.fallback];
    for (const model of models) {
      try {
        const result = await this.call(model, 'transcribe_voice',
          'Transcribe this interview voice note faithfully. Return JSON {"text":"..."}. Do not infer words you cannot hear.',
          { mimeType, data: base64 }, MODEL_CONFIG.timeoutMs, options.owner ?? null, options);
        const data = parseStructured(result.text, (value) => value && isText(value.text, 12000));
        if (data) return data.text;
      } catch (error) {
        if (['spend_cap_reached', 'accounting_unavailable', 'model_pricing_unavailable', 'model_input_too_large'].includes(error.code)) throw error;
        if (!error.retryable) break;
      }
    }
    throw new ModelOutputError('transcribe_voice');
  }

  async readImage(base64, mimeType, options = {}) {
    if (typeof options === 'string') options = { owner: options };
    if (typeof base64 !== 'string' || base64.length > 2800000 ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      throw new Error('Unsupported or oversized image');
    }
    const models = [this.env.GEMINI_MODEL_PRIMARY || MODEL_CONFIG.primary,
      this.env.GEMINI_MODEL_FALLBACK || MODEL_CONFIG.fallback];
    for (const model of models) {
      try {
        const result = await this.call(model, 'read_image',
          'This is a screenshot or photo of a job posting or a resume. Copy all of its text exactly as written, in reading order, keeping headings and bullets on their own lines. Leave out app chrome like buttons, menus, and ads. Do not summarize, fix, or add anything. If there is no readable text, return an empty string. Return JSON {"text":"..."}.',
          { mimeType, data: base64 }, MODEL_CONFIG.timeoutMs, options.owner ?? null, options);
        const data = parseStructured(result.text, (value) => value && typeof value.text === 'string' && value.text.length <= 12000);
        if (data) return data.text.trim();
      } catch (error) {
        if (['spend_cap_reached', 'accounting_unavailable', 'model_pricing_unavailable', 'model_input_too_large'].includes(error.code)) throw error;
        if (!error.retryable) break;
      }
    }
    throw new ModelOutputError('read_image');
  }

  async call(model, task, prompt, inlineAudio = null, timeoutMs = MODEL_CONFIG.timeoutMs, owner = null, options = {}) {
    const provider = providerFor(this.env);
    if (!provider.key) {
      const error = new Error(provider.endpoint === VERTEX_ENDPOINT ?
        'Vertex is unavailable: configure VERTEX_API_KEY. Your saved work is unchanged.' :
        'VERTEX_API_KEY or GEMINI_API_KEY must be configured');
      error.code = 'model_unavailable';
      throw error;
    }
    const cap = this.env.DAILY_USD_CAP === undefined ? 5 : Number(this.env.DAILY_USD_CAP);
    if (!Number.isFinite(cap) || cap <= 0) {
      const error = new Error('Spend cap is invalid');
      error.code = 'spend_cap_reached';
      throw error;
    }
    const requestBody = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt },
        ...(inlineAudio ? [{ inlineData: inlineAudio }] : [])] }],
      generationConfig: {
        responseMimeType: 'application/json', maxOutputTokens: MODEL_CONFIG.maxOutputTokens,
        thinkingConfig: thinkingConfigFor(model),
      },
    });
    const inputBytes = Buffer.byteLength(requestBody, 'utf8');
    if (inputBytes > MODEL_CONFIG.maxInputBytes) {
      const error = new Error('Model input is too large. Use a shorter document or fewer facts.');
      error.code = 'model_input_too_large';
      throw error;
    }
    // A byte-per-token upper estimate intentionally over-reserves multimodal data.
    // Reserve output/thought tokens up to maxOutputTokens, then reconcile actual usage.
    const estimate = usageMicros(model, { promptTokenCount: inputBytes,
      candidatesTokenCount: MODEL_CONFIG.maxOutputTokens, thoughtsTokenCount: 0 });
    if (estimate === null) {
      const error = new Error('Model pricing is not configured. Choose a model with a reviewed rate in PRICE_PER_MILLION_USD.');
      error.code = 'model_pricing_unavailable';
      throw error;
    }
    const micros = Math.max(Math.ceil(MODEL_CONFIG.minimumReservationUsd * 1e6), estimate);
    let reservation;
    try {
      const capMicros = Math.floor(cap * 1e6);
      const userCapMicros = owner ? modelUserCapMicros(capMicros, micros) : null;
      const fraction = this.env.GUEST_BUDGET_FRACTION === undefined ? 0.4 : Number(this.env.GUEST_BUDGET_FRACTION);
      const ipCap = this.env.GUEST_IP_DAILY_USD === undefined ? 3 : Number(this.env.GUEST_IP_DAILY_USD);
      if (options.guestSubject && (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 ||
          !Number.isFinite(ipCap) || ipCap < 0)) throw new Error('Invalid guest spend limits');
      const guestOptions = options.guestSubject && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 &&
        Number.isFinite(ipCap) && ipCap >= 0 ? { guestBudgetMicros: Math.floor(capMicros * fraction),
          guestSubject: options.guestSubject, guestSubjectCapMicros: Math.floor(ipCap * 1e6) } : {};
      reservation = await this.repo.reserve(task, micros, capMicros, randomUUID(), new Date(), owner, userCapMicros, guestOptions);
    } catch {
      const error = new Error('Spend accounting is unavailable');
      error.code = 'accounting_unavailable';
      throw error;
    }
    if (!reservation) {
      const error = new Error('Daily model spend cap reached');
      error.code = 'spend_cap_reached';
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || MODEL_CONFIG.timeoutMs);
    let settled = false;
    const settle = async (actual) => {
      if (settled) return;
      settled = true;
      // If accounting is down, retain the conservative reservation.
      await this.repo.settle(reservation, actual).catch(() => {});
    };
    try {
      const response = await this.fetch(`${provider.endpoint}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': provider.key },
        body: requestBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        // Only a definitive client rejection establishes a no-charge outcome.
        // A timeout or server error may arrive after work started, so keep that hold.
        if (response.status >= 400 && response.status < 500 && response.status !== 408) await settle(0);
        // Provider error bodies can echo submitted source text or credentials.
        const error = new Error(`Gemini request failed (${response.status})`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const body = await response.json();
      const actual = usageMicros(model, body.usageMetadata);
      // A 2xx reply is definitive even if its content is unusable. Settle before validating it.
      await settle(actual ?? micros);
      const result = body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
      if (!result) throw new Error('Gemini returned no JSON');
      return { text: result };
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        await settle(micros);
        error.retryable = true;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const isText = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const isFactProposal = (item) => item && isText(item.subject, 120) &&
  isText(item.predicate, 120) && isText(item.quote, 500);
// Models return value as an object, a string, a number, or omit it. Normalize rather than
// reject the whole batch; the verbatim quote is what gets verified against the source.
export const normalizeValue = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (value === undefined || value === null) return {};
  return { text: Array.isArray(value) ? value.join(', ') : String(value) };
};
export const extractionSchema = (v) => v && Array.isArray(v.facts) && v.facts.length <= 60 &&
  v.facts.every(isFactProposal);
export const questionsSchema = (v) => v && Array.isArray(v.questions) && v.questions.length >= 3 &&
  v.questions.length <= 6 && v.questions.every((q) => isText(q, 700));
export const followUpSchema = (v) => v && isText(v.question, 350);
export const coachSchema = (v) => v && isText(v.coaching, 600);
export const digSchema = (v) => v && isText(v.reflection, 1800) &&
  v.reflection.includes('Did I get that right?');
export const drillGradeSchema = (v) => v && Array.isArray(v.hitIds) && Array.isArray(v.missedIds) &&
  v.hitIds.length <= 12 && v.missedIds.length <= 12 &&
  [...v.hitIds, ...v.missedIds].every((id) => isText(id, 100)) && isText(v.note, 200);
export const feedbackSchema = (v) => v && isText(v.feedback, 5000);
export const storyTitleSchema = (v) => v && isText(v.title, 140);
export const realCaptureSchema = (v) => v && Array.isArray(v.questions) && v.questions.length <= 30 &&
  v.questions.every((q) => isText(q, 500)) && Array.isArray(v.storyFactIds) &&
  v.storyFactIds.length <= 20 && v.storyFactIds.every((id) => isText(id, 100)) &&
  Array.isArray(v.stumped) && v.stumped.length <= 20 && v.stumped.every((q) => isText(q, 500)) &&
  Array.isArray(v.matchedQuestionIndices) && v.matchedQuestionIndices.length <= 30 &&
  v.matchedQuestionIndices.every((n) => Number.isInteger(n) && n >= 0 && n < 30);
export const factGateSchema = (v) => v && Array.isArray(v.items) && v.items.length <= 12 &&
  v.items.every((item) => item && ['under_claim', 'gap', 'over_claim'].includes(item.lane) &&
    isText(item.answerQuote, 500) && isText(item.note, 500) &&
    Array.isArray(item.factIds) && item.factIds.length <= 4 &&
    item.factIds.every((factId) => isText(factId, 100)));
export const requirementsSchema = (v) => v && Array.isArray(v.requirements) &&
  v.requirements.length <= 40 && v.requirements.every((item) => item &&
    isText(item.quote, 700) && ['must', 'preferred', 'responsibility'].includes(item.type) &&
    isText(item.competency, 120) && isText(item.evidenceNeeded, 400) &&
    ['direct', 'adjacent', 'none'].includes(item.category) &&
    isText(item.rationale, 600) && Array.isArray(item.factIds) && item.factIds.length <= 5 &&
    item.factIds.every((id) => isText(id, 100)));
export const scoresSchema = (v) => {
  const content = ['relevance', 'ownership', 'evidence', 'outcome', 'structure'];
  const delivery = ['clarity', 'concision'];
  const valid = (entry) => entry && Number.isInteger(entry.score) && entry.score >= 1 && entry.score <= 5 &&
    isText(entry.reason, 1500);
  // Scores and feedback must be well formed. Rewrite claims only need to be an array:
  // malformed individual claims are rejected one by one by the truth gate, not here,
  // so one sloppy claim can't throw away an otherwise valid debrief.
  return v && content.every((key) => valid(v.contentScores?.[key])) &&
    delivery.every((key) => valid(v.deliveryScores?.[key])) &&
    isText(v.feedback, 5000) && Array.isArray(v.unsupportedClaims) &&
    v.unsupportedClaims.length <= 40 && v.unsupportedClaims.every((c) => isText(c, 1000)) &&
    Array.isArray(v.rewriteClaims) && v.rewriteClaims.length <= 30 &&
    (v.strongerNeeds === undefined || (Array.isArray(v.strongerNeeds) && v.strongerNeeds.length <= 6 &&
      v.strongerNeeds.every((need) => isText(need, 100) && !/[\[\]<>]/.test(need))));
};
