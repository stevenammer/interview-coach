// The public example workspace is isolated from account data.
export function publicWorkspaceLabel(role, company) {
  const label = `${role} at ${company}`;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

// Seed one role, a short summary of approved facts, and the draft practice answers.
export function createSampleGuest(profile, selectedRole = profile.defaultRole) {
  if (!profile?.facts?.length || !selectedRole?.role || !selectedRole?.company) throw new Error('The public example is unavailable.');
  const workspaceId = crypto.randomUUID();
  const draftId = crypto.randomUUID();
  const careerId = crypto.randomUUID();
  const roleId = crypto.randomUUID();
  const sourceText = `${profile.sourceNote}\n\n${profile.facts.map((fact) => fact.text).join('\n')}`;
  const facts = profile.facts.map((entry) => {
    const start = sourceText.indexOf(entry.text);
    return { id: crypto.randomUUID(), workspace_id: null, domain: 'candidate', subject: profile.name,
      predicate: entry.key, value_json: entry.text, qualifiers_json: { provenance: 'sample_summary' },
      display_text: entry.text, verbatim_quote: entry.text, start_offset: start, end_offset: start + entry.text.length,
      status: 'user_confirmed', review_state: 'accepted', lifecycle: 'active', proposed_by: 'user',
      source_id: careerId, source_title: profile.sourceTitle, section_label: entry.group };
  });
  const focusDefinitions = [
    { text: 'Explain how you teach a new sales agent a skill they can use on the phones.', competency: 'Training',
      keys: ['curriculum_creation', 'curriculum_handoff', 'training_library'], category: 'direct',
      rationale: 'A curriculum you built, taught, refined and handed off is a specific process to walk through.' },
    { text: 'Describe how you coach an agent after a call, including hard feedback.', competency: 'Coaching',
      keys: ['floor_supervision', 'sales_background'], category: 'adjacent',
      rationale: 'Floor supervision and phone sales give you context. Add a real coaching example before you rely on it.' },
    { text: 'Say how you would tell whether training worked.', competency: 'Measuring results',
      keys: ['curriculum_creation'], category: 'adjacent',
      rationale: 'Be plain that Week 4 had a graduation requirement, not a measured pass rate.' },
  ];
  const draftText = (profile.draftAnswers ?? []).map((item) => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n');
  const roleText = [`Public practice focus for ${selectedRole.role} at ${selectedRole.company}: teach and coach new sales agents on the phones.`,
    "This is rehearsal guidance for a role title, not a copy of any employer posting or a statement about the role's internal details.",
    ...focusDefinitions.map((focus) => focus.text)].join('\n');
  const requirements = focusDefinitions.map((focus) => {
    const start = roleText.indexOf(focus.text);
    return { id: crypto.randomUUID(), workspace_id: workspaceId, source_id: roleId,
      text: focus.text, type: 'responsibility', competency: focus.competency, category: focus.category,
      rationale: focus.rationale, evidence_needed: 'Your own action, its context, and an outcome you can support.',
      fact_ids: facts.filter((fact) => focus.keys.includes(fact.predicate)).map((fact) => fact.id),
      start_offset: start, end_offset: start + focus.text.length };
  });
  const workspace = { id: workspaceId, jd_source_id: roleId,
    label: publicWorkspaceLabel(selectedRole.role, selectedRole.company), status: 'active',
    role_title: selectedRole.role, company_name: selectedRole.company, hunt_status: 'saved',
    listing_work_mode: 'unspecified', remote_preference: 'unspecified', public_summary: true,
    posting_link: '',
    learned_details: 'Public rehearsal copy built from public information and Steven Ammer\'s own words. No employer materials are used. Replace the practice focuses with a real posting for a precise job match.' };
  return { workspaceId, state: { sources: [
    { id: careerId, kind: 'background', title: profile.sourceTitle, text: sourceText },
    { id: roleId, kind: 'jd', title: 'Public practice focus (not an employer posting)', text: roleText },
    { id: draftId, kind: 'background', title: profile.draftAnswersTitle ?? 'Draft answers, still practicing', text: draftText },
  ], workspaces: [workspace], facts, requirements,
    events: facts.map((fact) => ({ fact_id: fact.id, event_type: 'confirmed' })) } };
}
