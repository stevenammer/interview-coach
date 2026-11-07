// Role packs give the interviewer and the Job Immerser domain-native probes. They are
// context for what to ask, never claims about the candidate or the employer.
export const rolePacks = {
  hospitality_director_v1: {
    label: 'Hospitality operations director',
    match: /hospitality|hotel|resort|property|guest service/i,
    competencies: ['labor planning', 'guest experience', 'P&L decisions', 'talent development',
      'service standards', 'vendor management', 'crisis response', 'multi-site operations', 'remote leadership'],
    probes: [],
  },
  // Built only from widely known public frameworks, paraphrased. No employer material.
  sales_training_coaching_v1: {
    label: 'Sales training and coaching',
    match: /trainer|training|coach|enablement|onboarding|new[- ]hire|academy|instructional|facilitat/i,
    credit: 'Frameworks paraphrased from Knowles (adult learning), John Whitmore (GROW coaching model) and Kirkpatrick (four levels of training evaluation).',
    competencies: ['adult learning basics', 'teaching a skill in small steps', 'live practice and role-play',
      'coaching with GROW (goal, reality, options, will)', 'observation checklists for calls',
      'giving specific, timely feedback', 'call reviews', 'supporting a trainee who is stuck',
      'evaluating training at four levels (reaction, learning, behavior, results)', 'handing off materials to other trainers'],
    probes: [
      'How do you teach a new agent a skill so they can use it on a live call?',
      'Walk me through how you would give hard feedback after a call.',
      'A trainee is not improving after two weeks. What do you do?',
      'How do you run a call review so the agent leaves with one clear thing to try?',
      'What does good coaching look like to you?',
      'How would you tell whether a training program worked?',
    ],
    typicalRanges: 'Adult learning basics: adults want to know why they are learning something, learn best by doing, and bring their own experience. GROW: agree a goal, look at the current reality, explore options, then commit to a next step. Kirkpatrick: reaction, learning, behavior, results. An observation checklist is a short list of specific behaviors to watch for on a call.',
  },
};

export function roleContext(jdText) {
  const packs = Object.values(rolePacks).filter((pack) => pack.match.test(jdText));
  if (!packs.length) return '';
  return packs.map((pack) => `Relevant role pack (${pack.label}): ${pack.competencies.join(', ')}.` +
    (pack.probes.length ? ` Realistic probes to adapt: ${pack.probes.join(' | ')}` : '') +
    (pack.typicalRanges ? ` ${pack.typicalRanges}` : '') +
    (pack.credit ? ` ${pack.credit}` : '')).join('\n') +
    '\nAsk only about areas present in the JD; do not assume the candidate has done them.';
}
