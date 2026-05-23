import { useCallback, useRef, useState } from 'react';

interface HistoryState<T> {
  current: T;
  set: (val: T | ((prev: T) => T)) => void;
  /** Update without pushing onto the undo stack (incidental/derived changes). */
  update: (val: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  /** Coalesce all set() calls until endCoalesce() into a single history entry. */
  beginCoalesce: () => void;
  endCoalesce: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * History hook with a pure-updater contract.
 *
 * IMPORTANT: We do NOT mutate refs from inside the React state updater.
 * In StrictMode, React intentionally double-invokes updaters; if we pushed
 * to `pastRef` from inside the updater, a single edit would create two
 * history entries and the first Cmd+Z would silently no-op.
 *
 * Instead, we keep a synchronous `currentRef` mirror, compute the next
 * value outside any updater, perform the history bookkeeping exactly once,
 * then call setCurrent with the precomputed value (an idempotent assignment).
 */
export function useHistory<T>(
  initial: T,
  maxHistory = 30,
  equals: (a: T, b: T) => boolean = Object.is,
): HistoryState<T> {
  const [current, setCurrent] = useState<T>(initial);
  const currentRef = useRef<T>(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const coalesceRef = useRef<{ active: boolean; baseline: T | null }>({ active: false, baseline: null });
  // Re-render trigger for canUndo/canRedo recomputation
  const [, force] = useState(0);
  const tick = useCallback(() => force(v => v + 1), []);

  const set = useCallback((val: T | ((prev: T) => T)) => {
    const prev = currentRef.current;
    const next = typeof val === 'function' ? (val as (p: T) => T)(prev) : val;
    if (equals(next, prev)) return;
    if (coalesceRef.current.active) {
      if (coalesceRef.current.baseline === null) coalesceRef.current.baseline = prev;
    } else {
      pastRef.current = [...pastRef.current.slice(-(maxHistory - 1)), prev];
      futureRef.current = [];
    }
    currentRef.current = next;
    setCurrent(next);
    tick();
  }, [maxHistory, tick, equals]);

  const update = useCallback((val: T | ((prev: T) => T)) => {
    const prev = currentRef.current;
    const next = typeof val === 'function' ? (val as (p: T) => T)(prev) : val;
    if (Object.is(next, prev)) return;
    currentRef.current = next;
    setCurrent(next);
  }, []);

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    const previous = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, currentRef.current];
    currentRef.current = previous;
    setCurrent(previous);
    tick();
  }, [tick]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[futureRef.current.length - 1];
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current, currentRef.current];
    currentRef.current = next;
    setCurrent(next);
    tick();
  }, [tick]);

  const beginCoalesce = useCallback(() => {
    coalesceRef.current = { active: true, baseline: null };
  }, []);

  const endCoalesce = useCallback(() => {
    if (coalesceRef.current.active && coalesceRef.current.baseline !== null) {
      pastRef.current = [...pastRef.current.slice(-(maxHistory - 1)), coalesceRef.current.baseline];
      futureRef.current = [];
    }
    coalesceRef.current = { active: false, baseline: null };
    tick();
  }, [maxHistory, tick]);

  return {
    current,
    set,
    update,
    undo,
    redo,
    beginCoalesce,
    endCoalesce,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}
