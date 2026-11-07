// Which job the hub opens on: the one with the soonest interview still ahead, else the most
// recently touched. Jobs whose interview date has passed go last.
export function pickDefaultWorkspace(workspaces, now = Date.now()) {
  const time = (value) => { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : null; };
  const upcoming = workspaces.filter((item) => time(item.interview_date) !== null && time(item.interview_date) >= now - 3600000)
    .sort((a, b) => time(a.interview_date) - time(b.interview_date));
  if (upcoming.length) return upcoming[0];
  const open = workspaces.filter((item) => time(item.interview_date) === null || time(item.interview_date) >= now - 3600000);
  const pool = open.length ? open : workspaces;
  return [...pool].sort((a, b) => (time(b.updated_at) ?? 0) - (time(a.updated_at) ?? 0))[0] ?? null;
}
