import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Undo2, Trash2, X, Plus, Minus } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { RedactRect } from '../lib/pdf-utils';

if (typeof window !== 'undefined') { pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`; }

interface ScreenRect { x: number; y: number; width: number; height: number }

interface RedactOverlayProps {
  pdfBuffer: ArrayBuffer;
  pageIndex: number;
  rotation?: number;
  existingRects: RedactRect[];
  onSave: (rects: RedactRect[]) => void;
  onClose: () => void;
}

const SCALE_STEP = 10; // px to grow/shrink per click

const RedactOverlay = ({ pdfBuffer, pageIndex, rotation = 0, existingRects, onSave, onClose }: RedactOverlayProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<ScreenRect[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ x: number; y: number } | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);

  // Selection & drag state
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDragRef = useRef<{ idx: number; offset: { x: number; y: number } } | null>(null);
  const didStartDrag = useRef(false);

  useEffect(() => {
    const render = async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer.slice(0)) }).promise;
        const page = await pdf.getPage(pageIndex + 1);
        const vp = page.getViewport({ scale: 1, rotation });
        setPageSize({ width: vp.width, height: vp.height });
        const maxW = Math.min(800, window.innerWidth - 80);
        const maxH = window.innerHeight - 160;
        const scale = Math.min(maxW / vp.width, maxH / vp.height);
        const scaled = page.getViewport({ scale, rotation });
        setDisplaySize({ width: scaled.width, height: scaled.height });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = scaled.width;
        canvas.height = scaled.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport: scaled }).promise;
      } catch (err) { console.error('Redact render failed:', err); }
    };
    render();
  }, [pdfBuffer, pageIndex, rotation]);

  useEffect(() => {
    if (!pageSize || !displaySize || existingRects.length === 0) return;
    const sx = displaySize.width / pageSize.width;
    const sy = displaySize.height / pageSize.height;
    setRects(existingRects.map(r => ({
      x: r.x * sx, y: displaySize.height - (r.y + r.height) * sy,
      width: r.width * sx, height: r.height * sy,
    })));
  }, [pageSize, displaySize, existingRects]);

  const getPos = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTestRect = (pos: { x: number; y: number }): number | null => {
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (pos.x >= r.x && pos.x <= r.x + r.width && pos.y >= r.y && pos.y <= r.y + r.height) return i;
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const pos = getPos(e);
    if (!pos) return;

    const hitIdx = hitTestRect(pos);
    if (hitIdx !== null) {
      const r = rects[hitIdx];
      const offset = { x: pos.x - r.x, y: pos.y - r.y };
      pendingDragRef.current = { idx: hitIdx, offset };
      didStartDrag.current = false;
      dragDelayTimer.current = setTimeout(() => {
        didStartDrag.current = true;
        setDraggingIdx(hitIdx);
        setDragOffset(offset);
      }, 150);
      return;
    }

    // Clicked empty space — deselect if selected, or start drawing
    if (selectedIdx !== null) {
      setSelectedIdx(null);
      return;
    }
    setIsDrawing(true); setDrawStart(pos); setDrawEnd(pos);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = getPos(e);
    if (!pos) return;

    if (draggingIdx !== null) {
      setRects(prev => prev.map((r, i) =>
        i === draggingIdx ? { ...r, x: pos.x - dragOffset.x, y: pos.y - dragOffset.y } : r
      ));
      return;
    }

    if (isDrawing) { setDrawEnd(pos); return; }

    // Hover cursor
    const hitIdx = hitTestRect(pos);
    if (containerRef.current) {
      containerRef.current.style.cursor = hitIdx !== null ? 'pointer' : 'crosshair';
    }
  };

  const handleMouseUp = () => {
    if (dragDelayTimer.current) {
      clearTimeout(dragDelayTimer.current);
      dragDelayTimer.current = null;
    }
    if (pendingDragRef.current && !didStartDrag.current) {
      setSelectedIdx(pendingDragRef.current.idx);
      pendingDragRef.current = null;
      return;
    }
    pendingDragRef.current = null;

    if (draggingIdx !== null) { setDraggingIdx(null); return; }
    if (!isDrawing || !drawStart || !drawEnd) return;
    setIsDrawing(false);
    const x = Math.min(drawStart.x, drawEnd.x);
    const y = Math.min(drawStart.y, drawEnd.y);
    const w = Math.abs(drawEnd.x - drawStart.x);
    const h = Math.abs(drawEnd.y - drawStart.y);
    if (w > 5 && h > 5) setRects(prev => [...prev, { x, y, width: w, height: h }]);
    setDrawStart(null); setDrawEnd(null);
  };

  const scaleRect = (idx: number, delta: number) => {
    setRects(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const newW = Math.max(10, r.width + delta);
      const newH = Math.max(10, r.height + delta * (r.height / r.width));
      // Keep centered
      const dx = (newW - r.width) / 2;
      const dy = (newH - r.height) / 2;
      return { x: r.x - dx, y: r.y - dy, width: newW, height: newH };
    }));
  };

  const handleSave = () => {
    if (!pageSize || !displaySize) { onSave([]); return; }
    const sx = pageSize.width / displaySize.width;
    const sy = pageSize.height / displaySize.height;
    onSave(rects.map(r => ({
      x: r.x * sx, y: pageSize.height - (r.y + r.height) * sy,
      width: r.width * sx, height: r.height * sy,
    })));
  };

  const currentDrawRect = drawStart && drawEnd ? {
    x: Math.min(drawStart.x, drawEnd.x), y: Math.min(drawStart.y, drawEnd.y),
    width: Math.abs(drawEnd.x - drawStart.x), height: Math.abs(drawEnd.y - drawStart.y),
  } : null;

  const stopAll = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); };

  return (
    <div className="fixed inset-0 bg-black/80 z-[1000] flex flex-col items-center">
      <div className="flex items-center gap-4 p-5 w-full justify-center">
        <span className="text-white font-medium text-sm">Page {pageIndex + 1} — Draw rectangles to redact</span>
        <div className="flex-1" />
        <Button variant="secondary" size="compact" onClick={() => { setRects(prev => prev.slice(0, -1)); setSelectedIdx(null); }}><Undo2 size={16} /></Button>
        <Button variant="secondary" size="compact" onClick={() => { setRects([]); setSelectedIdx(null); }}><Trash2 size={16} /></Button>
        <span className="text-white font-medium text-sm ml-4">{rects.length} rect{rects.length !== 1 ? 's' : ''}</span>
        <div className="flex-1" />
        <Button variant="secondary" size="compact" onClick={handleSave}>Save</Button>
        <Button variant="ghost" size="compact" onClick={onClose} className="text-white hover:text-white"><X size={20} /></Button>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-auto">
        <div ref={containerRef} className="relative select-none"
          style={{ ...(displaySize ? { width: displaySize.width, height: displaySize.height } : {}), cursor: 'crosshair' }}
          onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
          onMouseLeave={() => { if (isDrawing) handleMouseUp(); }}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
          {rects.map((r, i) => {
            const isSelected = selectedIdx === i;
            const isActive = draggingIdx === i;
            return (
              <div key={i}
                style={{
                  position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height,
                  backgroundColor: 'rgba(0,0,0,0.7)',
                  outline: isSelected ? '2px solid #4CAF7D' : isActive ? '2px solid #4CAF7D' : '2px solid red',
                  outlineOffset: -2,
                  cursor: isActive ? 'grabbing' : 'pointer',
                  pointerEvents: 'auto',
                }}>
                {/* Selection toolbar */}
                {isSelected && (
                  <div
                    onMouseDown={stopAll}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                    style={{
                      position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                      marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4,
                      background: 'rgba(30,30,30,0.95)', borderRadius: 6, padding: '4px 8px',
                      zIndex: 30, whiteSpace: 'nowrap',
                    }}>
                    <button
                      onMouseDown={stopAll}
                      onClick={(e) => { stopAll(e); scaleRect(i, -SCALE_STEP); }}
                      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Minus size={12} />
                    </button>
                    <span style={{ color: 'white', fontSize: 11, minWidth: 30, textAlign: 'center' }}>{Math.round(r.width)}×{Math.round(r.height)}</span>
                    <button
                      onMouseDown={stopAll}
                      onClick={(e) => { stopAll(e); scaleRect(i, SCALE_STEP); }}
                      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Plus size={12} />
                    </button>
                    <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
                    <button
                      onMouseDown={stopAll}
                      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                      onClick={(e) => { stopAll(e); setRects(prev => prev.filter((_, j) => j !== i)); setSelectedIdx(null); }}
                      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(220,50,50,0.8)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {currentDrawRect && currentDrawRect.width > 2 && (
            <div style={{ position: 'absolute', left: currentDrawRect.x, top: currentDrawRect.y, width: currentDrawRect.width, height: currentDrawRect.height, backgroundColor: 'rgba(0,0,0,0.3)', border: '2px dashed red', pointerEvents: 'none' }} />
          )}
        </div>
      </div>
    </div>
  );
};

export default RedactOverlay;
