import { useEffect, useRef, useState } from 'react';

export interface ProgressLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'success';
  msg: string;
}

export interface ProgressState {
  stage: string;
  current: number;
  total: number;
  percent: number;
  message: string;
  keyword: string;
  updatedAt: number;
  stats: {
    pagesScraped: number;
    jobsParsed: number;
    jobsInserted: number;
    jobsSkipped: number;
    errors: number;
  };
  logs: ProgressLogEntry[];
}

/**
 * SSE-powered progress hook.
 * Connects to /api/progress/stream and receives real-time scrape progress.
 * Auto-reconnects on disconnect.
 */
export function useProgress() {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    function connect() {
      const es = new EventSource('/api/progress/stream');
      esRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (event) => {
        try {
          const data: ProgressState = JSON.parse(event.data);
          setProgress(data);
        } catch { /* ignore malformed */ }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        // Reconnect after 3s
        setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      esRef.current?.close();
    };
  }, []);

  const isActive = progress !== null
    && progress.stage !== 'idle'
    && progress.stage !== 'completed'
    && progress.stage !== 'error';

  return { progress, connected, isActive };
}
