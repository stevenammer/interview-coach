import { strFromU8, unzipSync } from 'fflate';
import { extractDocument } from './documents.js';

export const MAX_IMPORT_BYTES = 10_000_000;
const MAX_ODT_CONTENT_BYTES = 2_000_000;
const MAX_ODT_MIMETYPE_BYTES = 128;
const MAX_ODT_ENTRIES = 256;

const ODT_OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const ODT_TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const ODT_TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';

const childrenOf = (node) => Array.from(node?.childNodes ?? []);

const MIME_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
});

function extension(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function imageSignature(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

export async function classifyImportFile(file) {
  if (!file) throw new Error('Choose a file first.');
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a file under 10 MB.');
  const ext = extension(file.name);
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const signature = imageSignature(header);

  if (signature || /^image\/(png|jpeg|webp|heic|heif)$/i.test(file.type || '') ||
      /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) {
    return { kind: 'image', extension: signature || ext, mimeType: file.type || `image/${signature === 'jpg' ? 'jpeg' : signature || ext}` };
  }
  if (ext === 'csv' || file.type === 'text/csv') {
    if (!/^(profile|positions)\.csv$/i.test(file.name || '')) throw new Error('Choose LinkedIn Profile.csv or Positions.csv.');
    return { kind: 'csv', mimeType: MIME_TYPES.csv };
  }
  if (['pdf', 'docx', 'txt', 'md', 'rtf', 'odt'].includes(ext)) return { kind: ext, mimeType: MIME_TYPES[ext] };
  if (file.type === 'application/pdf') return { kind: 'pdf', mimeType: MIME_TYPES.pdf };
  if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return { kind: 'docx', mimeType: MIME_TYPES.docx };
  }
  if (['text/plain', 'text/markdown'].includes(file.type)) return { kind: file.type === 'text/markdown' ? 'md' : 'txt', mimeType: MIME_TYPES[file.type === 'text/markdown' ? 'md' : 'txt'] };
  if (['application/rtf', 'text/rtf'].includes(file.type)) return { kind: 'rtf', mimeType: MIME_TYPES.rtf };
  if (file.type === 'application/vnd.oasis.opendocument.text') return { kind: 'odt', mimeType: MIME_TYPES.odt };
  throw new Error('That file type cannot be read here. Paste the text, or choose PDF, Word, text, RTF, or ODT.');
}

function decodeText(bytes, label) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} must be saved as UTF-8 text.`); }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error('This file contains binary data. Save it as plain text or choose PDF/Word.');
  }
  return text;
}

const rtfDestinations = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr',
  'footer', 'footerl', 'footerr', 'datastore', 'xmlopen', 'xmlattr', 'listtable', 'listoverridetable',
  'generator', 'themedata', 'colorschememapping',
]);

function decodeRtf(raw) {
  if (!/^\s*\{\\rtf\d/i.test(raw)) throw new Error('This RTF file is malformed. Save it again as RTF or use PDF/Word.');
  const output = [];
  const stack = [{ skip: false, uc: 1, first: true }];
  let fallback = 0;
  const emit = (value) => { if (!stack.at(-1).skip && !fallback) output.push(value); };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const current = stack.at(-1);
    if (char === '{') {
      stack.push({ skip: current.skip, uc: current.uc, first: true });
      continue;
    }
    if (char === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (char === '\n' || char === '\r') continue;
    if (char === '\\') {
      const next = raw[index + 1];
      if (!next) continue;
      if (next === "'") {
        const hex = raw.slice(index + 2, index + 4);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          if (fallback) fallback -= 1;
          else emit(new TextDecoder('windows-1252').decode(Uint8Array.of(Number.parseInt(hex, 16))));
          index += 3;
        } else index += 1;
      } else if (next === '\\' || next === '{' || next === '}') {
        if (fallback) fallback -= 1;
        else emit(next);
        index += 1;
      } else if (next === '*') {
        if (current.first) current.skip = true;
        index += 1;
      } else {
        const match = raw.slice(index + 1).match(/^([a-z]+)(-?\d+)? ?/i);
        if (match) {
          const word = match[1].toLowerCase();
          const number = match[2] === undefined ? null : Number(match[2]);
          if (current.first && rtfDestinations.has(word)) current.skip = true;
          if (word === 'uc' && number !== null) current.uc = Math.max(0, Math.min(16, number));
          if (word === 'u' && number !== null && !current.skip) {
            emit(String.fromCharCode(number < 0 ? number + 65536 : number));
            fallback = current.uc;
          }
          if (!current.skip && ['par', 'line'].includes(word)) emit('\n');
          else if (!current.skip && word === 'tab') emit('\t');
          else if (!current.skip && word === 'emdash') emit('—');
          else if (!current.skip && word === 'endash') emit('–');
          index += match[0].length;
        } else {
          if (fallback) fallback -= 1;
          else if (next === '~') emit(' ');
          else if (next === '-') emit('');
          else if (next === '_') emit('‑');
          index += 1;
        }
      }
      current.first = false;
      continue;
    }
    if (current.first && !/\s/.test(char)) current.first = false;
    if (fallback) fallback -= 1;
    else if (!current.skip) emit(char);
  }
  const text = output.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('This RTF has no readable text. Paste the text instead.');
  return text;
}

const hiddenOdtNames = new Set([
  'annotation', 'annotation-end', 'script', 'scripts', 'hidden-text', 'hidden-paragraph',
  'deletion', 'deleted-text', 'tracked-changes', 'changed-region',
]);

function odtInlineText(node) {
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || '';
  if (node.nodeType !== 1 || node.namespaceURI !== ODT_TEXT_NS || hiddenOdtNames.has(node.localName)) return '';
  if (node.localName === 's') {
    const count = Number(node.getAttributeNS(ODT_TEXT_NS, 'c') || 1);
    if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error('This ODT has an invalid repeated-space run.');
    return ' '.repeat(count);
  }
  if (node.localName === 'tab') return '\t';
  if (node.localName === 'line-break') return '\n';
  return childrenOf(node).map(odtInlineText).join('');
}

function odtBlockText(node) {
  if (node.nodeType !== 1) return '';
  if (node.namespaceURI === ODT_OFFICE_NS && hiddenOdtNames.has(node.localName)) return '';
  if (node.namespaceURI === ODT_TEXT_NS) {
    if (hiddenOdtNames.has(node.localName)) return '';
    if (node.localName === 'p' || node.localName === 'h') return `${childrenOf(node).map(odtInlineText).join('')}\n`;
    if (['list', 'list-item', 'section', 'ordered-list', 'unordered-list'].includes(node.localName)) {
      return childrenOf(node).map(odtBlockText).join('');
    }
    return '';
  }
  if (node.namespaceURI === ODT_TABLE_NS) {
    if (node.localName === 'table-row') {
      const cells = childrenOf(node).filter((child) => child.nodeType === 1 && child.namespaceURI === ODT_TABLE_NS &&
        ['table-cell', 'covered-table-cell'].includes(child.localName));
      return `${cells.map((cell) => childrenOf(cell).map(odtBlockText).join('').replace(/\n+$/, '')).join('\t')}\n`;
    }
    return childrenOf(node).map(odtBlockText).join('');
  }
  return '';
}

function extractOdtText(xml, Parser = globalThis.DOMParser) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('This ODT uses unsupported XML declarations. Save it again or choose PDF/DOCX.');
  if (typeof Parser !== 'function') throw new Error('This browser cannot safely read ODT XML. Save as PDF or DOCX.');
  let document;
  try { document = new Parser().parseFromString(xml, 'application/xml'); }
  catch { throw new Error('This ODT contains malformed XML. Save it again or choose PDF/DOCX.'); }
  if (!document?.documentElement || document.getElementsByTagName?.('parsererror')?.length) {
    throw new Error('This ODT contains malformed XML. Save it again or choose PDF/DOCX.');
  }
  const root = document.documentElement;
  if (root.namespaceURI !== ODT_OFFICE_NS || root.localName !== 'document-content') {
    throw new Error('This ZIP is not a readable ODT document. Choose PDF or DOCX.');
  }
  const body = Array.from(root.getElementsByTagNameNS(ODT_OFFICE_NS, 'body'))[0];
  const officeText = body && childrenOf(body).find((node) => node.nodeType === 1 &&
    node.namespaceURI === ODT_OFFICE_NS && node.localName === 'text');
  if (!officeText) throw new Error('This ODT has no readable document text. Save it again or paste the text.');
  const text = childrenOf(officeText).map(odtBlockText).join('')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('This ODT has no readable document text. Save it again or paste the text.');
  return text;
}

function extractOdt(buffer, Parser = globalThis.DOMParser) {
  let entryCount = 0;
  const seenEntries = new Set();
  let oversizedContent = false;
  let oversizedMime = false;
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter(entry) {
        entryCount += 1;
        if (entryCount > MAX_ODT_ENTRIES) throw new Error('ODT archive has too many entries.');
        if (entry.name === 'content.xml') {
          if (seenEntries.has(entry.name)) throw new Error('Duplicate ODT content.xml entry.');
          seenEntries.add(entry.name);
          if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize > MAX_ODT_CONTENT_BYTES) {
            oversizedContent = true;
            return false;
          }
          return true;
        }
        if (entry.name === 'mimetype') {
          if (seenEntries.has(entry.name)) throw new Error('Duplicate ODT mimetype entry.');
          seenEntries.add(entry.name);
          if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize > MAX_ODT_MIMETYPE_BYTES) {
            oversizedMime = true;
            return false;
          }
          return true;
        }
        return false;
      },
    });
  } catch {
    throw new Error('This ODT ZIP is damaged, encrypted, or unsupported. Save it again or choose PDF/DOCX.');
  }
  if (oversizedContent) throw new Error('ODT content.xml exceeds the 2 MB safe limit. Save as PDF/DOCX.');
  if (oversizedMime) throw new Error('This ODT has an invalid mimetype entry. Save it again or choose PDF/DOCX.');
  const mimetype = files.mimetype && strFromU8(files.mimetype).trim();
  if (mimetype !== MIME_TYPES.odt) throw new Error('This ZIP is not an OpenDocument text file. Choose PDF or DOCX.');
  const content = files['content.xml'];
  if (!content) throw new Error('This ODT is missing content.xml. Save it again or paste the text.');
  if (content.byteLength > MAX_ODT_CONTENT_BYTES) throw new Error('ODT content.xml exceeds the 2 MB safe limit. Save as PDF/DOCX.');
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(content); }
  catch { throw new Error('This ODT has unreadable XML text. Save it again or choose PDF/DOCX.'); }
  return extractOdtText(xml, Parser);
}

export async function extractImportDocument(file, options = {}) {
  const { kind, mimeType } = await classifyImportFile(file);
  if (kind === 'image') throw new Error('Choose a document, or upload screenshots in the resume/job description box.');
  if (['pdf', 'docx', 'csv'].includes(kind)) return extractDocument(file, options);
  const buffer = await file.arrayBuffer();
  if (kind === 'odt') return { text: extractOdt(buffer, options.DOMParser), pageOffsets: [], sectionLabel: 'ODT body', mimeType };
  const raw = decodeText(new Uint8Array(buffer), kind.toUpperCase());
  const text = kind === 'rtf' ? decodeRtf(raw) : raw.trim();
  if (!text) throw new Error(`This ${kind.toUpperCase()} file is empty. Paste the text instead.`);
  return { text, pageOffsets: [], sectionLabel: kind === 'rtf' ? 'RTF body' : `${kind.toUpperCase()} text`, mimeType };
}
