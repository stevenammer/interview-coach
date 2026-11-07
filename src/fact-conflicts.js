import { createHash } from 'node:crypto';

const normalizeText = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US')
  .replace(/[\s_-]+/g, ' ').trim();

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [normalizeText(key), normalizeValue(value[key])]));
  }
  return typeof value === 'string' ? normalizeText(value) : value;
}

function stable(value) {
  return JSON.stringify(normalizeValue(value));
}

export function normalizedFactContent(fact) {
  return {
    id: fact.id,
    subject: normalizeText(fact.subject),
    predicate: normalizeText(fact.predicate),
    value: normalizeValue(fact.value_json ?? fact.value),
    qualifiers: normalizeValue(fact.qualifiers_json ?? fact.qualifiers ?? {}),
    quote: normalizeText(fact.verbatim_quote ?? fact.quote ?? fact.display_text),
    sourceId: fact.source_id ?? fact.sourceId ?? null,
  };
}

export function factPairFingerprint(first, second) {
  const pair = [normalizedFactContent(first), normalizedFactContent(second)].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(pair)).digest('hex');
}

function eligible(fact) {
  return fact?.domain !== 'job' && fact?.lifecycle !== 'superseded' && fact?.review_state !== 'rejected' &&
    normalizeText(fact.subject) && normalizeText(fact.predicate);
}

function sameClaimScope(a, b) {
  const left = a.qualifiers_json ?? a.qualifiers ?? {};
  const right = b.qualifiers_json ?? b.qualifiers ?? {};
  const leftScope = normalizeText(left.claim_scope);
  const rightScope = normalizeText(right.claim_scope);
  if (!leftScope || leftScope !== rightScope) return false;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key === 'claim_scope' || left[key] === undefined || right[key] === undefined) continue;
    if (stable(left[key]) !== stable(right[key])) return false;
  }
  return true;
}

function sameWorkspace(a, b) {
  return (a.workspace_id ?? a.workspaceId ?? null) === (b.workspace_id ?? b.workspaceId ?? null);
}

export function detectPotentialFactConflicts(facts) {
  const candidates = (Array.isArray(facts) ? facts : []).filter(eligible);
  const pairs = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (!sameWorkspace(a, b) || normalizeText(a.subject) !== normalizeText(b.subject) ||
        normalizeText(a.predicate) !== normalizeText(b.predicate) || !sameClaimScope(a, b) ||
        stable(a.value_json ?? a.value) === stable(b.value_json ?? b.value)) continue;
      const [left, right] = a.id.localeCompare(b.id) <= 0 ? [a, b] : [b, a];
      pairs.push({ factAId: left.id, factBId: right.id, fingerprint: factPairFingerprint(left, right),
        kind: 'qualified_potential', status: 'open' });
    }
  }
  return pairs;
}

export function validFactPairWorkspace(a, b) {
  return sameWorkspace(a, b);
}
