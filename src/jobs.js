import { CoachService } from './service.js';

export async function runModelJob(repo, model, owner, jobId) {
  const job = await repo.claimJob(owner, jobId);
  if (!job) return false;
  const service = new CoachService(repo, model, owner);
  try {
    let result;
    if (job.kind === 'paste') result = await service.paste(owner, job.input_json);
    else if (job.kind === 'ingest') result = await service.ingest(owner, job.input_json);
    else if (job.kind === 'rep_extract') result = await service.extractRep(owner, job.input_json.interviewId);
    else if (job.kind === 'debrief') result = await service.debrief(owner, job.input_json.interviewId);
    else if (job.kind === 'voice_finish') {
      await service.extractRep(owner, job.input_json.interviewId);
      result = await service.debrief(owner, job.input_json.interviewId);
    }
    else if (job.kind === 'workspace_map') result = await service.mapWorkspace(owner, job.input_json.workspaceId);
    else if (job.kind === 'immerse_week') result = await service.startImmersion(owner, job.input_json.workspaceId);
    else if (job.kind === 'write_document') result = await service.writeDocument(owner, job.input_json.workspaceId, job.input_json.kind, job.input_json.lane ?? null);
    else if (job.kind === 'prep_section') result = await service.buildPrepSection(owner, job.input_json.workspaceId,
      job.input_json.sectionKey, job.input_json.inputHash);
    else throw new Error('Unknown job kind');
    await repo.finishJob(owner, jobId, result);
  } catch (error) {
    if (job.kind === 'prep_section') {
      await repo.failPrepSection(owner, job.input_json.workspaceId, job.input_json.sectionKey,
        error.code ?? 'model_job_failed');
    }
    await repo.finishJob(owner, jobId, null, error.code ?? 'model_job_failed');
  }
  return true;
}
