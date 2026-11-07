import test from 'node:test';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import { Document, Packer, Paragraph } from 'docx';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { boundedDocumentZip, extractDocument } from '../public/documents.js';

const file = (name, bytes) => ({ name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });

test('ZIP output budgets apply to actual inflation even with dishonest size metadata', () => {
  const bytes = zipSync({ 'content.xml': strToU8('x'.repeat(2048)) });
  const view = new DataView(bytes.buffer);
  // Corrupt uncompressed-size fields in both local and central headers.
  for (let i = 0; i + 28 < bytes.length; i++) {
    const magic = view.getUint32(i, true);
    if (magic === 0x04034b50) view.setUint32(i + 22, 1, true);
    if (magic === 0x02014b50) view.setUint32(i + 24, 1, true);
  }
  assert.throws(() => boundedDocumentZip(bytes.buffer, { maxEntryBytes: 1024, maxTotalBytes: 1024 }), /safe.*size limit/);
});

test('ZIP aggregate output, path and entry-count budgets reject before document parsing', () => {
  const archive = zipSync({ a: strToU8('a'.repeat(512)), b: strToU8('b'.repeat(512)) });
  assert.throws(() => boundedDocumentZip(archive.buffer, { maxEntryBytes: 600, maxTotalBytes: 1000 }), /safe.*size limit/);
  assert.throws(() => boundedDocumentZip(zipSync({ '../private': strToU8('x') }).buffer), /ZIP entries/);
  const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`entry-${i}`, strToU8('x')]));
  assert.throws(() => boundedDocumentZip(zipSync(many).buffer), /ZIP entries/);
});

test('DOCX parser receives a reconstructed bounded archive; unsafe XML never reaches it', async () => {
  const contents = { '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<document>Safe words</document>') };
  let calls = 0;
  const mammoth = { async extractRawText({ arrayBuffer }) {
    calls++;
    const files = unzipSync(new Uint8Array(arrayBuffer));
    assert.deepEqual(files['word/document.xml'], contents['word/document.xml']);
    return { value: 'Safe words' };
  } };
  const result = await extractDocument(file('resume.docx', zipSync(contents)), { mammoth });
  assert.equal(result.text, 'Safe words');
  assert.equal(calls, 1);
  await assert.rejects(extractDocument(file('resume.docx', zipSync({ ...contents,
    'word/document.xml': strToU8('<document>' + '<node>'.repeat(130) + 'x' + '</node>'.repeat(130) + '</document>') })), { mammoth }), /nested too deeply/);
  assert.equal(calls, 1);
  await assert.rejects(extractDocument(file('resume.docx', strToU8('not a zip')), { mammoth }), /ZIP/);
  assert.equal(calls, 1);
});

test('PDF worker is released on page-limit and oversized-text rejection', async () => {
  for (const numPages of [31, 1]) {
    let destroyed = false;
    const pdfModule = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages,
      async getPage() { return { async getTextContent() { return { items: [{ str: 'x'.repeat(200001) }] }; } }; },
      async destroy() { destroyed = true; } }) }) };
    await assert.rejects(extractDocument(file('resume.pdf', new Uint8Array(1)), { pdfModule }), /limited|safe text limit/);
    assert.equal(destroyed, true);
  }
});

test('CSV header repetition cannot amplify a small file beyond the extracted-text budget', async () => {
  const csv = 'Header' + 'x'.repeat(1000) + '\n' + 'value\n'.repeat(250);
  await assert.rejects(extractDocument(file('Profile.csv', strToU8(csv))), /safe text limit/);
});


test('ordinary generated DOCX retains exact Unicode text through bounded archive reconstruction', async () => {
  const text = 'Renée coached eight café staff.';
  const bytes = new Uint8Array(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] })));
  const parser = { extractRawText: ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) }) };
  const result = await extractDocument(file('resume.docx', bytes), { mammoth: parser });
  assert.equal(result.text, text);
});
