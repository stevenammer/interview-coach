import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { createDocx, createPdf } from '../public/document-export.js';

const text = 'Renée Björk\n\nExperience\n• Led a café team and raised résumé completion by 18%.\n\nEducation\nÉcole de Montréal';
const fonts = await Promise.all([
  readFile(new URL('../public/vendor/NotoSans-Regular.ttf', import.meta.url)),
  readFile(new URL('../public/vendor/NotoSans-Bold.ttf', import.meta.url)),
]);

test('DOCX is a readable OOXML document with the chosen font, accent, and exact Unicode text', async () => {
  const blob = await createDocx(text, { font: 'Noto Serif', color: 'navy', title: 'Résumé test' });
  const bytes = Buffer.from(await blob.arrayBuffer());
  const result = await mammoth.extractRawText({ buffer: bytes });
  for (const content of ['Renée Björk', 'Led a café team', 'résumé completion', 'École de Montréal']) assert.ok(result.value.includes(content));
  assert.match(result.value, /18%/);
  assert.match(result.value, /•/);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Noto Serif/);
  assert.match(xml, /24466A/);
});

test('PDF has real text, Unicode glyphs, chosen accent, and document metadata', async () => {
  const bytes = await createPdf(text, { font: 'Noto Sans', color: 'plum', title: 'Résumé test', fontBytes: fonts });
  const saved = await PDFDocument.load(bytes);
  assert.equal(saved.getTitle(), 'Résumé test');
  assert.equal(saved.getAuthor(), 'Interview Coach');
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
  let extracted = '';
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    extracted += content.items.map((item) => item.str).join(' ');
  }
  for (const content of ['Renée Björk', 'café team', 'résumé completion', 'École de Montréal']) assert.ok(extracted.includes(content), `${content} appears in selectable PDF text`);
  assert.match(extracted, /18%/);
  assert.match(extracted, /•/);
});
