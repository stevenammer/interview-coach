import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPendingJobRecovery } from '../public/job-recovery.js';
import { waitForModelJob } from '../public/model-job-poll.js';

function fakeButton() {
  return {
    id: 'retry-pending-job', hidden: true, textContent: 'Try again (AI step stalled)',
    addEventListener(type, listener) { assert.equal(type, 'click'); this.listener = listener; },
    click() { return this.listener({ currentTarget: this }); },
  };
}

function setup(api, job, options = {}) {
  const button = fakeButton();
  const counts = { workerStarts: 0, retries: 0, jobsCreated: 0, saved: [], cleared: 0 };
  let recovery;
  const run = () => waitForModelJob(job, {
    api,
    startWorker: async (jobId) => { counts.workerStarts += 1; assert.equal(jobId, job.id); },
    saveJob: (saved) => counts.saved.push({ ...saved }),
    clearJob: () => { counts.cleared += 1; },
    recovery,
    delay: async () => {},
    attempts: options.attempts ?? 3,
  });
  recovery = createPendingJobRecovery({
    button,
    runAction: (_button, task) => task(),
    onCheckAgain: run,
    onRetry: async () => { counts.retries += 1; },
  });
  return { button, counts, recovery, run };
}

test('transient first-poll failure exposes Check again and resumes the same saved job only', async () => {
  const calls = [];
  const job = { id: 'saved-job-17', kind: 'paste', status: 'running', workerStarted: true };
  let shouldFail = true;
  const api = async (op, data) => {
    calls.push([op, data.jobId]);
    assert.equal(op, 'job_status', 'recheck must not retry or create a model job');
    if (shouldFail) {
      shouldFail = false;
      throw new Error("Couldn't reach Interview Coach. Check your connection and try again. Your work is still here.");
    }
    return { status: 'done', result_json: { saved: true } };
  };
  const { button, counts, run } = setup(api, job);

  await assert.rejects(run(), /Couldn't reach/);
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Check again');
  await button.click();

  assert.deepEqual(calls, [['job_status', 'saved-job-17'], ['job_status', 'saved-job-17']]);
  assert.deepEqual(counts, { workerStarts: 0, retries: 0, jobsCreated: 0, saved: [job, job], cleared: 1 });
  assert.equal(button.hidden, true);
});

test('queued resume checks authoritative status before starting the saved worker once', async () => {
  const calls = [];
  const job = { id: 'queued-job-22', kind: 'paste', status: 'queued' };
  const api = async (op, data) => {
    calls.push([op, data.jobId]);
    return calls.length === 1 ? { status: 'queued' } : { status: 'done', result_json: { ok: true } };
  };
  const { counts, run } = setup(api, job);
  await run();
  assert.deepEqual(calls, [['job_status', 'queued-job-22'], ['job_status', 'queued-job-22']]);
  assert.equal(counts.workerStarts, 1);
  assert.equal(counts.saved.at(-1).workerStarted, true);
});

test('transient failure in the polling loop offers recheck without repeating a worker start', async () => {
  const job = { id: 'running-job-29', status: 'running', workerStarted: true };
  let calls = 0;
  const api = async () => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('temporary server issue'), { status: 503 });
    return calls >= 3 ? { status: 'done', result_json: { ok: true } } : { status: 'running' };
  };
  const { button, counts, run } = setup(api, job);
  await assert.rejects(run(), /temporary server issue/);
  assert.equal(button.textContent, 'Check again');
  await button.click();
  assert.equal(counts.workerStarts, 0);
  assert.equal(counts.retries, 0);
});

test('garbled successful job-status JSON is retryable, while an initial done result returns immediately', async () => {
  const job = { id: 'garbled-job', status: 'running', workerStarted: true };
  const calls = [];
  let fail = true;
  const api = async (op, data) => {
    calls.push([op, data.jobId]);
    if (fail) {
      fail = false;
      throw Object.assign(new Error('Something came back garbled. Try that again.'), { status: 200 });
    }
    return { status: 'done', result_json: { recovered: true } };
  };
  const broken = setup(api, job);
  await assert.rejects(broken.run(), /came back garbled/);
  assert.equal(broken.button.textContent, 'Check again');
  await broken.button.click();
  assert.deepEqual(calls, [['job_status', 'garbled-job'], ['job_status', 'garbled-job']]);
  assert.equal(broken.counts.workerStarts, 0);

  const doneJob = { id: 'already-done', status: 'queued' };
  const doneCalls = [];
  const done = setup(async (op, data) => {
    doneCalls.push([op, data.jobId]);
    return { status: 'done', result_json: { finished: true } };
  }, doneJob);
  assert.deepEqual(await done.run(), { finished: true });
  assert.deepEqual(doneCalls, [['job_status', 'already-done']]);
  assert.equal(done.counts.workerStarts, 0);
  assert.equal(done.counts.cleared, 1);
});

test('authentication and missing-job errors do not offer a transient recheck', async () => {
  for (const status of [401, 404]) {
    const job = { id: `gone-${status}`, status: 'running', workerStarted: true };
    const api = async () => { throw Object.assign(new Error('request rejected'), { status }); };
    const { button, run } = setup(api, job);
    await assert.rejects(run(), /request rejected/);
    assert.equal(button.hidden, true);
  }
});

test('poll timeout offers Check again, while terminal retryable failure keeps Try again', async () => {
  const timeoutJob = { id: 'slow-job', status: 'running', workerStarted: true };
  const timeoutApi = async () => ({ status: 'running' });
  const timed = setup(timeoutApi, timeoutJob, { attempts: 1 });
  await assert.rejects(timed.run(), /taking too long/);
  assert.equal(timed.button.textContent, 'Check again');

  const failedJob = { id: 'failed-job', status: 'queued' };
  const failedApi = async () => ({ status: 'failed', error_code: 'model_unavailable' });
  const failed = setup(failedApi, failedJob);
  await assert.rejects(failed.run(), /Model job failed/);
  assert.equal(failed.button.textContent, 'Try again (AI step stalled)');
  await failed.button.click();
  assert.equal(failed.counts.retries, 1);
});

test('application gates saved-job rechecks to signed-in account sessions', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /async function resumeJob\(\)[\s\S]*?if \(!pendingJob \|\| guest \|\| !currentUser\) return false;/);
  assert.match(app, /onCheckAgain: \(\) => resumeJob\(\)/);
  assert.match(app, /api\('retry_job', \{ jobId: pendingJob\.id \}\)/);
});
