// Plain-English buzzword decoder. Rules only: instant, free, and works with no network.
// Shared by the browser (hints while a plain version loads, and the offline fallback)
// and the server (the fallback when the model call fails or a guardrail rejects it).
// Every meaning is a few everyday words, written the way you'd explain it to a friend.

export const DECODER_TERMS = Object.freeze([
  { term: 'KPI', pattern: /\bKPIs?\b/, plain: 'the numbers they watch to see if things are going well' },
  { term: 'metric', pattern: /\bmetrics?\b/i, plain: 'a number you track' },
  { term: 'stakeholder', pattern: /\bstake-?holders?\b/i, plain: 'the people who care about the outcome' },
  { term: 'cross-functional', pattern: /\bcross[- ]functional(?:ly)?\b/i, plain: 'working with other teams' },
  { term: 'buy-in', pattern: /\bbuy[- ]in\b/i, plain: 'getting people on board' },
  { term: 'bandwidth', pattern: /\bbandwidth\b/i, plain: 'time and energy to take something on' },
  { term: 'escalation', pattern: /\bescalat(?:e|ed|es|ing|ion|ions)\b/i, plain: 'a problem passed up to someone with more say' },
  { term: 'scalable', pattern: /\bscal(?:able|ability|e up|ing up)\b/i, plain: 'still works when it gets bigger' },
  { term: 'leverage', pattern: /\bleverag(?:e|ed|es|ing)\b/i, plain: 'use' },
  { term: 'deliverable', pattern: /\bdeliverables?\b/i, plain: 'the thing you hand over at the end' },
  { term: 'SOP', pattern: /\bSOPs?\b/, plain: 'the written steps for how a job gets done' },
  { term: 'STAR', pattern: /\bSTAR\b/, plain: 'tell it as a story: what was going on, what you did, how it turned out' },
  { term: 'process', pattern: /\bprocess(?:es)?\b/i, plain: 'the way something gets done, step by step' },
  { term: 'workflow', pattern: /\bwork-?flows?\b/i, plain: 'the steps work goes through, in order' },
  { term: 'bottleneck', pattern: /\bbottle-?necks?\b/i, plain: 'the spot where things pile up and slow down' },
  { term: 'P&L', pattern: /\bP\s?&\s?L\b|\bprofit and loss\b/i, plain: 'money in versus money out' },
  { term: 'ROI', pattern: /\bROI\b|\breturn on investment\b/i, plain: 'what you got back for what you spent' },
  { term: 'synergy', pattern: /\bsynerg(?:y|ies|istic)\b/i, plain: 'things working better together' },
  { term: 'alignment', pattern: /\balign(?:ment|ed|ing)?\b/i, plain: 'everyone agreeing on the same goal' },
  { term: 'onboarding', pattern: /\bonboard(?:ing|ed)?\b/i, plain: 'getting new people trained and settled' },
  { term: 'headcount', pattern: /\bhead-?count\b/i, plain: 'how many people are on the team' },
  { term: 'throughput', pattern: /\bthroughput\b/i, plain: 'how much gets done in a set time' },
  { term: 'best practices', pattern: /\bbest practices?\b/i, plain: 'the ways that usually work best' },
  { term: 'accountability', pattern: /\baccountab(?:ility|le)\b/i, plain: 'owning the result, good or bad' },
  { term: 'ownership', pattern: /\b(?:take|took|taking) ownership\b|\bownership\b/i, plain: 'treating it as yours to fix' },
  { term: 'initiative', pattern: /\binitiatives?\b/i, plain: 'a project someone started on purpose' },
  { term: 'change management', pattern: /\bchange management\b/i, plain: 'helping people get used to a new way of doing things' },
  { term: 'continuous improvement', pattern: /\bcontinuous improvement\b/i, plain: 'small fixes, made again and again' },
  { term: 'root cause', pattern: /\broot[- ]cause\b/i, plain: 'the real reason something went wrong' },
  { term: 'mitigate', pattern: /\bmitigat(?:e|ed|es|ing|ion)\b/i, plain: 'make a problem smaller' },
  { term: 'prioritize', pattern: /\bprioriti[sz](?:e|ed|es|ing|ation)\b/i, plain: 'decide what comes first' },
  { term: 'optimize', pattern: /\boptimi[sz](?:e|ed|es|ing|ation)\b/i, plain: 'make it work better' },
  { term: 'compliance', pattern: /\bcomplian(?:ce|t)\b/i, plain: 'following the rules you have to follow' },
  { term: 'benchmark', pattern: /\bbenchmarks?\b/i, plain: 'a number to compare against' },
  { term: 'cadence', pattern: /\bcadence\b/i, plain: 'how often something happens' },
  { term: 'touchpoint', pattern: /\btouch-?points?\b|\btouch base\b/i, plain: 'a time you check in with someone' },
  { term: 'pivot', pattern: /\bpivot(?:ed|ing)?\b/i, plain: 'change direction' },
  { term: 'empower', pattern: /\bempower(?:ed|ing|ment)?\b/i, plain: 'give people the trust and tools to decide' },
  { term: 'value proposition', pattern: /\bvalue prop(?:osition)?\b/i, plain: 'why someone should pick you' },
  { term: 'operational excellence', pattern: /\boperational excellence\b/i, plain: 'running things smoothly, every day' },
  { term: 'strategic', pattern: /\bstrateg(?:ic|ically|y|ies)\b/i, plain: 'the big-picture plan' },
  { term: 'tactical', pattern: /\btactical(?:ly)?\b/i, plain: 'the hands-on, day-to-day part' },
  { term: 'deep dive', pattern: /\bdeep[- ]dive\b/i, plain: 'a close look' },
  { term: 'circle back', pattern: /\bcircle back\b/i, plain: 'come back to it later' },
  { term: 'move the needle', pattern: /\bmove the needle\b/i, plain: 'make a difference you can see' },
  { term: 'low-hanging fruit', pattern: /\blow[- ]hanging fruit\b/i, plain: 'the easy wins' },
  { term: 'competency', pattern: /\bcompetenc(?:y|ies)\b/i, plain: 'a skill they want to see' },
  { term: 'resource allocation', pattern: /\bresource allocation\b|\ballocat(?:e|ed|ing) resources\b/i, plain: 'deciding who and what goes where' },
  { term: 'attrition', pattern: /\battrition\b|\bturnover\b/i, plain: 'people leaving the job' },
  { term: 'retention', pattern: /\bretention\b/i, plain: 'keeping people (or customers) around' },
  { term: 'upskill', pattern: /\bup-?skill(?:ing|ed)?\b/i, plain: 'teach people new skills' },
  { term: 'SLA', pattern: /\bSLAs?\b/, plain: 'a promise about how fast something gets done' },
  { term: 'NPS', pattern: /\bNPS\b/, plain: 'a score for how likely customers are to recommend you' },
  { term: 'OKR', pattern: /\bOKRs?\b/, plain: 'goals and the numbers that show you hit them' },
  { term: 'variance', pattern: /\bvariance\b/i, plain: 'the gap between the plan and what happened' },
  { term: 'forecast', pattern: /\bforecast(?:s|ing|ed)?\b/i, plain: 'a best guess about what comes next' },
  { term: 'vendor', pattern: /\bvendors?\b/i, plain: 'an outside company you buy from' },
  { term: 'labor model', pattern: /\blabou?r model\b/i, plain: 'how many people you schedule, and when' },
  { term: 'conflict resolution', pattern: /\bconflict resolution\b/i, plain: 'helping people settle a disagreement' },
]);

// What a type of question is really asking, in plain words.
const QUESTION_SHAPES = [
  [/\b(?:tell me about|describe|walk me through|share|give me an example of) (?:a|one|the last) time\b|\bgive me an example\b|\bcan you think of a time\b/i,
    'In plain words: tell one real story. What was going on, what you did, and how it turned out?'],
  [/\bwalk (?:me|us) through\b/i, 'In plain words: what were the steps, in order, in your own words?'],
  [/\bhow would you\b|\bwhat would you do\b|\bhow do you (?:handle|approach)\b|\bhow might you\b/i,
    'In plain words: how would you go about it? There\'s no one right answer. What would you look at first, and why?'],
  [/\bwhy (?:are you interested|this role|do you want|this job|our company|us)\b|\bwhat (?:draws|drew|attracts) you\b/i,
    'In plain words: what made you want this job?'],
  [/\bweakness|area (?:for|of) (?:growth|improvement)\b/i,
    'In plain words: what\'s one thing you\'re getting better at, and what are you doing about it?'],
  [/\bwhat questions do you have\b|\bany questions for (?:me|us)\b/i,
    'In plain words: what do you want to know about the job?'],
  [/\btell me about yourself\b/i, 'In plain words: who are you at work, in a minute or two?'],
];

const QUESTION_KINDS = new Set(['question', 'followup', 'drill']);

// The decoder entries found in a piece of text, in the order they appear, once each.
export function decodeTerms(text) {
  const source = String(text ?? '');
  const found = [];
  for (const entry of DECODER_TERMS) {
    const match = entry.pattern.exec(source);
    if (match) found.push({ term: match[0], plain: entry.plain, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map(({ term, plain }) => ({ term, plain }));
}

// The rules-based plain version. Never invents anything: it either names what kind of
// question this is, or leaves the wording as is and explains the bigger words.
export function decodePlain(text, kind = 'question') {
  const source = String(text ?? '').trim();
  const glossary = decodeTerms(source);
  let plain = null;
  if (QUESTION_KINDS.has(kind)) {
    const shape = QUESTION_SHAPES.find(([pattern]) => pattern.test(source));
    if (shape) plain = shape[1];
  }
  return { text: plain, glossary, source: 'decoder' };
}

export function glossaryLine(glossary) {
  return (glossary ?? []).map((item) => `"${item.term}" means ${item.plain}.`).join(' ');
}
