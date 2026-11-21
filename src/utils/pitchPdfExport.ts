import html2canvas from 'html2canvas-pro';
import { toCanvas } from 'html-to-image';
import { sanitizeAssetSlug } from './mockupAssetZip';

export type PitchPdfPageFormat = 'a4' | 'letter';

export interface PitchPdfExportOptions {
  brandName: string;
  title?: string;
  author?: string;
  pageFormat?: PitchPdfPageFormat;
  pixelScale?: 2 | 3;
}

export interface PitchPdfExportResult {
  filename: string;
  sizeKb: number;
  pageFormat: PitchPdfPageFormat;
  pageDimensionsPt: {
    width: number;
    height: number;
  };
  pixelDimensions: {
    width: number;
    height: number;
  };
}

const PAGE_SPECS_PT: Record<
  PitchPdfPageFormat,
  { width: number; height: number; margin: number }
> = {
  a4: {
    width: 595.28,
    height: 841.89,
    margin: 20,
  },
  letter: {
    width: 612,
    height: 792,
    margin: 20,
  },
};

function escapePdfLiteralString(input: string): string {
  return input
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .trim();
}

function formatPdfTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate()
  )}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds()
  )}Z`;
}

function decodeBase64JpegDataUrl(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('Invalid JPEG data URL generated during PDF export.');
  }
  const base64Payload = dataUrl.slice(commaIdx + 1).replace(/\s+/g, '');
  const binary = atob(base64Payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Wraps a high-DPI RGB JPEG byte buffer into a standards-compliant, single-page
 * PDF 1.4 binary document fitted cleanly within the target A4 or US Letter MediaBox.
 */
function buildSinglePageJpegPdfBytes(params: {
  jpegBytes: Uint8Array;
  imgWidthPx: number;
  imgHeightPx: number;
  pageFormat: PitchPdfPageFormat;
  title: string;
  author: string;
}): {
  pdfBytes: Uint8Array;
  widthPt: number;
  heightPt: number;
} {
  const { jpegBytes, imgWidthPx, imgHeightPx, pageFormat, title, author } = params;
  const spec = PAGE_SPECS_PT[pageFormat];
  const widthPt = spec.width;
  const heightPt = spec.height;
  const marginPt = spec.margin;

  const availW = widthPt - marginPt * 2;
  const availH = heightPt - marginPt * 2;
  const imgAspect = imgWidthPx / Math.max(1, imgHeightPx);

  let drawW = availW;
  let drawH = drawW / imgAspect;
  if (drawH > availH) {
    drawH = availH;
    drawW = drawH * imgAspect;
  }

  const offsetX = (widthPt - drawW) / 2;
  const offsetY = heightPt - marginPt - drawH;

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let byteCursor = 0;

  const pushAscii = (str: string) => {
    const encoded = encoder.encode(str);
    chunks.push(encoded);
    byteCursor += encoded.byteLength;
  };

  const pushRaw = (bytes: Uint8Array) => {
    chunks.push(bytes);
    byteCursor += bytes.byteLength;
  };

  const objectOffsets: number[] = [0];

  // PDF 1.4 Header + 4-byte high-bit binary comment marker per ISO 32000
  pushAscii('%PDF-1.4\n');
  pushRaw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object 1: Document Catalog
  objectOffsets[1] = byteCursor;
  pushAscii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Object 2: Single-Page Pages Tree
  objectOffsets[2] = byteCursor;
  pushAscii('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // Object 3: Page Dictionary
  objectOffsets[3] = byteCursor;
  pushAscii(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(
      2
    )} ${heightPt.toFixed(
      2
    )}] /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
  );

  // Object 4: High-DPI RGB JPEG XObject
  objectOffsets[4] = byteCursor;
  pushAscii(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgWidthPx} /Height ${imgHeightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`
  );
  pushRaw(jpegBytes);
  pushAscii('\nendstream\nendobj\n');

  // Object 5: Page Content Stream (paint white sheet & place scaled image)
  const contentStreamText = [
    'q',
    '1 1 1 rg',
    `0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)} re f`,
    `${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${offsetX.toFixed(
      2
    )} ${offsetY.toFixed(2)} cm`,
    '/Im0 Do',
    'Q',
    '',
  ].join('\n');
  const contentStreamBytes = encoder.encode(contentStreamText);

  objectOffsets[5] = byteCursor;
  pushAscii(`5 0 obj\n<< /Length ${contentStreamBytes.byteLength} >>\nstream\n`);
  pushRaw(contentStreamBytes);
  pushAscii('\nendstream\nendobj\n');

  // Object 6: Document Metadata Dictionary
  const safeTitle = escapePdfLiteralString(title);
  const safeAuthor = escapePdfLiteralString(author);
  const creationStamp = formatPdfTimestamp(new Date());

  objectOffsets[6] = byteCursor;
  pushAscii(
    `6 0 obj\n<< /Title (${safeTitle}) /Author (${safeAuthor}) /Subject (Single-Page Client Pitch Summary) /Creator (SiteMockup Studio) /Producer (SiteMockup Single-Page PDF Builder) /CreationDate (D:${creationStamp}) >>\nendobj\n`
  );

  // Cross-Reference Table (strict 20-byte entries)
  const xrefOffset = byteCursor;
  const xrefLines: string[] = [
    'xref\n',
    '0 7\n',
    '0000000000 65535 f \n',
  ];
  for (let objId = 1; objId <= 6; objId++) {
    const paddedOffset = String(objectOffsets[objId]).padStart(10, '0');
    xrefLines.push(`${paddedOffset} 00000 n \n`);
  }
  pushAscii(xrefLines.join(''));

  // Trailer
  pushAscii(
    `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  const pdfBytes = new Uint8Array(byteCursor);
  let writeOffset = 0;
  for (const chunk of chunks) {
    pdfBytes.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }

  return {
    pdfBytes,
    widthPt,
    heightPt,
  };
}

async function waitForDocumentFontsReady(timeoutMs = 1500): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => window.setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Proceed cleanly if font loading observer rejects
  }
}

function flattenToOpaqueWhiteRgbCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, source.width);
  out.height = Math.max(1, source.height);
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);
  }
  return out;
}

export function triggerPdfBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2200);
}

/**
 * Renders the target client pitch summary sheet at high DPI and packages it as a
 * single-page downloadable `.pdf` file (A4 or US Letter).
 */
export async function exportElementToSinglePagePdf(
  element: HTMLElement,
  options: PitchPdfExportOptions
): Promise<PitchPdfExportResult> {
  const pageFormat: PitchPdfPageFormat = options.pageFormat ?? 'a4';
  const pixelScale = options.pixelScale ?? 2;

  await waitForDocumentFontsReady();

  let renderedCanvas: HTMLCanvasElement;
  try {
    renderedCanvas = await html2canvas(element, {
      scale: pixelScale,
      backgroundColor: '#FFFFFF',
      useCORS: true,
      logging: false,
      windowWidth: 1080,
      onclone: (clonedDoc) => {
        if (element.id) {
          const clonedSheet = clonedDoc.getElementById(element.id);
          if (clonedSheet) {
            clonedSheet.classList.add('pitch-pdf-capture-lock');
          }
        }
      },
    });
  } catch {
    renderedCanvas = await toCanvas(element, {
      pixelRatio: pixelScale,
      backgroundColor: '#FFFFFF',
      skipFonts: true,
    });
  }

  if (!renderedCanvas || renderedCanvas.width === 0 || renderedCanvas.height === 0) {
    throw new Error('Could not capture the client pitch summary for PDF generation.');
  }

  const rgbCanvas = flattenToOpaqueWhiteRgbCanvas(renderedCanvas);
  const jpegDataUrl = rgbCanvas.toDataURL('image/jpeg', 0.94);
  const jpegBytes = decodeBase64JpegDataUrl(jpegDataUrl);

  const brandSlug = sanitizeAssetSlug(options.brandName, 'client-site');
  const formatTag = pageFormat === 'letter' ? 'letter' : 'a4';
  const filename = `${brandSlug}-pitch-summary-${formatTag}.pdf`;

  const { pdfBytes, widthPt, heightPt } = buildSinglePageJpegPdfBytes({
    jpegBytes,
    imgWidthPx: rgbCanvas.width,
    imgHeightPx: rgbCanvas.height,
    pageFormat,
    title:
      options.title ||
      `${options.brandName || 'Client'} — Website Redesign Pitch Summary`,
    author: options.author || options.brandName || 'SiteMockup Studio',
  });

  const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBuffer).set(pdfBytes);
  const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
  triggerPdfBlobDownload(pdfBlob, filename);

  return {
    filename,
    sizeKb: Math.max(1, Math.round(pdfBlob.size / 1024)),
    pageFormat,
    pageDimensionsPt: {
      width: widthPt,
      height: heightPt,
    },
    pixelDimensions: {
      width: rgbCanvas.width,
      height: rgbCanvas.height,
    },
  };
}
