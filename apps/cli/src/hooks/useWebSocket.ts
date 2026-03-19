import { useEffect, useRef, useState } from 'react';
import type { CliStore, PendingAction } from '../store/index.js';

// ─── Message parsing (exported for testing) ────────────────────

export interface WSMessage {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export function parseWSMessage(raw: string): WSMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.type !== 'string') return null;
    return parsed as WSMessage;
  } catch {
    return null;
  }
}

// ─── Store dispatch (exported for testing) ─────────────────────

export function applyWSMessageToStore(store: CliStore, msg: WSMessage): void {
  const state = store.getState();

  switch (msg.type) {
    case 'job_status_changed':
      if (state.jobData) {
        state.setJobData({ ...state.jobData, status: msg.data.to as string });
      }
      break;

    case 'schema_evolved':
      if (state.schemaData) {
        state.setSchemaData({
          ...state.schemaData,
          version: msg.data.version,
          _lastEvent: msg.data,
        });
      }
      break;

    case 'action_pending': {
      const action: PendingAction = {
        id: msg.data.actionId as string,
        type: msg.data.type as string,
        confidence: msg.data.confidence as number | undefined,
        status: 'pending_review',
      };
      state.setPendingActions([action, ...state.pendingActions]);
      state.setRecentActions([action, ...state.recentActions].slice(0, 20));
      break;
    }

    case 'entity_created': {
      const preview = {
        id: msg.data.entityId as string,
        name: msg.data.name as string,
      };
      state.setEntityPreviews([...state.entityPreviews, preview].slice(-5));
      break;
    }

    // crawl_progress, task_completed, error, connected, ping — no store dispatch needed
    default:
      break;
  }
}

// ─── React hook ────────────────────────────────────────────────

export interface UseWebSocketResult {
  connected: boolean;
  error: string | null;
}

export function useWebSocket(
  store: CliStore,
  baseUrl: string,
  tenantId: string,
  jobId: string,
): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (!jobId) return;

    // Convert http(s):// to ws(s):// and pass tenantId as query param
    // (WebSocket constructor doesn't support custom HTTP headers)
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws/jobs/${jobId}/progress?tenantId=${tenantId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      const msg = parseWSMessage(typeof evt.data === 'string' ? evt.data : '');
      if (msg) {
        applyWSMessageToStore(store, msg);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setError('WebSocket connection error');
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
    };

    return () => {
      mountedRef.current = false;
      ws.close();
      wsRef.current = null;
    };
  }, [store, baseUrl, tenantId, jobId]);

  return { connected, error };
}
