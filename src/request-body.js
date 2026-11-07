// Read a bounded byte stream before JSON.parse; Content-Length is optional and
// untrusted, so counting bytes remains necessary even when a header is present.
export async function readJsonObject(request, limit) {
  const fail = (message, status) => Object.assign(new Error(message), { status });
  if (!request.body) throw fail('Send a valid JSON object.', 400);
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw fail('Request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw fail('Send a valid JSON object.', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Send a valid JSON object.', 400);
  return data;
}
