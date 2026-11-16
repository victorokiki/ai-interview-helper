// Exports career documents to PDF and Word.
//   PDF:  the renderer sends sanitized HTML; it is printed by Chromium in a
//         hidden window with JavaScript disabled (webContents.printToPDF).
//   Word: a small Markdown → DOCX converter (headings, paragraphs, bullet and
//         numbered lists, bold, italic, links) built on the `docx` package (MIT).
const { BrowserWindow } = require('electron');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = require('docx');

const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  body { font: 10.5pt/1.45 'Segoe UI', Arial, sans-serif; color: #111; }
  h1 { font-size: 19pt; margin: 0 0 4px; } h2 { font-size: 12.5pt; margin: 14px 0 4px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
  h3 { font-size: 11pt; margin: 10px 0 2px; } p { margin: 0 0 7px; } ul, ol { margin: 0 0 7px; padding-left: 18px; } li { margin: 1px 0; }
  a { color: #1a4fd6; text-decoration: none; } code { font-family: Consolas, monospace; }`;

async function toPdf(html) {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>${html}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: false, margins: { marginType: 'default' } });
  } finally {
    win.destroy();
  }
}

// Inline Markdown → runs: **bold**, *italic* / _italic_, [text](url).
function inlineRuns(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun(text.slice(last, m.index)));
    if (m[1]) out.push(new TextRun({ text: m[2], bold: true }));
    else if (m[3]) out.push(new ExternalHyperlink({ link: m[5], children: [new TextRun({ text: m[4], style: 'Hyperlink' })] }));
    else out.push(new TextRun({ text: m[7] || m[8], italics: true }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(new TextRun(text.slice(last)));
  return out.length ? out : [new TextRun('')];
}

function markdownToParagraphs(markdown) {
  const paragraphs = [];
  const headings = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
  let buffer = [];
  const flush = () => {
    if (buffer.length) paragraphs.push(new Paragraph({ children: inlineRuns(buffer.join(' ')), spacing: { after: 120 } }));
    buffer = [];
  };
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) flush();
    else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      paragraphs.push(new Paragraph({ heading: headings[m[1].length], children: inlineRuns(m[2]) }));
    } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      flush();
      paragraphs.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(m[1]) }));
    } else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
      flush();
      paragraphs.push(new Paragraph({ children: [new TextRun(`${m[1]}. `), ...inlineRuns(m[2])] }));
    } else buffer.push(line.trim());
  }
  flush();
  return paragraphs;
}

async function toDocx(markdown, title = '') {
  const doc = new Document({
    creator: 'Interview Helper',
    title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: markdownToParagraphs(markdown) }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { toPdf, toDocx, markdownToParagraphs, inlineRuns };
