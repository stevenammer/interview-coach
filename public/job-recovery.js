export function isTransientJobStatusError(error) {
  if (typeof error?.status === 'number') {
    if (error.status === 408 || error.status === 429 || error.status >= 500) return true;
    if (error.status >= 400) return false;
  }
  const message = String(error?.message ?? error ?? '');
  return /couldn't reach interview coach|came back garbled|server hiccuped/i.test(message);
}

export function createPendingJobRecovery({ button, runAction, onCheckAgain, onRetry }) {
  let action = 'retry';
  button.addEventListener('click', (event) => runAction(event.currentTarget, async () => {
    if (action === 'check') {
      action = 'retry';
      button.hidden = true;
      await onCheckAgain();
      return;
    }
    await onRetry();
  }));

  return {
    showCheckAgain() {
      action = 'check';
      button.textContent = 'Check again';
      button.hidden = false;
    },
    showRetry() {
      action = 'retry';
      button.textContent = 'Try again (AI step stalled)';
      button.hidden = false;
    },
    clear() {
      action = 'retry';
      button.hidden = true;
    },
  };
}
