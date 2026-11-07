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
      } else if (char === ',' && !quoted) { row.push(field); field = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && raw[index + 1] === '\n') index += 1;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += char;
    }
    if (quoted) throw new Error('This CSV has an unfinished quoted field.');
    if (field || row.length) { row.push(field); rows.push(row); }
    const headers = rows.shift()?.map((value) => value.trim());
    if (!headers?.length || rows.length > 500 || headers.length > 50) throw new Error('This CSV is empty or too large.');
    const text = rows.map((values, index) => `Row ${index + 2}: ${headers.map((header, column) =>
      `${header}: ${values[column] ?? ''}`).join('; ')}`).join('\n');
    if (!text.trim()) throw new Error('This CSV has no profile rows.');
    return { text, pageOffsets: [], sectionLabel: name, mimeType: 'text/csv' };
  }
  if (name.endsWith('.pdf')) {
    const pdf = pdfModule ?? await import('/vendor/pdf.mjs');
    pdf.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    const document = await pdf.getDocument({ data: buffer, isEvalSupported: false }).promise;
    if (document.numPages > 30) throw new Error('PDFs are limited to 30 pages.');
    const pages = [];
    for (let page = 1; page <= document.numPages; page += 1) {
      const content = await (await document.getPage(page)).getTextContent();
      pages.push(content.items.map((item) => item.str || '').join(' ').trim());
    }
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
    const result = await parser.extractRawText({ arrayBuffer: buffer });
    if (!result.value?.trim()) throw new Error('This DOCX has no readable text. Paste its text instead.');
    return { text: result.value.trim(), pageOffsets: [], sectionLabel: 'DOCX body',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  throw new Error('Choose a PDF or DOCX file.');
}
