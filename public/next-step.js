export function chooseNextStep(state, now = Date.now()) {
  const pending = Number(state.pendingFacts ?? 0);
  const interviewAt = state.interviewDate ? new Date(state.interviewDate).valueOf() : NaN;
  const hoursLeft = Number.isFinite(interviewAt) ? (interviewAt - now) / 3600000 : Infinity;
  if (pending > 0) return {
    key: 'facts',
    label: `Confirm what's true about you (${pending} left)`,
    reason: 'Review these details before the coach uses them in your answers.',
  };
  if (state.guest) return {
    key: 'practice',
    label: 'Practice a mock interview: type it or talk it',
    reason: 'Try your answers for this job in a short practice interview.',
  };
  if (!state.hasPrepPack) return {
    key: 'prep',
    label: 'Build your Prep Pack (about 2 minutes)',
    reason: 'Build a focused plan from this job posting and any details you have confirmed.',
  };
  if (!state.hasPractice) return {
    key: 'practice',
    label: 'Practice a mock interview: type it or talk it',
    reason: 'Try using your confirmed stories in a short interview for this job.',
  };
  if (state.debriefWaiting) return {
    key: 'debrief',
    label: 'Read your last debrief',
    reason: 'Feedback from your last practice is ready to review.',
  };
  if (hoursLeft >= 0 && hoursLeft <= 48) return {
    key: 'cram',
    label: 'Use your Prep Pack for a final run-through',
    reason: 'Your interview is within 48 hours. Use the plan for one final review.',
  };
  return {
    key: 'practice',
    label: 'Practice a mock interview: type it or talk it',
    reason: 'Keep your answers familiar with another practice, then review the feedback.',
  };
}
