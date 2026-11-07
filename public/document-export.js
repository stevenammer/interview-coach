import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const FONT_FILES = {
  'Noto Sans': ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'],
  'Noto Serif': ['NotoSerif-Regular.ttf', 'NotoSerif-Bold.ttf'],
  'Noto Sans Mono': ['NotoSansMono-Regular.ttf', 'NotoSansMono-Bold.ttf'],
};
const COLORS = {
  teal: '116466', navy: '24466A', plum: '66547F', slate: '46545C',
};

export const documentThemes = Object.freeze({ ...COLORS });
export const documentFonts = Object.freeze(Object.keys(FONT_FILES));

function linesOf(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function isHeading(line, index, lines) {
  const value = line.trim();
  if (!value || value.startsWith('•') || value.startsWith('- ')) return false;
  return value.length <= 64 && !/[.!?]$/.test(value) &&
    (index === 0 || lines[index - 1] === '' || /^[A-Z][A-Za-z &'/-]+$/.test(value));
}

export async function createDocx(text, { font = 'Noto Sans', color = 'teal', title = 'Interview Coach document' } = {}) {
  const accent = COLORS[color] ?? COLORS.teal;
  const family = FONT_FILES[font] ? font : 'Noto Sans';
  const lines = linesOf(text);
  const children = lines.map((line, index) => {
    if (!line) return new Paragraph({ children: [], spacing: { after: 120 } });
    const heading = isHeading(line, index, lines);
    return new Paragraph({
      heading: heading ? HeadingLevel.HEADING_1 : undefined,
      keepNext: heading,
      spacing: { before: heading ? 180 : 0, after: heading ? 80 : 120 },
      children: [new TextRun({ text: line, font: family, size: heading ? 26 : 22, bold: heading, color: heading ? accent : '242B2E' })],
    });
  });
  const document = new Document({
    creator: 'Interview Coach', title, subject: 'Editable résumé or cover letter',
    styles: { default: { document: { run: { font: family, size: 22, color: '242B2E' } } } },
    sections: [{ properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children }],
  });
  return Packer.toBlob(document);
}

async function loadFonts(font) {
  const files = FONT_FILES[font] ?? FONT_FILES['Noto Sans'];
  const [regularResponse, boldResponse] = await Promise.all(files.map((file) => fetch(`/vendor/${file}`)));
  if (!regularResponse.ok || !boldResponse.ok) throw new Error('The document font could not be loaded. Try again.');
  return [new Uint8Array(await regularResponse.arrayBuffer()), new Uint8Array(await boldResponse.arrayBuffer())];
}

function wrappedLines(line, font, size, width) {
  if (!line) return [''];
  const words = line.split(/\s+/);
  const result = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      result.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) result.push(current);
  return result;
}

export async function createPdf(text, { font = 'Noto Sans', color = 'teal', title = 'Interview Coach document', fontBytes } = {}) {
  const family = FONT_FILES[font] ? font : 'Noto Sans';
  const [regularBytes, boldBytes] = fontBytes ?? await loadFonts(family);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regular, bold] = await Promise.all([
    pdf.embedFont(regularBytes, { subset: true }),
    pdf.embedFont(boldBytes, { subset: true }),
  ]);
  pdf.setTitle(title);
  pdf.setAuthor('Interview Coach');
  pdf.setCreator('Interview Coach document editor');
  pdf.setSubject('Editable résumé or cover letter');

  const hex = COLORS[color] ?? COLORS.teal;
  const accent = rgb(...[0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255));
  const ink = rgb(0.14, 0.17, 0.18);
  const pageSize = [612, 792];
  const margin = 54;
  const width = pageSize[0] - margin * 2;
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;
  const lines = linesOf(text);
  let previousBlank = false;
  lines.forEach((line, index) => {
    if (!line) {
      if (!previousBlank) y -= 5;
      previousBlank = true;
      if (y < margin + 20) { page = pdf.addPage(pageSize); y = pageSize[1] - margin; }
      return;
    }
    previousBlank = false;
    const heading = isHeading(line, index, lines);
    const size = heading ? 13 : 10.5;
    const chosenFont = heading ? bold : regular;
    const colorChoice = heading ? accent : ink;
    for (const part of wrappedLines(line, chosenFont, size, width)) {
      const lineHeight = size * 1.38;
      if (y - lineHeight < margin) { page = pdf.addPage(pageSize); y = pageSize[1] - margin; }
      page.drawText(part, { x: margin, y: y - size, size, font: chosenFont, color: colorChoice });
      y -= lineHeight;
    }
    if (heading) y -= 1;
  });
  return pdf.save();
}

export function documentFilename(kind, extension) {
  return `interview-coach-${kind === 'cover_letter' ? 'cover-letter' : 'resume'}.${extension}`;
}

export function downloadBytes(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
