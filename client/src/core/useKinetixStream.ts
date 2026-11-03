import { useRef, useCallback, useEffect } from 'react';
import { KinetixSseEvent } from './types';
import { apiUrl, apiHeaders } from './apiConfig';

export function useKinetixStream() {
  const abortControllerRef = useRef<AbortController | null>(null);

  const runStream = async (
    frameBase64: string | null,
    voiceText: string,
    onEvent: (event: KinetixSseEvent) => void,
    onError: (err: unknown) => void
  ) => {
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(apiUrl('/api/orchestrate-stream'), {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ frameBase64, voiceTranscript: voiceText }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} from orchestrator`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedTerminalEvent = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const eventMatch = chunk.match(/event:\s*(.+)/);
          const dataMatch = chunk.match(/data:\s*(.+)/);
          if (!eventMatch || !dataMatch) continue;

          const eventName = eventMatch[1].trim() as KinetixSseEvent['event'];
          if (eventName === 'ORCHESTRATION_COMPLETE' || eventName === 'ORCHESTRATION_ERROR') {
            receivedTerminalEvent = true;
          }
          try {
            const payload = JSON.parse(dataMatch[1].trim());
            onEvent({ event: eventName, data: payload } as KinetixSseEvent);
          } catch {
            // skip malformed payload
          }
        }
      }

      if (!receivedTerminalEvent && !abortControllerRef.current?.signal.aborted) {
        onError(new Error('SSE stream closed prematurely before ORCHESTRATION_COMPLETE'));
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      onError(err);
    }
  };

  const abortStream = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => () => abortStream(), [abortStream]);

  return { runStream, abortStream };
}
