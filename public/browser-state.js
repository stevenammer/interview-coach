// Browser storage is untrusted and may contain an interrupted write or an old format.
export function readStoredObject(storage, key, fallback = null, valid = () => true) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !valid(value)) {
      storage.removeItem(key);
      return fallback;
    }
    return value;
  } catch {
    try { storage.removeItem(key); } catch { /* Storage can also be unavailable. */ }
    return fallback;
  }
}

const guestLists = ['sources', 'workspaces', 'facts', 'interviews', 'turns', 'debriefs',
  'events', 'requirements', 'rewriteSlots', 'storyDigs', 'drillCards', 'drillReviews',
  'realInterviews', 'factGateDecisions', 'immersions', 'factConflictReviews', 'jobHuntHistory'];
export function readGuestState(storage, key) {
  return readStoredObject(storage, key, null, (value) => guestLists.every((name) =>
    value[name] === undefined || Array.isArray(value[name]) && value[name].every((item) =>
      item && typeof item === 'object' && !Array.isArray(item))));
}

export function originalExtension(mimeType) {
  return ({ 'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/csv': 'csv', 'text/plain': 'txt', 'text/markdown': 'md', 'application/rtf': 'rtf',
    'application/vnd.oasis.opendocument.text': 'odt' })[mimeType] ?? 'bin';
}

// datetime-local inputs have no timezone; display in the visitor's local clock.
export function dateTimeInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return '';
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
