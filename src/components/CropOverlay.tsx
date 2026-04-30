import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, RotateCcw } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { CropValues } from '../lib/pdf-utils';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface CropOverlayProps {
  pdfBuffer: ArrayBuffer;
  pageIndex: number;
  rotation?: number;
  existingCrop: CropValues;
  onSave: (crop: CropValues) => void;
  onClose: () => void;
}

type Handle = 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const CropOverlay = ({ pdfBuffer, pageIndex, rotation = 0, existingCrop, onSave, onClose }: CropOverlayProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [cropBox, setCropBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState<{ handle: Handle | 'move'; startX: number; startY: number; startBox: { x: number; y: number; w: number; h: number } } | null>(null);

  useEffect(() => {
    const render = async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: pdfBuffer.slice(0) }).promise;
        const page = await pdf.getPage(pageIndex + 1);
        const vp = page.getViewport({ scale: 1, rotation });
        const maxW = Math.min(800, window.innerWidth - 80);
        const maxH = window.innerHeight - 180;
        const scale = Math.min(maxW / vp.width, maxH / vp.height);
        const scaled = page.getViewport({ scale, rotation });
        setDisplaySize({ width: scaled.width, height: scaled.height });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = scaled.width; canvas.height = scaled.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport: scaled }).promise;
        const x = (existingCrop.left / 100) * scaled.width;
        const y = (existingCrop.top / 100) * scaled.height;
        const w = scaled.width - x - (existingCrop.right / 100) * scaled.width;
        const h = scaled.height - y - (existingCrop.bottom / 100) * scaled.height;
        setCropBox({ x, y, w, h });
      } catch (err) { console.error('Crop render failed:', err); }
    };
    render();
  }, [pdfBuffer, pageIndex, existingCrop]);

  const handleMouseDown = useCallback((e: React.MouseEvent, handle: Handle | 'move') => {
    e.preventDefault(); e.stopPropagation();
    if (!cropBox) return;
    setDragging({ handle, startX: e.clientX, startY: e.clientY, startBox: { ...cropBox } });
  }, [cropBox]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || !cropBox || !displaySize) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    const { startBox } = dragging;
    const minSize = 20;
    let newBox = { ...startBox };
    switch (dragging.handle) {
      case 'move': newBox.x = Math.max(0, Math.min(displaySize.width - startBox.w, startBox.x + dx)); newBox.y = Math.max(0, Math.min(displaySize.height - startBox.h, startBox.y + dy)); break;
      case 'top': newBox.y = Math.max(0, Math.min(startBox.y + startBox.h - minSize, startBox.y + dy)); newBox.h = startBox.h - (newBox.y - startBox.y); break;
      case 'bottom': newBox.h = Math.max(minSize, Math.min(displaySize.height - startBox.y, startBox.h + dy)); break;
      case 'left': newBox.x = Math.max(0, Math.min(startBox.x + startBox.w - minSize, startBox.x + dx)); newBox.w = startBox.w - (newBox.x - startBox.x); break;
      case 'right': newBox.w = Math.max(minSize, Math.min(displaySize.width - startBox.x, startBox.w + dx)); break;
      case 'top-left': newBox.x = Math.max(0, Math.min(startBox.x + startBox.w - minSize, startBox.x + dx)); newBox.y = Math.max(0, Math.min(startBox.y + startBox.h - minSize, startBox.y + dy)); newBox.w = startBox.w - (newBox.x - startBox.x); newBox.h = startBox.h - (newBox.y - startBox.y); break;
      case 'top-right': newBox.y = Math.max(0, Math.min(startBox.y + startBox.h - minSize, startBox.y + dy)); newBox.w = Math.max(minSize, Math.min(displaySize.width - startBox.x, startBox.w + dx)); newBox.h = startBox.h - (newBox.y - startBox.y); break;
      case 'bottom-left': newBox.x = Math.max(0, Math.min(startBox.x + startBox.w - minSize, startBox.x + dx)); newBox.w = startBox.w - (newBox.x - startBox.x); newBox.h = Math.max(minSize, Math.min(displaySize.height - startBox.y, startBox.h + dy)); break;
      case 'bottom-right': newBox.w = Math.max(minSize, Math.min(displaySize.width - startBox.x, startBox.w + dx)); newBox.h = Math.max(minSize, Math.min(displaySize.height - startBox.y, startBox.h + dy)); break;
    }
    setCropBox(newBox);
  }, [dragging, displaySize]);

  const handleMouseUp = useCallback(() => { setDragging(null); }, []);

  const handleSave = () => {
    if (!cropBox || !displaySize) { onSave({ top: 0, right: 0, bottom: 0, left: 0 }); return; }
    onSave({
      left: Math.round((cropBox.x / displaySize.width) * 100),
      top: Math.round((cropBox.y / displaySize.height) * 100),
      right: Math.round(((displaySize.width - cropBox.x - cropBox.w) / displaySize.width) * 100),
      bottom: Math.round(((displaySize.height - cropBox.y - cropBox.h) / displaySize.height) * 100),
    });
  };

  const handleReset = () => {
    if (!displaySize) return;
    setCropBox({ x: 0, y: 0, w: displaySize.width, h: displaySize.height });
  };

  const handleSize = 10;
  const renderHandle = (handle: Handle, left: number, top: number, cursor: string) => (
    <div key={handle} onMouseDown={(e) => handleMouseDown(e, handle)}
      style={{ position: 'absolute', left: left - handleSize / 2, top: top - handleSize / 2, width: handleSize, height: handleSize, backgroundColor: 'white', border: '2px solid #2563EB', borderRadius: 2, cursor, zIndex: 10 }} />
  );

  return (
    <div className="fixed inset-0 bg-black/85 z-[1000] flex flex-col items-center" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <div className="flex items-center gap-4 p-5 w-full justify-center">
        <span className="text-white font-medium text-sm">Page {pageIndex + 1} — Drag handles to crop</span>
        {cropBox && displaySize && (
          <span className="text-white/60 text-xs">
            {Math.round((cropBox.x / displaySize.width) * 100)}% L · {Math.round((cropBox.y / displaySize.height) * 100)}% T · {Math.round(((displaySize.width - cropBox.x - cropBox.w) / displaySize.width) * 100)}% R · {Math.round(((displaySize.height - cropBox.y - cropBox.h) / displaySize.height) * 100)}% B
          </span>
        )}
        <div className="flex-1" />
        <Button variant="secondary" size="compact" onClick={handleReset}><RotateCcw size={16} className="mr-1" /> Reset</Button>
        <Button variant="secondary" size="compact" onClick={handleSave}>Save</Button>
        <Button variant="ghost" size="compact" onClick={onClose} className="text-white hover:text-white"><X size={20} /></Button>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-auto">
        <div ref={containerRef} className="relative select-none" style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
          {cropBox && displaySize && (
            <>
              <div style={{ position: 'absolute', top: 0, left: 0, width: displaySize.width, height: cropBox.y, backgroundColor: 'rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', top: cropBox.y + cropBox.h, left: 0, width: displaySize.width, height: displaySize.height - cropBox.y - cropBox.h, backgroundColor: 'rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', top: cropBox.y, left: 0, width: cropBox.x, height: cropBox.h, backgroundColor: 'rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', top: cropBox.y, left: cropBox.x + cropBox.w, width: displaySize.width - cropBox.x - cropBox.w, height: cropBox.h, backgroundColor: 'rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
              <div onMouseDown={(e) => handleMouseDown(e, 'move')}
                style={{ position: 'absolute', left: cropBox.x, top: cropBox.y, width: cropBox.w, height: cropBox.h, border: '2px solid #2563EB', cursor: dragging?.handle === 'move' ? 'grabbing' : 'grab', boxSizing: 'border-box' }}>
                <div style={{ position: 'absolute', left: '33.33%', top: 0, width: 1, height: '100%', backgroundColor: 'rgba(255,255,255,0.3)' }} />
                <div style={{ position: 'absolute', left: '66.66%', top: 0, width: 1, height: '100%', backgroundColor: 'rgba(255,255,255,0.3)' }} />
                <div style={{ position: 'absolute', top: '33.33%', left: 0, height: 1, width: '100%', backgroundColor: 'rgba(255,255,255,0.3)' }} />
                <div style={{ position: 'absolute', top: '66.66%', left: 0, height: 1, width: '100%', backgroundColor: 'rgba(255,255,255,0.3)' }} />
              </div>
              {renderHandle('top-left', cropBox.x, cropBox.y, 'nw-resize')}
              {renderHandle('top', cropBox.x + cropBox.w / 2, cropBox.y, 'n-resize')}
              {renderHandle('top-right', cropBox.x + cropBox.w, cropBox.y, 'ne-resize')}
              {renderHandle('left', cropBox.x, cropBox.y + cropBox.h / 2, 'w-resize')}
              {renderHandle('right', cropBox.x + cropBox.w, cropBox.y + cropBox.h / 2, 'e-resize')}
              {renderHandle('bottom-left', cropBox.x, cropBox.y + cropBox.h, 'sw-resize')}
              {renderHandle('bottom', cropBox.x + cropBox.w / 2, cropBox.y + cropBox.h, 's-resize')}
              {renderHandle('bottom-right', cropBox.x + cropBox.w, cropBox.y + cropBox.h, 'se-resize')}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CropOverlay;
