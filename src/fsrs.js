/**
 * FSRS v5 scheduler ported from a public FSRS reference implementation.
 *
 * Default weights from the open-source FSRS v5 paper (2024).
 * Target retention: 0.9 (90%).
 * Persistence belongs to the owner-scoped repository or guest session.
 *
 * Public API:
 *   createCard(id)           → fresh card state
 *   scheduleCard(card, rating, now) → next card state after a review
 *     rating: 'again' | 'hard' | 'good' | 'easy'
 *   isDue(card, now)         → boolean
 */

// FSRS v5 default weights (w0..w18)
const W = [
  0.4072, 1.1829, 3.1262, 15.4722,
  7.2102, 0.5316, 1.0651, 0.0589,
  1.5330, 0.1544, 1.0036, 1.9734,
  0.1100, 0.2900, 2.2700, 0.2500,
  2.9898, 0.5100, 0.43,
];

const TARGET_RETENTION = 0.9;
const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // ≈ 0.10954

// Ratings map to FSRS grades 1-4
const RATING = { again: 1, hard: 2, good: 3, easy: 4 };

/**
 * Stability after first review (never seen before or lapses re-enter new state).
 * s0(r) = w[r-1]   where r is 1-4.
 */
function initialStability(r) {
  return Math.max(W[r - 1], 0.1);
}

/**
 * Initial difficulty d0 based on first rating.
 */
function initialDifficulty(r) {
  return clampD(W[4] - Math.exp(W[5] * (r - 1)) + 1);
}

function clampD(d) {
  return Math.min(Math.max(d, 1), 10);
}

/**
 * Retrievability at elapsed days given stability s.
 */
function retrievability(elapsedDays, s) {
  return Math.pow(1 + FACTOR * (elapsedDays / s), DECAY);
}

/**
 * Next interval to reach target retention given current stability.
 */
function nextInterval(s) {
  const days = (s / FACTOR) * (Math.pow(TARGET_RETENTION, 1 / DECAY) - 1);
  return Math.max(1, Math.round(days));
}

/**
 * Difficulty update after a review.
 */
function updateDifficulty(d, r) {
  const delta = -W[6] * (r - 3);
  return clampD(W[7] * initialDifficulty(4) + (1 - W[7]) * (d + delta));
}

/**
 * Stability after a successful review (reps > 0, rating >= 2).
 */
function nextStabilityRecall(d, s, r, elapsed) {
  const R = retrievability(elapsed, s);
  const hardPenalty = r === 2 ? W[15] : 1;
  const easyBonus = r === 4 ? W[16] : 1;
  return s * (
    Math.exp(W[8]) *
    (11 - d) *
    Math.pow(s, -W[9]) *
    (Math.exp((1 - R) * W[10]) - 1) *
    hardPenalty *
    easyBonus + 1
  );
}

/**
 * Stability after a lapse (rating === 1 = again).
 */
function nextStabilityLapse(d, s, R) {
  // A lapse never makes a card more stable than it was (an overdue "Again"
  // used to raise it, scheduling a forgotten card further out).
  return Math.max(
    Math.min(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - R) * W[14]), s),
    0.1
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a fresh card. id should be stable (e.g. a short slug).
 */
export function createCard(id) {
  return {
    id,
    stability: 0,
    difficulty: 0,
    due: 0,           // unix ms, 0 = never reviewed (due immediately)
    lastReview: 0,    // unix ms
    reps: 0,
  };
}

/**
 * Schedule a card after a review.
 * Returns a new card object (doesn't mutate).
 */
export function scheduleCard(card, ratingStr, now = Date.now()) {
  const r = RATING[ratingStr] ?? 3;

  let s, d;

  if (card.reps === 0) {
    // First review ever
    s = initialStability(r);
    d = initialDifficulty(r);
  } else {
    const elapsedDays = Math.max(0, (now - card.lastReview) / 86_400_000);
    d = updateDifficulty(card.difficulty, r);
    if (r === 1) {
      // Lapse: reset stability using lapse formula
      const R = retrievability(elapsedDays, card.stability);
      s = nextStabilityLapse(d, card.stability, R);
    } else {
      s = nextStabilityRecall(d, card.stability, r, elapsedDays);
    }
  }

  const intervalDays = r === 1 ? 0 : nextInterval(s); // again = review in <10 min
  const dueMs = r === 1
    ? now + 10 * 60 * 1000   // 10 minutes for lapses
    : now + intervalDays * 86_400_000;

  return {
    ...card,
    stability: s,
    difficulty: d,
    due: dueMs,
    lastReview: now,
    reps: card.reps + 1,
  };
}

/**
 * Returns true if the card is due (or never reviewed).
 */
export function isDue(card, now = Date.now()) {
  return card.reps === 0 || card.due <= now;
}
