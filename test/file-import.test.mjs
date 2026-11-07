import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { DOMParser as XmlDOMParser } from '@xmldom/xmldom';
import { classifyImportFile, extractImportDocument } from '../public/file-import.js';

function file(name, bytes, type = '') {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  return {
    name, size: data.byteLength, type,
    slice(start = 0, end = data.byteLength) { return new Blob([data.slice(start, end)]); },
    async arrayBuffer() { return data.slice().buffer; },
  };
}

test('imports UTF-8 text and safely extracts readable RTF text', async () => {
  const text = await extractImportDocument(file('resume.md', '\uFEFFJordan Lee\r\nManaged a team of 8.'));
  assert.equal(text.text, 'Jordan Lee\nManaged a team of 8.');
  assert.equal(text.mimeType, 'text/markdown');

  const rtf = await extractImportDocument(file('resume.rtf', String.raw`{\rtf1\ansi\deff0 {\fonttbl{\f0 Arial;}}Jordan Lee\par Managed \b a team\b0  of 8.\par \u9733?}`));
  assert.equal(rtf.text, 'Jordan Lee\nManaged a team of 8.\n★');
  assert.equal(rtf.sectionLabel, 'RTF body');
});

const officeNs = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const textNs = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const tableNs = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const odtMime = 'application/vnd.oasis.opendocument.text';

function odtFile(contentXml, mimetype = odtMime, extraEntries = {}) {
  return file('resume.odt', zipSync({ mimetype: strToU8(mimetype), 'content.xml': strToU8(contentXml), ...extraEntries }));
}

class StrictDOMParser {
  parseFromString(xml, type) {
    let parseError = false;
    const parser = new XmlDOMParser({ errorHandler: {
      warning() { parseError = true; }, error() { parseError = true; }, fatalError() { parseError = true; },
    } });
    const document = parser.parseFromString(xml, type);
    if (parseError) return { documentElement: null };
    return document;
  }
}

test('extracts visible Unicode paragraphs and table cells from ODT while skipping hidden content', async () => {
  const xml = `<?xml version="1.0"?><office:document-content xmlns:office="${officeNs}" xmlns:text="${textNs}" xmlns:table="${tableNs}" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:text><text:h>Zoë &amp; team</text:h><text:p>Raised<text:s text:c="2"/>quality<text:tab/>4x<text:line-break/>Today <text:span>worked together</text:span>.</text:p><office:annotation><text:p>private comment</text:p></office:annotation><office:scripts><office:script>ignored()</office:script></office:scripts><text:hidden-text>hidden</text:hidden-text><draw:frame><draw:text-box><text:p>alternate text</text:p></draw:text-box></draw:frame><table:table><table:table-row><table:table-cell><text:p>Left</text:p></table:table-cell><table:table-cell><text:p>Right</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>`;
  const parsed = await extractImportDocument(odtFile(xml, odtMime, {
    'Pictures/portrait.png': strToU8('ignored image payload'),
    'Scripts/script.js': strToU8('ignored script payload'),
  }), { DOMParser: StrictDOMParser });
  assert.equal(parsed.text, 'Zoë & team\nRaised  quality\t4x\nToday worked together.\nLeft\tRight');
  assert.equal(parsed.sectionLabel, 'ODT body');
  assert.equal(parsed.mimeType, odtMime);
});

test('rejects non-ZIP, wrong mimetype, malformed XML, and oversized ODT content before parsing', async () => {
  await assert.rejects(extractImportDocument(file('bad.odt', 'not a zip')), /damaged, encrypted, or unsupported/);
  await assert.rejects(extractImportDocument(odtFile('<office:document-content/>', 'application/zip')), /not an OpenDocument text file/);
  const malformed = `<office:document-content xmlns:office="${officeNs}" xmlns:text="${textNs}"><office:body><office:text><text:p>broken</office:text></office:body></office:document-content>`;
  await assert.rejects(extractImportDocument(odtFile(malformed), { DOMParser: StrictDOMParser }), /malformed XML/);
  const declared = `<!DOCTYPE office:document-content [<!ENTITY x SYSTEM "https://example.invalid/">]><office:document-content xmlns:office="${officeNs}"/>`;
  await assert.rejects(extractImportDocument(odtFile(declared)), /XML declarations/);
  const oversized = `<office:document-content xmlns:office="${officeNs}"><office:body><office:text>${'x'.repeat(2_000_001)}</office:text></office:body></office:document-content>`;
  await assert.rejects(extractImportDocument(odtFile(oversized)), /2 MB safe limit/);
});

test('checks actual inflated ODT content length even if ZIP metadata understates it', async () => {
  const oversized = `<office:document-content xmlns:office="${officeNs}"><office:body><office:text>${'x'.repeat(2_000_001)}</office:text></office:body></office:document-content>`;
  const archive = zipSync({
    mimetype: [strToU8(odtMime), { level: 0 }],
    'content.xml': [strToU8(oversized), { level: 0 }],
  });
  const name = new TextEncoder().encode('content.xml');
  let metadataPatched = false;
  for (let index = 0; index + 46 + name.length < archive.length; index += 1) {
    if (archive[index] !== 0x50 || archive[index + 1] !== 0x4b || archive[index + 2] !== 0x01 || archive[index + 3] !== 0x02) continue;
    const nameLength = archive[index + 28] | (archive[index + 29] << 8);
    if (nameLength !== name.length || !name.every((byte, offset) => archive[index + 46 + offset] === byte)) continue;
    new DataView(archive.buffer, archive.byteOffset + index).setUint32(24, 1, true);
    metadataPatched = true;
    break;
  }
  assert.equal(metadataPatched, true);
  await assert.rejects(extractImportDocument(file('understated.odt', archive)), /2 MB safe limit/);
});

test('recognizes a blank-MIME PNG by signature and rejects binary disguised as text', async () => {
  const png = file('photo.png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  assert.equal((await classifyImportFile(png)).kind, 'image');
  await assert.rejects(extractImportDocument(file('resume.txt', Uint8Array.of(0x41, 0, 0x42))), /binary data/);
  await assert.rejects(classifyImportFile(file('resume.txt', new Uint8Array(10_000_001))), /under 10 MB/);
  await assert.rejects(classifyImportFile(file('upload.bin', 'bytes')), /cannot be read/);
});


test('ODT repeated spaces have an aggregate expansion budget before allocation', async () => {
  const xml = `<office:document-content xmlns:office="${officeNs}" xmlns:text="${textNs}"><office:body><office:text><text:p>Visible${'<text:s text:c="10000"/>'.repeat(21)}</text:p></office:text></office:body></office:document-content>`;
  await assert.rejects(extractImportDocument(odtFile(xml), { DOMParser: StrictDOMParser }), /safe expanded text limit/);
});

test('ODT deeply nested text is rejected before the XML parser runs', async () => {
  let parsed = false;
  class MustNotParse { parseFromString() { parsed = true; throw new Error('should not parse'); } }
  const xml = `<office:document-content xmlns:office="${officeNs}" xmlns:text="${textNs}"><office:body><office:text><text:p>${'<text:span>'.repeat(130)}Text${'</text:span>'.repeat(130)}</text:p></office:text></office:body></office:document-content>`;
  await assert.rejects(extractImportDocument(odtFile(xml), { DOMParser: MustNotParse }), /nested too deeply/);
  assert.equal(parsed, false);
});
