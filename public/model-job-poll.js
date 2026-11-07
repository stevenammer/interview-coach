import { isTransientJobStatusError } from './job-recovery.js';

const retryableErrors = ['model_unavailable', 'invalid_model_output', 'spend_cap_reached',
  'accounting_unavailable', 'timed_out'];

export async function waitForModelJob(job, {
  api, startWorker, saveJob, clearJob, recovery, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 180, intervalMs = 2000,
}) {
  saveJob(job);
  const readStatus = async () => {
    try { return await api('job_status', { jobId: job.id }); }
    catch (error) {
      if (isTransientJobStatusError(error)) recovery.showCheckAgain();
      throw error;
    }
  };
  const initial = await readStatus();
  if (initial.status === 'failed') {
    if (retryableErrors.includes(initial.error_code)) recovery.showRetry();
    throw new Error(`Model job failed (${initial.error_code}). Retry when ready.`);
  }
  if (initial.status === 'done') {
    clearJob();
    recovery.clear();
    return initial.result_json;
  }
  // The server's status is authoritative. Start only after it reports queued, and only
  // once for this saved ID. A Check again action can start an unstarted queued job, but
  // cannot start work whose previous start was recorded in session storage.
  if (initial.status === 'queued' && !job.workerStarted) {
    await startWorker(job.id);
    job.workerStarted = true;
    saveJob(job);
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await delay(intervalMs);
    const status = await readStatus();
    if (status.status === 'done') {
      clearJob();
      recovery.clear();
      return status.result_json;
    }
    if (status.status === 'failed') {
      if (retryableErrors.includes(status.error_code)) recovery.showRetry();
      throw new Error(`Model job failed (${status.error_code}). Retry when ready.`);
    }
  }
  recovery.showCheckAgain();
  throw new Error('This review is taking too long. Try again when you are ready.');
}
