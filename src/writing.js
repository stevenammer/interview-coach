// Base writing rules for everything the app writes in the user's name. Adapted from a plain-voice
// style guide for professional documents, then tuned by the user's own
// writing samples when they have them.
export const WRITING_RULES = `Writing rules (follow all of them):
- No em dashes. Use commas, periods, or parentheses.
- Plain words a person would say out loud. Short sentences land the point; a longer one can set it up.
- Specific over impressive. Name the real thing, the real number, the real result. Show the work instead of describing it.
- Never use hollow filler: "passionate", "results-driven", "dynamic", "synergy", "leveraged", "spearheaded", "proven track record", "detail-oriented", "team player", "I am excited to apply", "I am writing to express my interest", "fast-paced environment", "hit the ground running".
- No "not X, but Y" constructions, no colon-then-reveal sentences, no rhetorical questions.
- Lead with the point. No preamble, no restating the question.
- Warm and direct, never gushing. Confident without superlatives about yourself.
- Never invent a number, title, date, employer, team size, or result. Use only the confirmed facts given.
- Never add scope the facts don't state: no "multi-unit", "across locations", "regional", "national", or "portfolio" unless a confirmed fact says it. Say "across all accounts" if that's what the fact says.`;

export function styleBlock(profile) {
  if (!profile?.samples?.length) return '';
  return `Match this person's own voice from their writing samples (style only, never facts): ` +
    `${profile.preferences ? `Preferences: ${profile.preferences}. ` : ''}` +
    `Samples:\n${profile.samples.map((sample) => `- ${sample.text.slice(0, 600)}`).join('\n')}`;
}

// Deterministic check: every number in a generated line must appear in the facts it cites.
export function unsupportedNumbers(text, citedQuotes) {
  // A separator belongs to the number only when followed by digits. Otherwise
  // "2026," is a year followed by punctuation, not a different unsupported value.
  const pattern = /\$?\d+(?:,\d{3})*(?:\.\d+)?%?/g;
  const numbers = String(text).match(pattern) ?? [];
  const normalize = value => value.replace(/^\$/, '').replaceAll(',', '');
  const support = new Set((citedQuotes.join(' ').match(pattern) ?? []).map(normalize));
  return numbers.filter(number => !support.has(normalize(number)));
}

export const documentSchema = (value) => value && Array.isArray(value.sections) && value.sections.length >= 1 &&
  value.sections.length <= 12 && value.sections.every((section) => section && (typeof section.heading === 'string' || section.heading == null) &&
    Array.isArray(section.lines) && section.lines.length <= 60 && section.lines.every((line) =>
      line && typeof line.text === 'string' && line.text.length <= 1200 &&
      Array.isArray(line.factIds ?? []))) &&
  Array.isArray(value.gaps ?? []);
