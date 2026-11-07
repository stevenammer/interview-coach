import { id, hash } from './repository.js';

export class GuestRepository {
  constructor(state = {}) {
    this.state = {
      sources: state.sources ?? [], workspaces: state.workspaces ?? [], facts: state.facts ?? [],
      interviews: state.interviews ?? [], turns: state.turns ?? [], debriefs: state.debriefs ?? [],
      events: state.events ?? [], requirements: state.requirements ?? [], rewriteSlots: state.rewriteSlots ?? [],
      storyDigs: state.storyDigs ?? [], drillCards: state.drillCards ?? [], drillReviews: state.drillReviews ?? [],
      realInterviews: state.realInterviews ?? [], factGateDecisions: state.factGateDecisions ?? [],
      immersions: state.immersions ?? [],
      factConflictReviews: state.factConflictReviews ?? [],
      jobHuntHistory: state.jobHuntHistory ?? [],
      writingProfile: state.writingProfile ?? { preferences: '', enabled: false },
    };
  }

  async addSource(_owner, kind, title, text) {
    const source = { id: id(), kind, title, text, content_hash: hash(text) };
    this.state.sources.push(source);
    return source;
  }

  async source(_owner, sourceId) {
    return this.state.sources.find((item) => item.id === sourceId) ?? null;
  }

  async setPageOffsets(_owner, sourceId, offsets) {
    const source = await this.source(null, sourceId);
    source.page_offsets_json = offsets;
  }

  async addWritingSample(_owner, title, text) {
    return this.addSource(null, 'writing_sample', title, text);
  }

  async writingSamples() {
    return this.state.sources.filter((source) => source.kind === 'writing_sample');
  }

  async writingProfile() {
    return { ...this.state.writingProfile, samples: await this.writingSamples() };
  }

  async saveWritingProfile(_owner, preferences, enabled) {
    this.state.writingProfile = { preferences, enabled };
    return this.writingProfile();
  }

  async addWorkspace(_owner, jdSourceId, label) {
    const workspace = { id: id(), jd_source_id: jdSourceId, label, status: 'active' };
    this.state.workspaces.push(workspace);
    return workspace;
  }

  async workspace(_owner, workspaceId) {
    return this.state.workspaces.find((item) => item.id === workspaceId) ?? null;
  }

  async workspaces() {
    return this.state.workspaces.map((workspace) => ({ ...workspace,
      jd_text: this.state.sources.find((source) => source.id === workspace.jd_source_id)?.text ?? '' }));
  }

  async setWorkspacePreferences(_owner, workspaceId, remotePreference, listingWorkMode) {
    const workspace = await this.workspace(null, workspaceId);
    if (!workspace) return null;
    workspace.remote_preference = remotePreference;
    workspace.listing_work_mode = listingWorkMode;
    return workspace;
  }

  async setJobComparison(_owner, workspaceId, { payDetails, benefitsDetails, learnedDetails }) {
    const workspace = await this.workspace(null, workspaceId);
    if (!workspace) return null;
    Object.assign(workspace, { pay_details: payDetails, benefits_details: benefitsDetails,
      learned_details: learnedDetails });
    return workspace;
  }

  async setInterviewDate(_owner, workspaceId, date) {
    const workspace = await this.workspace(null, workspaceId);
    if (!workspace) return null;
    workspace.interview_date = date;
    return workspace;
  }

  async updateJobHunt(_owner, workspaceId, fields) {
    const workspace = await this.workspace(null, workspaceId);
    if (!workspace) return null;
    Object.assign(workspace, { hunt_status: fields.status ?? workspace.hunt_status ?? 'saved',
      applied_on: fields.appliedOn ?? workspace.applied_on ?? null, next_step: fields.nextStep,
      next_step_on: fields.nextStepOn, hunt_notes: fields.notes, posting_link: fields.postingLink });
    return workspace;
  }

  async addJobHuntHistory(_owner, workspaceId, { action, note = null, happenedOn }) {
    const entry = { id: id(), workspace_id: workspaceId, action, note, happened_on: happenedOn,
      created_at: new Date().toISOString() };
    this.state.jobHuntHistory.push(entry);
    return entry;
  }

  async jobHuntHistory(_owner, workspaceId) {
    return this.state.jobHuntHistory.filter((entry) => entry.workspace_id === workspaceId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async deleteJobHuntHistory(_owner, historyId) {
    const index = this.state.jobHuntHistory.findIndex((entry) => entry.id === historyId);
    if (index < 0) return null;
    return this.state.jobHuntHistory.splice(index, 1)[0];
  }

  async verifiedCompanyFacts() { return []; }

  async saveImmersion(_owner, workspaceId, plan, state) {
    const immersion = { id: id(), workspace_id: workspaceId, plan_json: plan, state_json: state };
    this.state.immersions.push(immersion);
    return immersion;
  }

  async immersion(_owner, immersionId) {
    return this.state.immersions.find((item) => item.id === immersionId) ?? null;
  }

  async latestImmersion(_owner, workspaceId) {
    return this.state.immersions.filter((item) => item.workspace_id === workspaceId).at(-1) ?? null;
  }

  async updateImmersion(_owner, immersionId, state) {
    const immersion = await this.immersion(null, immersionId);
    if (immersion) immersion.state_json = state;
    return immersion;
  }

  async addDrillCard(_owner, workspaceId, kind, targetSeconds, cue, factIds, schedule) {
    const card = { id: id(), workspace_id: workspaceId, kind, target_seconds: targetSeconds,
      cue, fact_ids: factIds, schedule_json: schedule, status: 'active' };
    this.state.drillCards.push(card);
    return card;
  }

  async drillCards(_owner, workspaceId) {
    return this.state.drillCards.filter((card) => card.workspace_id === workspaceId && card.status === 'active');
  }

  async drillCard(_owner, cardId) {
    return this.state.drillCards.find((card) => card.id === cardId) ?? null;
  }

  async updateDrillCue(_owner, cardId, cue, schedule = null) {
    const card = await this.drillCard(null, cardId);
    if (card) { card.cue = cue; if (schedule) card.schedule_json = schedule; }
    return card;
  }

  async saveDrillReview(_owner, cardId, answer, hitIds, missedIds, rating, schedule) {
    const card = await this.drillCard(null, cardId);
    card.schedule_json = schedule;
    this.state.drillReviews.push({ card_id: cardId, answer, hit_ids: hitIds, missed_ids: missedIds, rating });
  }

  async latestPlan(_owner, workspaceId) {
    return this.state.interviews.filter((interview) => interview.workspace_id === workspaceId).at(-1)?.plan_json ?? [];
  }

  async saveRealInterview(_owner, workspaceId, captureKind, sourceId, questions, storyFactIds,
    stumped, matchedCount) {
    const capture = { id: id(), workspace_id: workspaceId, capture_kind: captureKind, source_id: sourceId,
      questions_json: questions, story_fact_ids_json: storyFactIds, stumped_json: stumped,
      asked_count: questions.length, matched_count: matchedCount };
    this.state.realInterviews.push(capture);
    return capture;
  }

  async realInterviews(_owner, workspaceId) {
    return this.state.realInterviews.filter((capture) => capture.workspace_id === workspaceId);
  }

  async replaceRequirements(_owner, workspaceId, jdSourceId, items) {
    this.state.requirements = this.state.requirements.filter((item) => item.workspace_id !== workspaceId);
    for (const item of items) this.state.requirements.push({
      id: id(), workspace_id: workspaceId, source_id: jdSourceId,
      text: item.quote, type: item.type, competency: item.competency,
      evidence_needed: item.evidenceNeeded, category: item.category,
      rationale: item.rationale, fact_ids: item.factIds,
      start_offset: item.start, end_offset: item.end,
    });
    return this.requirements(null, workspaceId);
  }

  async requirements(_owner, workspaceId) {
    return this.state.requirements.filter((item) => item.workspace_id === workspaceId);
  }

  async addFact(_owner, data) {
    const source = await this.source(null, data.sourceId);
    const fact = {
      id: id(), workspace_id: data.workspaceId ?? null, domain: data.domain ?? 'candidate',
      subject: data.subject, predicate: data.predicate, value_json: data.value,
      qualifiers_json: data.qualifiers ?? {},
      display_text: data.displayText, status: data.status, review_state: data.reviewState,
      lifecycle: 'active', supersedes_fact_id: data.supersedes ?? null,
      discrepancy_note: data.discrepancyNote ?? null, proposed_by: data.proposedBy,
      verbatim_quote: data.quote, start_offset: data.start, end_offset: data.end,
      source_title: source.title,
      source_id: source.id,
      page_number: data.pageNumber ?? null,
      section_label: data.sectionLabel ?? null,
    };
    this.state.facts.push(fact);
    this.state.events.push({ fact_id: fact.id, event_type: 'proposed' });
    return fact.id;
  }

  async facts(_owner, workspaceId) {
    return this.state.facts.filter((fact) => !fact.workspace_id || fact.workspace_id === workspaceId)
      .map((fact) => {
        const source = this.state.sources.find((item) => item.id === fact.source_id);
        if (!source || fact.start_offset == null) return fact;
        const lineStart = source.text.lastIndexOf('\n', fact.start_offset - 1) + 1;
        const nextBreak = source.text.indexOf('\n', fact.end_offset);
        const lineEnd = nextBreak < 0 ? source.text.length : nextBreak;
        return { ...fact, line_quote: source.text.slice(lineStart, lineEnd), line_start: lineStart, line_end: lineEnd };
      });
  }

  async fact(_owner, factId) {
    return this.state.facts.find((fact) => fact.id === factId) ?? null;
  }

  async factConflictReviews(_owner, workspaceId = null) {
    return this.state.factConflictReviews.filter((review) => !review.workspace_id || review.workspace_id === workspaceId);
  }

  async createFactConflictReview(_owner, { workspaceId, factAId, factBId, fingerprint, status = 'open', reason }) {
    const [factA, factB] = [factAId, factBId].sort();
    let review = this.state.factConflictReviews.find((item) => item.fact_a_id === factA && item.fact_b_id === factB &&
      item.content_fingerprint === fingerprint);
    if (!review) {
      review = { id: id(), workspace_id: workspaceId, fact_a_id: factA, fact_b_id: factB,
        content_fingerprint: fingerprint, status, reason, context_note: null,
        review_history: [{ action: 'reported', status, reason, at: new Date().toISOString() }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      this.state.factConflictReviews.push(review);
    }
    return review;
  }

  async updateFactConflictReview(_owner, reviewId, fingerprint, status, reason) {
    const review = this.state.factConflictReviews.find((item) => item.id === reviewId && item.content_fingerprint === fingerprint);
    if (!review) return null;
    if (status === 'context_review') review.context_note = reason;
    review.review_history.push({ action: status, status, reason, at: new Date().toISOString() });
    Object.assign(review, { status, reason, updated_at: new Date().toISOString() });
    return review;
  }

  async resolveFactConflictReviewsForFact(_owner, factId, reason) {
    for (const review of this.state.factConflictReviews) {
      if (['open', 'context_review'].includes(review.status) && (review.fact_a_id === factId || review.fact_b_id === factId)) {
        review.review_history.push({ action: 'fact_set_aside_or_corrected', status: 'resolved', reason, at: new Date().toISOString() });
        Object.assign(review, { status: 'resolved', reason, updated_at: new Date().toISOString() });
      }
    }
  }

  async review(_owner, factId, action) {
    const fact = await this.fact(null, factId);
    if (!fact || fact.lifecycle !== 'active') return null;
    fact.review_state = action === 'confirm' ? 'accepted' : 'rejected';
    if (action === 'confirm') fact.status = 'user_confirmed';
    this.state.events.push({ fact_id: factId, event_type: action === 'confirm' ? 'confirmed' : 'rejected' });
    return fact;
  }

  async supersede(_owner, factId, replacementId, reason) {
    this.state.immersions = [];
    const fact = await this.fact(null, factId);
    fact.lifecycle = 'superseded';
    this.state.events.push({ fact_id: factId, event_type: 'superseded', replacement_fact_id: replacementId, reason });
    for (const item of this.state.debriefs) item.rewrite.status = 'invalidated';
    for (const card of this.state.drillCards) if (card.fact_ids.includes(factId)) card.status = 'invalidated';
  }

  async events(_owner, factId) {
    return this.state.events.filter((item) => item.fact_id === factId);
  }

  async createInterview(_owner, workspaceId, questions, persona = 'hiring_manager', difficulty = 2, practiceMode = 'mock') {
    const interview = { id: id(), workspace_id: workspaceId, plan_json: questions, persona,
      difficulty, practice_mode: practiceMode, status: 'active' };
    this.state.interviews.push(interview);
    return interview;
  }

  async interview(_owner, interviewId) {
    return this.state.interviews.find((item) => item.id === interviewId) ?? null;
  }

  async turns(_owner, interviewId) {
    return this.state.turns.filter((item) => item.interview_id === interviewId);
  }

  async addTurn(_owner, interviewId, speaker, text) {
    const turn = { id: id(), interview_id: interviewId, sequence: (await this.turns(null, interviewId)).length, speaker, text };
    this.state.turns.push(turn);
    return turn;
  }

  async setInterviewFocus(_owner, interviewId, focus) {
    const interview = await this.interview(null, interviewId);
    if (interview) interview.focus = focus;
  }

  async previousDebrief(_owner, workspaceId, interviewId) {
    const inWorkspace = this.state.interviews.filter((item) => item.workspace_id === workspaceId);
    const index = inWorkspace.findIndex((item) => item.id === interviewId);
    const earlier = new Set(inWorkspace.slice(0, Math.max(index, 0)).map((item) => item.id));
    return this.state.debriefs.findLast((item) => earlier.has(item.interview_id))?.report?.feedback ?? null;
  }

  async endInterview(_owner, interviewId) {
    (await this.interview(null, interviewId)).status = 'ended';
  }

  async saveDebrief(_owner, interview, report, artifact) {
    this.state.debriefs.push({ interview_id: interview.id, report, rewrite: artifact, input_hash: report.inputHash });
  }

  async debrief(_owner, interviewId) {
    return this.state.debriefs.findLast((item) => item.interview_id === interviewId) ?? null;
  }

  async saveFactGateDecision(_owner, interviewId, item, choice, proposalFactId = null, note = null) {
    const decision = { id: id(), interview_id: interviewId, lane: item.lane,
      answer_quote: item.answerQuote, choice, proposal_fact_id: proposalFactId, note };
    this.state.factGateDecisions.push(decision);
    return decision;
  }

  async factGateDecision(_owner, interviewId, item) {
    return this.state.factGateDecisions.find((decision) => decision.interview_id === interviewId &&
      decision.lane === item.lane && decision.answer_quote === item.answerQuote) ?? null;
  }

  async replaceRewriteSlots(_owner, interviewId, labels) {
    this.state.rewriteSlots = this.state.rewriteSlots.filter((slot) => slot.interview_id !== interviewId);
    for (const label of labels) this.state.rewriteSlots.push({ id: id(), interview_id: interviewId,
      label, state: 'pending' });
    return this.rewriteSlots(null, interviewId);
  }

  async rewriteSlots(_owner, interviewId) {
    return this.state.rewriteSlots.filter((slot) => slot.interview_id === interviewId);
  }

  async rewriteSlot(_owner, slotId) {
    return this.state.rewriteSlots.find((slot) => slot.id === slotId) ?? null;
  }

  async startDig(_owner, workspaceId, competency) {
    const dig = { id: id(), workspace_id: workspaceId, competency, status: 'started' };
    this.state.storyDigs.push(dig);
    return dig;
  }

  async dig(_owner, digId) {
    return this.state.storyDigs.find((dig) => dig.id === digId) ?? null;
  }

  async reflectDig(_owner, digId, scene, reflection) {
    const dig = await this.dig(null, digId);
    if (!dig || dig.status !== 'started') return null;
    Object.assign(dig, { scene_text: scene, reflection, status: 'awaiting_confirmation' });
    return dig;
  }

  async confirmDig(_owner, digId, scene) {
    const dig = await this.dig(null, digId);
    if (!dig || dig.status !== 'awaiting_confirmation') return null;
    Object.assign(dig, { scene_text: scene, status: 'confirmed' });
    return dig;
  }

  async resolveRewriteSlot(_owner, slotId, state, proposalFactId = null, reason = null) {
    const slot = await this.rewriteSlot(null, slotId);
    if (!slot || slot.state !== 'pending') return null;
    Object.assign(slot, { state, proposal_fact_id: proposalFactId, reason, resolved_at: new Date().toISOString() });
    return slot;
  }

  async deleteFact(_owner, factId) {
    this.state.immersions = [];
    this.state.factGateDecisions = [];
    this.state.rewriteSlots = [];
    const remove = new Set([factId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const fact of this.state.facts) {
        if (remove.has(fact.supersedes_fact_id) && !remove.has(fact.id)) {
          remove.add(fact.id);
          changed = true;
        }
      }
    }
    this.state.facts = this.state.facts.filter((fact) => !remove.has(fact.id));
    this.state.drillCards = this.state.drillCards.filter((card) => !card.fact_ids.some((id) => remove.has(id)));
    this.state.drillReviews = this.state.drillReviews.filter((review) =>
      this.state.drillCards.some((card) => card.id === review.card_id));
    for (const requirement of this.state.requirements) {
      requirement.fact_ids = requirement.fact_ids.filter((id) => !remove.has(id));
      if (!requirement.fact_ids.length) requirement.category = 'none';
    }
    this.state.events = this.state.events.filter((event) => !remove.has(event.fact_id));
    this.state.debriefs = [];
    return remove.size;
  }

  async deleteSource(_owner, sourceId) {
    this.state.immersions = [];
    const source = await this.source(null, sourceId);
    if (!source) return false;
    const removedCaptures = this.state.realInterviews.filter((capture) => capture.source_id === sourceId);
    const removedCues = new Set(removedCaptures.flatMap((capture) => capture.stumped_json)
      .map((question) => `Recover from the real question: ${question}`));
    this.state.realInterviews = this.state.realInterviews.filter((capture) => capture.source_id !== sourceId);
    this.state.drillCards = this.state.drillCards.filter((card) => !removedCues.has(card.cue));
    this.state.factGateDecisions = [];
    this.state.rewriteSlots = [];
    this.state.debriefs = [];
    for (const fact of [...this.state.facts]) {
      if (fact.source_id === sourceId) await this.deleteFact(null, fact.id);
    }
    const workspaceIds = this.state.workspaces.filter((workspace) => workspace.jd_source_id === sourceId).map((workspace) => workspace.id);
    for (const fact of [...this.state.facts]) {
      if (workspaceIds.includes(fact.workspace_id)) await this.deleteFact(null, fact.id);
    }
    const interviewIds = this.state.interviews.filter((interview) => workspaceIds.includes(interview.workspace_id)).map((interview) => interview.id);
    this.state.workspaces = this.state.workspaces.filter((workspace) => !workspaceIds.includes(workspace.id));
    this.state.storyDigs = this.state.storyDigs.filter((dig) => !workspaceIds.includes(dig.workspace_id));
    this.state.drillCards = this.state.drillCards.filter((card) => !workspaceIds.includes(card.workspace_id));
    this.state.realInterviews = this.state.realInterviews.filter((capture) => !workspaceIds.includes(capture.workspace_id));
    this.state.drillReviews = this.state.drillReviews.filter((review) =>
      this.state.drillCards.some((card) => card.id === review.card_id));
    this.state.requirements = this.state.requirements.filter((item) => !workspaceIds.includes(item.workspace_id));
    this.state.jobHuntHistory = this.state.jobHuntHistory.filter((item) => !workspaceIds.includes(item.workspace_id));
    this.state.interviews = this.state.interviews.filter((interview) => !interviewIds.includes(interview.id));
    this.state.turns = this.state.turns.filter((turn) => !interviewIds.includes(turn.interview_id));
    this.state.debriefs = this.state.debriefs.filter((item) => !interviewIds.includes(item.interview_id));
    this.state.sources = this.state.sources.filter((item) => item.id !== sourceId);
    return true;
  }
}
