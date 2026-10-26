import { useEffect, useRef, useState } from 'react';

export function useQuery<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, keepData = false) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(''); if (!keepData) setData(undefined);
    loaderRef.current(controller.signal).then(result => { if (active) setData(result); })
      .catch(problem => { if (active && !controller.signal.aborted) setError(errorMessage(problem)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [key, revision, keepData]);
  return { data, error, loading, refresh: () => setRevision(value => value + 1) };
}

export function useDebounced<T>(value: T, delay = 220) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setSettled(value), delay); return () => window.clearTimeout(timer); }, [value, delay]);
  return settled;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作没有完成，请稍后重试。';
}
