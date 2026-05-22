import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { RedactRect } from '../lib/pdf-utils';

if (typeof window !== 'undefined') { pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`; }

export interface ThumbnailOverlays {
  pageNumber?: { text: string; position: string; fontSize: number };
  watermark?: { text: string; opacity: number; fontSize: number; angle: number };
  redactRects?: RedactRect[];
  crop?: { top: number; right: number; bottom: number; left: number };
}

interface PageThumbnailProps {
  pdfBuffer: ArrayBuffer;
  pageIndex: number;
  width?: number;
  rotation?: number;
  overlays?: ThumbnailOverlays;
}

const PageThumbnail = ({ pdfBuffer, pageIndex, width = 150, rotation = 0, overlays }: PageThumbnailProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let pdfDoc: { destroy: () => Promise<void> } | null = null;
    const render = async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer.slice(0)) }).promise;
        if (cancelled) { pdf.destroy(); return; }
        pdfDoc = pdf;
        const page = await pdf.getPage(pageIndex + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1, rotation });
        const pdfW = viewport.width;
        const pdfH = viewport.height;
        const scale = width / viewport.width;
        const scaledViewport = page.getViewport({ scale, rotation });

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport }) as unknown as { cancel: () => void; promise: Promise<void> };
        await renderTask.promise;
        if (cancelled) return;

        const cw = scaledViewport.width;
        const ch = scaledViewport.height;
        const sx = cw / pdfW;
        const sy = ch / pdfH;

        // Draw redact rectangles
        if (overlays?.redactRects && overlays.redactRects.length > 0) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
          for (const r of overlays.redactRects) {
            const rx = r.x * sx;
            const ry = ch - (r.y + r.height) * sy;
            const rw = r.width * sx;
            const rh = r.height * sy;
            ctx.fillRect(rx, ry, rw, rh);
          }
        }

        // Draw crop overlay (dim outside areas)
        if (overlays?.crop) {
          const { top, right, bottom, left } = overlays.crop;
          if (top > 0 || right > 0 || bottom > 0 || left > 0) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            const cropX = (left / 100) * cw;
            const cropY = (top / 100) * ch;
            const cropW = cw - cropX - (right / 100) * cw;
            const cropH = ch - cropY - (bottom / 100) * ch;
            // Top
            ctx.fillRect(0, 0, cw, cropY);
            // Bottom
            ctx.fillRect(0, cropY + cropH, cw, ch - cropY - cropH);
            // Left
            ctx.fillRect(0, cropY, cropX, cropH);
            // Right
            ctx.fillRect(cropX + cropW, cropY, cw - cropX - cropW, cropH);
            // Border
            ctx.strokeStyle = '#2563EB';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(cropX, cropY, cropW, cropH);
            ctx.setLineDash([]);
          }
        }

        // Draw watermark
        if (overlays?.watermark && overlays.watermark.text) {
          const wm = overlays.watermark;
          const wmFontSize = Math.max(8, (wm.fontSize / 72) * cw * 0.15); // scale to thumbnail
          ctx.save();
          ctx.globalAlpha = wm.opacity / 100;
          ctx.font = `bold ${wmFontSize}px sans-serif`;
          ctx.fillStyle = '#888888';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.translate(cw / 2, ch / 2);
          ctx.rotate((wm.angle * Math.PI) / 180);
          ctx.fillText(wm.text, 0, 0);
          ctx.restore();
        }

        // Draw page number
        if (overlays?.pageNumber) {
          const pn = overlays.pageNumber;
          const pnFontSize = Math.max(10, (pn.fontSize / 12) * 14); // scale
          ctx.save();
          ctx.font = `${pnFontSize}px sans-serif`;
          ctx.fillStyle = '#000000';
          ctx.textBaseline = 'middle';
          const padding = 6;
          let x = cw / 2, y = ch - padding;
          const pos = pn.position;
          if (pos.includes('top')) y = padding + pnFontSize / 2;
          else y = ch - padding - pnFontSize / 2;
          if (pos.includes('left')) { ctx.textAlign = 'left'; x = padding; }
          else if (pos.includes('right')) { ctx.textAlign = 'right'; x = cw - padding; }
          else { ctx.textAlign = 'center'; x = cw / 2; }
          ctx.fillText(pn.text, x, y);
          ctx.restore();
        }

        if (!cancelled) setRendered(true);
      } catch (err) {
        console.error('Thumbnail render failed:', err);
      }
    };
    setRendered(false);
    render();
    return () => { cancelled = true; };
  }, [pdfBuffer, pageIndex, width, rotation, overlays]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100%',
        height: 'auto',
        opacity: rendered ? 1 : 0,
        transition: 'opacity 0.2s',
      }}
    />
  );
};

export default PageThumbnail;
