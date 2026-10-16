import { useEffect, useRef, useState } from 'react';
import type { SharedState, TownAction } from '../shared/town';
export function useSharedTown(enabled: boolean, watching: boolean) {
  const [data, setData] = useState<SharedState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef<{ body: string; id: string } | null>(null);
  const busy = useRef(false);
  const [connection] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!enabled) return;
    const stream = new EventSource(`/api/stream?connection=${connection}`);
    stream.onmessage = (event) => {
      try {
        setData(JSON.parse(event.data));
        setConnected(true);
      } catch {
        setError('无法读取小镇状态，请刷新重连。');
      }
    };
    stream.onerror = () => setConnected(false);
    return () => stream.close();
  }, [enabled, connection]);
  useEffect(() => {
    if (!enabled || !connected) return;
    const update = () => {
      void fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible: watching && !document.hidden, connection }),
      }).catch(() => {});
    };
    update();
    const timer = setInterval(update, 30000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled, connected, watching, connection]);
  async function command(action: TownAction | { type: 'retry'; id: number }) {
    if (busy.current) return false;
    busy.current = true;
    setSending(true);
    setError('');
    const body = JSON.stringify(action);
    // A lost HTTP acknowledgement can be retried safely, without charging twice.
    const requestId = pending.current?.body === body ? pending.current.id : crypto.randomUUID();
    pending.current = { body, id: requestId };
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action }),
      });
      const result = await response.json();
      if (!response.ok) {
        pending.current = null;
        throw new Error(result.error || '提交失败');
      }
      pending.current = null;
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接中断，请重试');
      return false;
    } finally {
      busy.current = false;
      setSending(false);
    }
  }
  async function cancel(id: number) {
    try {
      const response = await fetch(`/api/commands/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error((await response.json()).error);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消失败');
    }
  }
  return { data, connected, error, sending, command, cancel, clearError: () => setError('') };
}
