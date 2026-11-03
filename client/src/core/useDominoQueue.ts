import { useRef, useCallback, useEffect } from 'react';

export function useDominoQueue(stepDelayMs = 180) {
  const queueRef = useRef<Array<() => Promise<void> | void>>([]);
  const isProcessingRef = useRef(false);
  const generationRef = useRef(0);

  const clearQueue = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];
    isProcessingRef.current = false;
  }, []);

  const processQueue = useCallback(
    async (activeGen: number) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      while (queueRef.current.length > 0) {
        if (generationRef.current !== activeGen) break;
        const task = queueRef.current.shift();
        if (task) {
          await task();
          if (generationRef.current !== activeGen) break;
          await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        }
      }

      if (generationRef.current === activeGen) {
        isProcessingRef.current = false;
      }
    },
    [stepDelayMs]
  );

  const enqueue = useCallback(
    (task: () => Promise<void> | void) => {
      const currentGen = generationRef.current;
      queueRef.current.push(task);
      void processQueue(currentGen);
    },
    [processQueue]
  );

  useEffect(() => () => clearQueue(), [clearQueue]);

  return { enqueue, clearQueue };
}
