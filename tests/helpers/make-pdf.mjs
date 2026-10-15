// tests/helpers/make-pdf.mjs
//
// Builds a minimal, spec-valid PDF (one page per entry) with real, extractable Helvetica text.
// Offsets are computed while assembling the file so the xref table stays correct — no PDF library
// needed and the fixture is deterministic.
//
// Text is laid out the way a real PDF would be: 12pt, wrapped to 78-character lines inside the
// 612x792 page box. pdf.js stops extracting text that runs past the page, so a single long
// unwrapped line would silently lose its tail and make every assertion misleading.

const FONT_SIZE = 12;
const LINE_CHARS = 78;

function contentStream(text) {
  const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const lines = String(text)
    .split('\n')
    .flatMap((line) => line.match(new RegExp(`.{1,${LINE_CHARS}}`, 'g')) || ['']);
  const ops =
    `BT /F1 ${FONT_SIZE} Tf 72 720 Td 14 TL\n` +
    lines.map((line) => `(${escape(line)}) Tj T*`).join('\n') +
    '\nET';
  return `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
}

export function makePdf(pages = ['Hello from page one.']) {
  const pageNums = [];
  const contentNums = [];
  pages.forEach((_, i) => {
    pageNums.push(4 + i * 2);
    contentNums.push(5 + i * 2);
  });

  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  pages.forEach((text, i) => {
    objs[pageNums[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNums[i]} 0 R >>`;
    objs[contentNums[i]] = contentStream(text);
  });

  let pdf = '%PDF-1.7\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
