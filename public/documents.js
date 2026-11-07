import { Unzip, UnzipInflate, zipSync } from 'fflate';

export const MAX_EXTRACTED_CHARS = 200_000;

export function validateImportXml(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Document XML declarations are unsupported.');
  let depth = 0, nodes = 0;
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  for (const match of xml.matchAll(tags)) {
    const tag = match[0];
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    if (tag.startsWith('</')) { depth -= 1; continue; }
    nodes += 1;
    if (nodes > 50_000) throw new Error('Document XML has too many elements.');
    if (!tag.endsWith('/>')) depth += 1;
    if (depth > 128) throw new Error('Document XML is nested too deeply.');
  }
}

// Stream small compressed chunks so dishonest ZIP size headers cannot trigger an
// unbounded inflate before an output-size check. Return only selected entries.
export function boundedDocumentZip(buffer, { select = () => true, maxEntryBytes = 5_000_000,
  maxTotalBytes = 20_000_000 } = {}) {
  const files = Object.create(null), names = new Set();
  let total = 0, completed = 0, selected = 0;
  const unzip = new Unzip((entry) => {
    if (names.size >= 256 || names.has(entry.name) || entry.name.length > 512 ||
        /(?:^|\/)\.\.(?:\/|$)|[\\\0]|^\//.test(entry.name)) throw new Error('Invalid or excessive ZIP entries.');
    names.add(entry.name);
    if (!select(entry.name)) return;
    selected += 1;
    const limit = typeof maxEntryBytes === 'function' ? maxEntryBytes(entry.name) : maxEntryBytes;
    if (entry.originalSize !== undefined && (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > limit)) {
      throw new Error('Document ZIP entry exceeds its safe size limit.');
    }
    let size = 0; const chunks = [];
    entry.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.byteLength; total += data.byteLength;
      if (size > limit || total > maxTotalBytes) throw new Error('Document ZIP exceeds its safe expanded size limit.');
      chunks.push(data);
      if (final) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        files[entry.name] = bytes; completed += 1;
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Document ZIP is damaged or unsupported.');
  for (let offset = 0; offset < bytes.length; offset += 256) unzip.push(bytes.subarray(offset, offset + 256), offset + 256 >= bytes.length);
  if (!selected || completed !== selected) throw new Error('Document ZIP is incomplete.');
  return files;
}

function boundedText(text) {
  if (text.length > MAX_EXTRACTED_CHARS) throw new Error('Document text exceeds the 200,000 character safe limit.');
  return text;
}

function sanitizeDocx(buffer) {
  const files = boundedDocumentZip(buffer);
  if (!files['[Content_Types].xml'] || !files['word/document.xml']) throw new Error('This ZIP is not a readable DOCX file.');
  for (const [name, bytes] of Object.entries(files)) if (/\.(?:xml|rels)$/i.test(name)) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validateImportXml(xml);
  }
  // Feed mammoth a new stored archive: it cannot trust the original archive's
  // possibly dishonest expansion metadata or inflate the same payload again.
  return zipSync(files, { level: 0 }).buffer;
}

export async function extractDocument(file, { pdfModule, mammoth } = {}) {
  if (!file || file.size > 10000000) throw new Error('Choose a file under 10 MB.');
  const name = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  if (name.endsWith('.csv')) {
    if (!/^(profile|positions)\.csv$/.test(name)) {
      throw new Error('Choose LinkedIn Profile.csv or Positions.csv.');
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === '"') {
        if (quoted && raw[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === ',' && !quoted) {
        if (row.length >= 50) throw new Error('This CSV has too many columns.');
        row.push(field); field = '';
      }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && raw[index + 1] === '\n') index += 1;
        if (rows.length >= 501 || row.length >= 50) throw new Error('This CSV is empty or too large.');
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        if (field.length >= MAX_EXTRACTED_CHARS) throw new Error('CSV field exceeds its safe text limit.');
        field += char;
      }
    }
    if (quoted) throw new Error('This CSV has an unfinished quoted field.');
    if (field || row.length) { row.push(field); rows.push(row); }
    const headers = rows.shift()?.map((value) => value.trim());
    if (!headers?.length || rows.length > 500 || headers.length > 50) throw new Error('This CSV is empty or too large.');
    let text = '';
    for (const [index, values] of rows.entries()) {
      const line = `Row ${index + 2}: ${headers.map((header, column) => `${header}: ${values[column] ?? ''}`).join('; ')}`;
      if (text.length + line.length + 1 > MAX_EXTRACTED_CHARS) throw new Error('CSV text exceeds its safe text limit.');
      text += `${index ? '\n' : ''}${line}`;
    }
    if (!text.trim()) throw new Error('This CSV has no profile rows.');
    return { text, pageOffsets: [], sectionLabel: name, mimeType: 'text/csv' };
  }
  if (name.endsWith('.pdf')) {
    const pdf = pdfModule ?? await import('/vendor/pdf.mjs');
    pdf.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    const document = await pdf.getDocument({ data: buffer, isEvalSupported: false }).promise;
    const pages = [];
    try {
      if (document.numPages > 30) throw new Error('PDFs are limited to 30 pages.');
      let totalText = 0;
      for (let page = 1; page <= document.numPages; page += 1) {
        const content = await (await document.getPage(page)).getTextContent();
        let pageText = '';
        for (const item of content.items) {
          const part = typeof item.str === 'string' ? item.str : '';
          totalText += part.length + 1;
          if (totalText > MAX_EXTRACTED_CHARS) throw new Error('PDF text exceeds its safe text limit.');
          pageText += `${pageText ? ' ' : ''}${part}`;
        }
        pages.push(pageText.trim());
      }
    } finally { await document.destroy?.(); }
    const pageOffsets = [];
    let text = '';
    for (const [index, page] of pages.entries()) {
      if (index) text += '\n';
      pageOffsets.push(text.length);
      text += page;
    }
    if (text.trim().length < 30) throw new Error('This PDF has no readable text. Use Save to PDF or paste its text.');
    return { text, pageOffsets, mimeType: 'application/pdf' };
  }
  if (name.endsWith('.docx')) {
    const parser = mammoth ?? globalThis.mammoth;
    if (!parser) throw new Error('DOCX parser is unavailable. Paste the text instead.');
    const safeBuffer = sanitizeDocx(buffer);
    const result = await parser.extractRawText({ arrayBuffer: safeBuffer });
    if (!result.value?.trim()) throw new Error('This DOCX has no readable text. Paste its text instead.');
    return { text: boundedText(result.value.trim()), pageOffsets: [], sectionLabel: 'DOCX body',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  throw new Error('Choose a PDF or DOCX file.');
}
