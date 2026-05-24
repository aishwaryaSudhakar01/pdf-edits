import { PDFDocument, rgb, StandardFonts, degrees, PDFPage } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import type { Annotation } from '../components/AnnotationOverlay';
import { getImageBytes } from './image-store';

/* ── Errors ────────────────────────────────────── */

export type PdfOperationKind =
  | 'stamp' | 'signature' | 'text' | 'highlight'
  | 'pageNumbers' | 'watermark' | 'redact' | 'crop'
  | 'compress' | 'resize' | 'split' | 'metadata'
  | 'rotate' | 'organize' | 'annotations' | 'output';

export class PdfOpError extends Error {
  operation: PdfOperationKind;
  pageIndex: number | null;
  recoverable: boolean;
  cause?: unknown;
  constructor(operation: PdfOperationKind, message: string, opts: { pageIndex?: number | null; recoverable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'PdfOpError';
    this.operation = operation;
    this.pageIndex = opts.pageIndex ?? null;
    this.recoverable = opts.recoverable ?? true;
    this.cause = opts.cause;
  }
}

function describeOp(op: PdfOperationKind): string {
  const map: Record<PdfOperationKind, string> = {
    stamp: 'Image stamp', signature: 'Signature', text: 'Text annotation',
    highlight: 'Highlight', pageNumbers: 'Page numbers', watermark: 'Watermark',
    redact: 'Black-out', crop: 'Crop', compress: 'Compression', resize: 'Resize',
    split: 'Split', metadata: 'Metadata', rotate: 'Rotate', organize: 'Organize',
    annotations: 'Annotations', output: 'Output',
  };
  return map[op];
}

function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const n = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return (n === 90 || n === 180 || n === 270 ? n : 0) as 0 | 90 | 180 | 270;
}

function displayBoxToPageBox(
  box: { x: number; y: number; width: number; height: number },
  pageSize: { width: number; height: number },
  rotation: number,
) {
  const top = (rotation === 90 || rotation === 270 ? pageSize.width : pageSize.height) - box.y - box.height;
  switch (normalizeRotation(rotation)) {
    case 90: return { x: top, y: box.x, width: box.height, height: box.width };
    case 180: return { x: pageSize.width - box.x - box.width, y: top, width: box.width, height: box.height };
    case 270: return { x: box.y, y: pageSize.height - box.x - box.width, width: box.height, height: box.width };
    default: return box;
  }
}

/* ── Types ─────────────────────────────────────── */

export interface PageItem {
  id: string;
  sourceFileId: string;
  sourcePageIndex: number;
  rotation: number; // 0, 90, 180, 270
}

export interface SourceFile {
  id: string;
  name: string;
  buffer: ArrayBuffer;
  pageCount: number;
  size: number;
}

export interface RedactRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropValues { top: number; right: number; bottom: number; left: number }

export interface BuildOptions {
  quality: number;
  pageNumbers: { enabled: boolean; position: string; fontSize: number; startNumber: number };
  watermark: { enabled: boolean; text: string; opacity: number; fontSize: number; angle: number; pages?: Set<number>; textByPage?: Map<number, string> };
  redactions: Map<number, RedactRect[]>;
  crops: Map<number, CropValues>;
  metadata?: { title: string; author: string; subject: string; keywords: string };
  annotations: Map<number, Annotation[]>;
}

/* ── Helpers ───────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function parseSplitRanges(input: string, totalPages: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(s => parseInt(s.trim()));
      if (!isNaN(a) && !isNaN(b) && a >= 1 && b <= totalPages && a <= b) {
        ranges.push({ from: a - 1, to: b - 1 });
      }
    } else {
      const n = parseInt(part);
      if (!isNaN(n) && n >= 1 && n <= totalPages) {
        ranges.push({ from: n - 1, to: n - 1 });
      }
    }
  }
  return ranges;
}

/* ── Unified PDF Builder ───────────────────────── */

export async function buildFinalPdf(
  pages: PageItem[],
  sources: Map<string, SourceFile>,
  options: BuildOptions
): Promise<Blob> {
  const doc = await PDFDocument.create();
  const hasTextAnns = Array.from(options.annotations.values()).some(anns => anns.some(a => a.type === 'text'));
  const hasPerPageWm = options.watermark.textByPage && options.watermark.textByPage.size > 0;
  const needFont = options.pageNumbers.enabled || (options.watermark.enabled && (options.watermark.text || hasPerPageWm)) || hasTextAnns;
  const font = needFont ? await doc.embedFont(StandardFonts.Helvetica) : null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const src = sources.get(page.sourceFileId);
    if (!src) continue;

    const srcDoc = await PDFDocument.load(src.buffer.slice(0), { ignoreEncryption: true });
    const [copied] = await doc.copyPages(srcDoc, [page.sourcePageIndex]);

    const currentRotation = copied.getRotation().angle;
    const outputRotation = (currentRotation + page.rotation) % 360;
    if (page.rotation) {
      copied.setRotation(degrees(outputRotation));
    }

    doc.addPage(copied);
    const { width, height } = copied.getSize();

    // Redactions
    const rects = options.redactions.get(i) || [];
    for (const r of rects) {
      const rectBox = displayBoxToPageBox(
        { x: r.x, y: r.y, width: r.width, height: r.height },
        { width, height },
        outputRotation,
      );
      copied.drawRectangle({ x: rectBox.x, y: rectBox.y, width: rectBox.width, height: rectBox.height, color: rgb(0, 0, 0) });
    }

    // Crop (per-page)
    const c = options.crops.get(i);
    const hasCrop = c && (c.top > 0 || c.right > 0 || c.bottom > 0 || c.left > 0);
    let eX = 0, eY = 0, eW = width, eH = height;
    if (hasCrop && c) {
      const l = width * (c.left / 100);
      const b = height * (c.bottom / 100);
      const r = width * (1 - c.right / 100);
      const t = height * (1 - c.top / 100);
      copied.setCropBox(l, b, r - l, t - b);
      eX = l; eY = b; eW = r - l; eH = t - b;
    }

    // Page numbers
    if (options.pageNumbers.enabled && font) {
      const pn = options.pageNumbers;
      const text = `${pn.startNumber + i}`;
      const tw = font.widthOfTextAtSize(text, pn.fontSize);
      const m = 30;
      let x: number, y: number;
      switch (pn.position) {
        case 'bottom-center': x = eX + (eW - tw) / 2; y = eY + m; break;
        case 'bottom-left': x = eX + m; y = eY + m; break;
        case 'bottom-right': x = eX + eW - tw - m; y = eY + m; break;
        case 'top-center': x = eX + (eW - tw) / 2; y = eY + eH - m - pn.fontSize; break;
        case 'top-left': x = eX + m; y = eY + eH - m - pn.fontSize; break;
        case 'top-right': x = eX + eW - tw - m; y = eY + eH - m - pn.fontSize; break;
        default: x = eX + (eW - tw) / 2; y = eY + m;
      }
      copied.drawText(text, { x, y, size: pn.fontSize, font, color: rgb(0, 0, 0) });
    }

    // Watermark
    const wmPages = options.watermark.pages;
    const wmApplies = !wmPages || wmPages.size === 0 || wmPages.has(i);
    const wmTextForPage = options.watermark.textByPage?.get(i) || options.watermark.text;
    if (options.watermark.enabled && wmTextForPage && font && wmApplies) {
      const wm = options.watermark;
      const tw = font.widthOfTextAtSize(wmTextForPage, wm.fontSize);
      const rad = (wm.angle * Math.PI) / 180;
      const cx = eX + eW / 2;
      const cy = eY + eH / 2;
      const x = cx - (tw / 2) * Math.cos(Math.abs(rad));
      const y = cy + (tw / 2) * Math.sin(rad);
      copied.drawText(wmTextForPage, {
        x, y, size: wm.fontSize, font,
        color: rgb(0.5, 0.5, 0.5),
        opacity: wm.opacity / 100,
        rotate: degrees(wm.angle),
      });
    }

    // Annotations
    // Annotation coordinates are stored in the same displayed page coordinate
    // space used by the overlay, then mapped back to the underlying PDF page.
    const anns = options.annotations.get(i) || [];
    for (const ann of anns) {
      const annBox = displayBoxToPageBox(
        { x: ann.x, y: ann.y, width: ann.width, height: ann.height },
        { width, height },
        outputRotation,
      );
      if (ann.type === 'text' && ann.text && font) {
        const hexToRgb = (hex: string) => {
          const r = parseInt(hex.slice(1, 3), 16) / 255;
          const g = parseInt(hex.slice(3, 5), 16) / 255;
          const b = parseInt(hex.slice(5, 7), 16) / 255;
          return rgb(r, g, b);
        };
        const fs = ann.fontSize || 16;
        // Baseline sits ~0.2*fs above bbox bottom so descenders match the
        // editor preview (which renders text inside a div from top to top+h).
        copied.drawText(ann.text, {
          x: annBox.x, y: annBox.y + 0.2 * fs,
          size: fs, font,
          color: hexToRgb(ann.color || '#000000'),
        });
      } else if (ann.type === 'highlight') {
        const hexToRgb = (hex: string) => {
          const r = parseInt(hex.slice(1, 3), 16) / 255;
          const g = parseInt(hex.slice(3, 5), 16) / 255;
          const b = parseInt(hex.slice(5, 7), 16) / 255;
          return rgb(r, g, b);
        };
        copied.drawRectangle({
          x: annBox.x, y: annBox.y,
          width: annBox.width, height: annBox.height,
          color: hexToRgb(ann.highlightColor || '#FFFF00'),
          opacity: ann.highlightOpacity || 0.4,
        });
      } else if (ann.type === 'stamp' || ann.type === 'signature') {
        // Resolve bytes via image-store (current) or legacy inline fields.
        const stampBytes = ann.imageKey ? getImageBytes(ann.imageKey)
          : ann.type === 'stamp' ? ann.imageData : ann.signatureData;
        const stampType: 'png' | 'jpg' = ann.type === 'signature' ? 'png' : (ann.imageType ?? 'png');
        if (!stampBytes) {
          throw new PdfOpError(ann.type, `${describeOp(ann.type)} failed on page ${i + 1}: missing image data`, { pageIndex: i });
        }
        try {
          const img = stampType === 'png' ? await doc.embedPng(stampBytes) : await doc.embedJpg(stampBytes);
          copied.drawImage(img, {
            x: annBox.x, y: annBox.y,
            width: annBox.width, height: annBox.height,
          });
        } catch (e) {
          throw new PdfOpError(ann.type, `${describeOp(ann.type)} failed on page ${i + 1}: ${(e as Error)?.message || 'invalid image data'}`, { pageIndex: i, cause: e });
        }
      }

    }
  }

  if (doc.getPageCount() === 0) throw new PdfOpError('output', 'Output PDF has no pages', { recoverable: false });

  // Apply metadata
  const meta = options.metadata;
  if (meta) {
    if (meta.title) doc.setTitle(meta.title);
    if (meta.author) doc.setAuthor(meta.author);
    if (meta.subject) doc.setSubject(meta.subject);
    if (meta.keywords) doc.setKeywords(meta.keywords.split(',').map(k => k.trim()).filter(Boolean));
  }

  if (options.quality < 80 && !meta) {
    doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
    doc.setKeywords([]); doc.setProducer(''); doc.setCreator('');
  }

  const bytes = await doc.save({
    useObjectStreams: options.quality < 90,
    addDefaultPage: false,
    objectsPerTick: options.quality < 50 ? 20 : 50,
  });

  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
}

/* ── Compress PDF (re-render as JPEG) ──────────── */

export async function compressPdf(
  pages: PageItem[],
  sources: Map<string, SourceFile>,
  quality: number // 1-100
): Promise<Blob> {
  // --- Step 1: Try lossless re-save (strip metadata, use object streams) ---
  const losslessDoc = await PDFDocument.create();
  for (const page of pages) {
    const src = sources.get(page.sourceFileId);
    if (!src) continue;
    const srcDoc = await PDFDocument.load(src.buffer.slice(0), { ignoreEncryption: true });
    const [copied] = await losslessDoc.copyPages(srcDoc, [page.sourcePageIndex]);
    if (page.rotation) {
      copied.setRotation(degrees((copied.getRotation().angle + page.rotation) % 360));
    }
    losslessDoc.addPage(copied);
  }
  losslessDoc.setTitle(''); losslessDoc.setAuthor(''); losslessDoc.setSubject('');
  losslessDoc.setKeywords([]); losslessDoc.setProducer(''); losslessDoc.setCreator('');
  const losslessBytes = await losslessDoc.save({ useObjectStreams: true, addDefaultPage: false });
  const losslessBlob = new Blob([losslessBytes.buffer as ArrayBuffer], { type: 'application/pdf' });

  // Calculate original total size
  const originalSize = pages.reduce((sum, p) => {
    const s = sources.get(p.sourceFileId);
    return sum + (s ? s.size : 0);
  }, 0);

  // Reconstruct original blob for comparison
  const uniqueSrcIds = [...new Set(pages.map(p => p.sourceFileId))];
  const originalBlobs: Blob[] = [];
  for (const id of uniqueSrcIds) {
    const s = sources.get(id);
    if (s) originalBlobs.push(new Blob([s.buffer.slice(0)], { type: 'application/pdf' }));
  }
  const originalBlob = originalBlobs.length === 1
    ? originalBlobs[0]
    : new Blob([losslessBytes.buffer as ArrayBuffer], { type: 'application/pdf' }); // fallback to lossless for multi-source

  // If quality is high (>=60), skip lossy — pick smallest of lossless vs original
  if (quality >= 60) {
    return losslessBlob.size <= originalBlob.size ? losslessBlob : originalBlob;
  }

  // --- Step 2: Lossy rasterisation for lower quality settings ---
  const doc = await PDFDocument.create();
  const jpegQuality = Math.max(0.05, quality / 100);
  // Use scale ≤1 to actually reduce data; higher scale = bigger files
  const scale = quality >= 50 ? 1 : 0.75;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const src = sources.get(page.sourceFileId);
    if (!src) continue;

    const pdf = await pdfjsLib.getDocument({ data: src.buffer.slice(0) }).promise;
    const pdfPage = await pdf.getPage(page.sourcePageIndex + 1);
    const vp = pdfPage.getViewport({ scale, rotation: page.rotation });

    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;

    const jpegBlob = await new Promise<Blob>((res) =>
      canvas.toBlob((b) => res(b!), 'image/jpeg', jpegQuality)
    );
    const jpegData = new Uint8Array(await jpegBlob.arrayBuffer());
    const img = await doc.embedJpg(jpegData);

    const origVp = pdfPage.getViewport({ scale: 1, rotation: page.rotation });
    const newPage = doc.addPage([origVp.width, origVp.height]);
    newPage.drawImage(img, { x: 0, y: 0, width: origVp.width, height: origVp.height });

    pdf.destroy();
  }

  if (doc.getPageCount() === 0) throw new Error('No pages');

  doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
  doc.setKeywords([]); doc.setProducer(''); doc.setCreator('');

  const lossy = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  const lossyBlob = new Blob([lossy.buffer as ArrayBuffer], { type: 'application/pdf' });

  // --- Step 3: Return the smallest result --- never return something bigger than original
  const candidates = [losslessBlob, lossyBlob, originalBlob];
  candidates.sort((a, b) => a.size - b.size);
  return candidates[0];
}


export async function splitPdf(
  pages: PageItem[],
  sources: Map<string, SourceFile>,
  ranges: { from: number; to: number }[]
): Promise<{ blob: Blob; label: string }[]> {
  const results: { blob: Blob; label: string }[] = [];
  for (const range of ranges) {
    const doc = await PDFDocument.create();
    for (let i = range.from; i <= range.to && i < pages.length; i++) {
      const page = pages[i];
      const src = sources.get(page.sourceFileId);
      if (!src) continue;
      const srcDoc = await PDFDocument.load(src.buffer.slice(0), { ignoreEncryption: true });
      const [copied] = await doc.copyPages(srcDoc, [page.sourcePageIndex]);
      if (page.rotation) {
        copied.setRotation(degrees((copied.getRotation().angle + page.rotation) % 360));
      }
      doc.addPage(copied);
    }
    if (doc.getPageCount() > 0) {
      const bytes = await doc.save();
      results.push({
        blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }),
        label: range.from === range.to ? `page_${range.from + 1}` : `pages_${range.from + 1}-${range.to + 1}`,
      });
    }
  }
  return results;
}

/* ── Page Size Presets ──────────────────────────── */

export const PAGE_SIZES: { label: string; width: number; height: number }[] = [
  { label: 'A4', width: 595.28, height: 841.89 },
  { label: 'Letter', width: 612, height: 792 },
  { label: 'Legal', width: 612, height: 1008 },
  { label: 'A3', width: 841.89, height: 1190.55 },
  { label: 'A5', width: 419.53, height: 595.28 },
];

export async function convertToPageSize(
  pages: PageItem[],
  sources: Map<string, SourceFile>,
  targetWidth: number,
  targetHeight: number
): Promise<Blob> {
  const doc = await PDFDocument.create();

  for (const page of pages) {
    const src = sources.get(page.sourceFileId);
    if (!src) continue;

    const srcDoc = await PDFDocument.load(src.buffer.slice(0), { ignoreEncryption: true });
    const [copied] = await doc.copyPages(srcDoc, [page.sourcePageIndex]);

    if (page.rotation) {
      const current = copied.getRotation().angle;
      copied.setRotation(degrees((current + page.rotation) % 360));
    }

    const { width, height } = copied.getSize();
    const scaleX = targetWidth / width;
    const scaleY = targetHeight / height;
    const scale = Math.min(scaleX, scaleY);

    const newPage = doc.addPage([targetWidth, targetHeight]);
    const embedded = await doc.embedPage(copied);
    const scaledW = width * scale;
    const scaledH = height * scale;
    const x = (targetWidth - scaledW) / 2;
    const y = (targetHeight - scaledH) / 2;

    newPage.drawPage(embedded, { x, y, width: scaledW, height: scaledH });
  }

  if (doc.getPageCount() === 0) throw new Error('No pages');
  const bytes = await doc.save();
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
}


/* ── Images to PDF ─────────────────────────────── */

export async function imagesToPdf(images: { data: Uint8Array; type: 'png' | 'jpg' }[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  for (const img of images) {
    const embedded = img.type === 'png'
      ? await doc.embedPng(img.data)
      : await doc.embedJpg(img.data);
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  const bytes = await doc.save();
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
}

/* ── Blob helpers for chaining operations ──────── */

/** Convert a Blob into a single-source pipeline (pages + sources) */
export async function blobToPipeline(blob: Blob): Promise<{ pages: PageItem[]; sources: Map<string, SourceFile> }> {
  const buffer = await blob.arrayBuffer();
  const doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption: true });
  const pageCount = doc.getPageCount();
  const fileId = crypto.randomUUID();
  const sources = new Map<string, SourceFile>();
  sources.set(fileId, { id: fileId, name: 'intermediate.pdf', buffer, pageCount, size: buffer.byteLength });
  const pages: PageItem[] = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({ id: crypto.randomUUID(), sourceFileId: fileId, sourcePageIndex: i, rotation: 0 });
  }
  return { pages, sources };
}
