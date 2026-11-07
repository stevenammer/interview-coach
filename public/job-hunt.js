export const HUNT_STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'no_response'];
export const CLOSED_HUNT_STATUSES = new Set(['accepted', 'rejected', 'withdrawn', 'no_response']);

export function huntSummary(workspaces) {
  const counts = Object.fromEntries(HUNT_STATUSES.map((status) => [status, 0]));
  for (const workspace of workspaces) counts[workspace.hunt_status ?? 'saved'] += 1;
  const open = HUNT_STATUSES.filter((status) => !CLOSED_HUNT_STATUSES.has(status))
    .filter((status) => counts[status]).map((status) => `${counts[status]} ${status}`);
  const closed = [...CLOSED_HUNT_STATUSES].reduce((total, status) => total + counts[status], 0);
  return [...open, ...(closed ? [`${closed} closed`] : [])].join(', ') || 'No jobs yet';
}

export function nextStepOverdue(workspace, today = new Date().toISOString().slice(0, 10)) {
  return Boolean(workspace.next_step_on && workspace.next_step_on < today && !CLOSED_HUNT_STATUSES.has(workspace.hunt_status));
}

export function jobHuntCsv(workspaces) {
  // A cell that starts with = + - or @ can run as a formula when the file is opened in a spreadsheet.
  const quote = (value) => {
    const text = String(value ?? '');
    return `"${(/^[\s\uFEFF]*[=+\-@＝＋－＠]|^[\t\r\n]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
  };
  const rows = [['company/job name', 'status', 'applied on', 'next step', 'next step date', 'interview date', 'notes'],
    ...workspaces.map((workspace) => [workspace.company_name || workspace.label, workspace.hunt_status || 'saved',
      workspace.applied_on, workspace.next_step, workspace.next_step_on, workspace.interview_date, workspace.hunt_notes])];
  return `${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}
