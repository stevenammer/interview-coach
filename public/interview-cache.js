const PREFIX = 'interview-coach-turns:v2:';
// Retain the current page's answers if browser storage is unavailable.
const liveRecords = new Map();

export function createInterviewCache(storage, namespace) {
  const key = (interviewId) => `${PREFIX}${encodeURIComponent(namespace)}:${encodeURIComponent(interviewId)}`;
  const read = (interviewId) => {
    try {
      const parsed = JSON.parse(storage.getItem(key(interviewId)) || 'null');
      if (!parsed) return liveRecords.get(key(interviewId)) ?? null;
      if (parsed?.version !== 2 || parsed.namespace !== namespace || !Array.isArray(parsed.turns) ||
        parsed.turns.length > 30 || parsed.turns.some((turn) => !['Interviewer', 'You'].includes(turn?.speaker) ||
          typeof turn.text !== 'string' || turn.text.length > 5000)) return null;
      return parsed;
    } catch { return liveRecords.get(key(interviewId)) ?? null; }
  };
  const write = (interviewId, record) => {
    liveRecords.set(key(interviewId), { version: 2, namespace, ...record });
    while (liveRecords.size > 40) liveRecords.delete(liveRecords.keys().next().value);
    try {
      storage.setItem(key(interviewId), JSON.stringify({ version: 2, namespace, ...record }));
      return true;
    } catch { return false; }
  };
  return {
    read,
    append(interviewId, turn) {
      const record = read(interviewId) ?? { turns: [], finished: false };
      record.turns.push({ speaker: turn.speaker, text: String(turn.text) });
      return write(interviewId, record);
    },
    markFinished(interviewId) {
      const record = read(interviewId) ?? { turns: [] };
      record.finished = true;
      return write(interviewId, record);
    },
    clear(interviewId) {
      liveRecords.delete(key(interviewId));
      try { storage.removeItem(key(interviewId)); } catch { /* Storage may be disabled. */ }
    },
    clearNamespace() {
      for (const item of liveRecords.keys()) {
        if (item.startsWith(`${PREFIX}${encodeURIComponent(namespace)}:`)) liveRecords.delete(item);
      }
      try {
        const keys = [];
        for (let i = 0; i < storage.length; i += 1) {
          const item = storage.key(i);
          if (item?.startsWith(`${PREFIX}${encodeURIComponent(namespace)}:`)) keys.push(item);
        }
        for (const item of keys) storage.removeItem(item);
      } catch { /* Storage may be disabled or full. */ }
    },
  };
}
