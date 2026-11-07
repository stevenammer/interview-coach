export const PREP_PACK_ORDER = ['three_things', 'fix', 'posting', 'tmay', 'story_map', 'hard_ones',
  'likely_questions', 'questions_to_ask', 'company_facts', 'numbers', 'calm'];

export function prepPackText(sections) {
  const byKey = new Map(sections.map((section) => [section.section_key, section]));
  return PREP_PACK_ORDER.flatMap((key) => {
    const section = byKey.get(key);
    if (!section || section.status !== 'ready') return [];
    const lines = section.content_json?.lines?.map((line) => `• ${line.text}`) ?? [];
    return [section.title, '', ...lines, '', `Next step: ${section.content_json?.nextStep ?? ''}`, ''];
  }).join('\n').trim();
}

export function interviewCountdown(value, now = Date.now()) {
  if (!value) return null;
  const days = Math.ceil((new Date(value).valueOf() - now) / 86400000);
  if (!Number.isFinite(days)) return null;
  return { days, label: days <= 0 ? 'tonight' : days === 1 ? 'tomorrow' : days <= 7 ? 'this week' : `${days} days left` };
}
