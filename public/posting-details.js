const payTerms = /\b(?:salary|salaried|hourly|compensation|pay range|base pay|bonus|commission|on[- ]target earnings|\bote\b|equity|stock options?)\b/i;
const payRange = /\$\s?\d[\d,.]*\s?(?:k|m)?\s*(?:-|–|—|to)\s*\$?\s?\d[\d,.]*\s?(?:k|m)?/i;
const benefitTerms = /\b(?:employee benefits?|benefits? (?:include|package|offered|provided)|401\s?\(?k\)?|403\s?\(?b\)?|retirement (?:plan|contribution|match)|paid time off|\bpto\b|sick leave|parental leave|paid leave|vacation|wellness (?:program|stipend|benefit|allowance)|tuition reimbursement|health (?:insurance|coverage|plan|benefits?)|healthcare (?:insurance|coverage|plan)|medical insurance|dental insurance|vision insurance|life insurance|disability insurance|medical coverage|dental coverage|vision coverage)\b/i;

function isPaySpan(span) {
  // A lone dollar amount is ambiguous (budgets, revenue, and contract value).
  return payTerms.test(span) || payRange.test(span);
}

function isBenefitsSpan(span) {
  if (benefitTerms.test(span)) return true;
  // In a benefits list, two of these three terms identify actual coverage. Alone they
  // often describe the employer's business, a qualification, or the role's customers.
  const coverageTerms = ['medical', 'dental', 'vision'];
  return coverageTerms.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(span)).length >= 2;
}

const qualifies = { pay: isPaySpan, benefits: isBenefitsSpan };
const matchTerms = { pay: /\$\s?\d[\d,.]*|\b(?:salary|salaried|hourly|compensation|pay range|base pay|bonus|commission|on[- ]target earnings|ote|equity|stock options?)\b/i,
  benefits: /\b(?:benefits?|medical|dental|vision|health(?:care)?|401\s?\(?k\)?|403\s?\(?b\)?|retirement|paid time off|pto|sick leave|parental leave|paid leave|vacation|wellness|tuition reimbursement|insurance|coverage|plan)\b/i };

// Keep source wording intact. This intentionally extracts short text spans and never infers a value.
export function postingDetails(text, kind) {
  if (typeof text !== 'string' || !qualifies[kind]) return [];
  const spans = text.split(/\n+|(?<=[.!?])\s+/)
    .map((span) => span.trim())
    .filter((span) => span && !/^(?:pay|salary|compensation|benefits?)\s*:?$/i.test(span));
  const result = [];
  for (const span of spans) {
    if (!qualifies[kind](span) || result.includes(span)) continue;
    if (span.length > 320) {
      const match = span.match(matchTerms[kind]);
      const start = Math.max(0, (match?.index ?? 0) - 100);
      result.push(span.slice(start, start + 320).trim());
    } else result.push(span);
    if (result.length === 3) break;
  }
  return result;
}
