import { useCallback, useRef, useState } from 'react';

interface HistoryState<T> {
  current: T;
  set: (val: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory<T>(initial: T, maxHistory = 50): HistoryState<T> {
  const [current, setCurrent] = useState<T>(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);

  const set = useCallback((val: T | ((prev: T) => T)) => {
    setCurrent(prev => {
      const next = typeof val === 'function' ? (val as (p: T) => T)(prev) : val;
      pastRef.current = [...pastRef.current.slice(-maxHistory), prev];
      futureRef.current = [];
      return next;
    });
  }, [maxHistory]);

  const undo = useCallback(() => {
    setCurrent(prev => {
      if (pastRef.current.length === 0) return prev;
      const previous = pastRef.current[pastRef.current.length - 1];
      pastRef.current = pastRef.current.slice(0, -1);
      futureRef.current = [...futureRef.current, prev];
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setCurrent(prev => {
      if (futureRef.current.length === 0) return prev;
      const next = futureRef.current[futureRef.current.length - 1];
      futureRef.current = futureRef.current.slice(0, -1);
      pastRef.current = [...pastRef.current, prev];
      return next;
    });
  }, []);

  return {
    current,
    set,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}
