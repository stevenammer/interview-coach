export const VALIDATOR_VERSION = 1;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function gateRewrite(proposed, facts) {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const claims = proposed.map((raw) => {
    const claim = raw && typeof raw === 'object' ? raw : {};
    const factIds = Array.isArray(claim.factIds) ? claim.factIds : [];
    const fact = factIds.length === 1 ? byId.get(factIds[0]) : null;
    let reason = null;
    if (!fact) reason = 'missing_or_foreign_fact';
    // Usable = the user accepted it: either a document fact they confirmed on review,
    // or their own correction. Unreviewed document facts and draft inferences never pass.
    else if (fact.domain !== 'candidate' || fact.lifecycle !== 'active' ||
      fact.review_state !== 'accepted' || !['user_confirmed', 'document'].includes(fact.status)) reason = 'unusable_fact';
    else if ((claim.subject !== undefined && fact.subject !== claim.subject) ||
      (claim.predicate !== undefined && fact.predicate !== claim.predicate) ||
      (claim.value !== undefined && JSON.stringify(canonical(fact.value_json)) !== JSON.stringify(canonical(claim.value)))) {
      reason = 'claim_changes_fact';
    } else if (fact.verbatim_quote !== fact.display_text && fact.source_title !== 'Your correction') {
      reason = 'unverified_rendering';
    }
    return {
      factIds,
      text: reason ? '' : fact.display_text,
      valid: !reason,
      reason,
      atomicClaim: reason ? null : { subject: fact.subject, predicate: fact.predicate, value: fact.value_json },
    };
  });
  const ready = claims.length > 0 && claims.every((claim) => claim.valid);
  return {
    ready,
    claims,
    text: ready ? claims.map((claim) => claim.text).join(' ') : '',
    missingDetailQuestion: ready ? null : 'Which details can you confirm from your own experience?',
    validatorVersion: VALIDATOR_VERSION,
  };
}
