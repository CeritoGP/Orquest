import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JobEvent } from "@orquest/contracts";
import { getEventsPage } from "./api.js";

export interface ActivityPanelProps {
  jobId: string | null;
  liveEvents?: readonly JobEvent[];
  className?: string;
  reloadKey?: number;
  onEventsChanged?: (events: readonly JobEvent[]) => void;
}

const PAGE_SIZE = 10;

function mergeBySequence(current: readonly JobEvent[], incoming: readonly JobEvent[]): JobEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

export function ActivityPanel({
  jobId,
  liveEvents = [],
  className = "",
  reloadKey = 0,
  onEventsChanged,
}: ActivityPanelProps): React.JSX.Element {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [recoveringEvents, setRecoveringEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [visibleAnchorSequence, setVisibleAnchorSequence] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const scrollAdjustRef = useRef<{ height: number; top: number } | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const eventsRef = useRef<JobEvent[]>([]);
  const historySequencesRef = useRef<Set<number>>(new Set());
  const observedReloadKeyRef = useRef(reloadKey);
  const latestReloadKeyRef = useRef(reloadKey);
  const onEventsChangedRef = useRef(onEventsChanged);

  latestReloadKeyRef.current = reloadKey;

  useEffect(() => {
    onEventsChangedRef.current = onEventsChanged;
  }, [onEventsChanged]);

  const mergeEvents = useCallback((incoming: readonly JobEvent[]) => {
    setEvents((current) => {
      const next = mergeBySequence(current, incoming);
      eventsRef.current = next;
      return next;
    });
  }, []);

  const loadLatestEvents = useCallback(async (id: string, resetPagination: boolean) => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const isCurrentRequest = () => currentJobIdRef.current === id && requestGenerationRef.current === generation;

    if (resetPagination) {
      setLoadingInitial(true);
      setRecoveringEvents(false);
    } else {
      // A reconnect supersedes an incomplete first request. Without this reset,
      // the invalidated request can leave the panel stuck on its initial loader.
      setLoadingInitial(false);
      setRecoveringEvents(true);
    }
    setLoadingOlder(false);
    setError(null);
    if (resetPagination) {
      setEvents([]);
      eventsRef.current = [];
      historySequencesRef.current = new Set();
      setNextCursor(null);
      setHasMore(false);
      setVisibleAnchorSequence(null);
      isAtBottomRef.current = true;
      scrollAdjustRef.current = null;
    }
    try {
      // SSE can already contain the newest event when a reconnect starts. It is
      // not proof that the persisted timeline between the old and new pages was
      // recovered, so only use previously fetched history as the overlap anchor.
      const knownHistorySequences = new Set(historySequencesRef.current);
      const hadKnownHistory = knownHistorySequences.size > 0;
      const incoming: JobEvent[] = [];
      let page = await getEventsPage(id, undefined, PAGE_SIZE, "backward");
      if (!isCurrentRequest()) return;
      incoming.push(...page.items);

      const overlapsKnownHistory = () => page.items.some((event) => knownHistorySequences.has(event.sequence));
      const seenCursors = new Set<string>();
      while (hadKnownHistory && !overlapsKnownHistory() && page.hasMore && page.nextCursor !== null) {
        if (seenCursors.has(page.nextCursor)) {
          throw new Error("El historial devolvió un cursor repetido durante la sincronización");
        }
        seenCursors.add(page.nextCursor);
        page = await getEventsPage(id, page.nextCursor, PAGE_SIZE, "backward");
        if (!isCurrentRequest()) return;
        incoming.push(...page.items);
      }

      mergeEvents(incoming);
      for (const event of incoming) historySequencesRef.current.add(event.sequence);
      if (resetPagination) {
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } else if (!hadKnownHistory || !page.hasMore) {
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      }
    } catch (cause) {
      if (isCurrentRequest()) {
        setError(cause instanceof Error ? cause.message : "No se pudo cargar la actividad del trabajo");
      }
    } finally {
      if (isCurrentRequest()) {
        if (resetPagination) setLoadingInitial(false);
        else setRecoveringEvents(false);
      }
    }
  }, [mergeEvents]);

  useEffect(() => {
    currentJobIdRef.current = jobId;
    observedReloadKeyRef.current = latestReloadKeyRef.current;
    if (jobId === null) {
      requestGenerationRef.current += 1;
      setEvents([]);
      eventsRef.current = [];
      historySequencesRef.current = new Set();
      setNextCursor(null);
      setHasMore(false);
      setVisibleAnchorSequence(null);
      setError(null);
      setLoadingInitial(false);
      setLoadingOlder(false);
      setRecoveringEvents(false);
      return;
    }
    void loadLatestEvents(jobId, true);
    return () => {
      requestGenerationRef.current += 1;
      if (currentJobIdRef.current === jobId) currentJobIdRef.current = null;
    };
  }, [jobId, loadLatestEvents]);

  useEffect(() => {
    if (jobId === null || reloadKey === observedReloadKeyRef.current) return;
    observedReloadKeyRef.current = reloadKey;
    void loadLatestEvents(jobId, false);
  }, [jobId, loadLatestEvents, reloadKey]);

  useEffect(() => {
    if (jobId === null || liveEvents.length === 0) return;
    mergeEvents(liveEvents.filter((event) => event.jobId === jobId));
  }, [jobId, liveEvents, mergeEvents]);

  useEffect(() => {
    onEventsChangedRef.current?.(events);
  }, [events]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const adjustment = scrollAdjustRef.current;
    if (adjustment) {
      el.scrollTop = adjustment.top + (el.scrollHeight - adjustment.height);
      scrollAdjustRef.current = null;
    } else if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events, loadingInitial]);

  const loadOlderEvents = useCallback(async (): Promise<readonly JobEvent[] | null> => {
    if (jobId === null || loadingInitial || loadingOlder || recoveringEvents || !hasMore || nextCursor === null) return null;
    const generation = requestGenerationRef.current;
    const isCurrentRequest = () => currentJobIdRef.current === jobId && requestGenerationRef.current === generation;
    const el = containerRef.current;
    if (el) scrollAdjustRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingOlder(true);
    try {
      const page = await getEventsPage(jobId, nextCursor, PAGE_SIZE, "backward");
      if (!isCurrentRequest()) return null;
      mergeEvents(page.items);
      for (const event of page.items) historySequencesRef.current.add(event.sequence);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      return page.items;
    } catch (cause) {
      if (isCurrentRequest()) {
        setError(cause instanceof Error ? cause.message : "Error al cargar eventos anteriores");
      }
      return null;
    } finally {
      if (isCurrentRequest()) setLoadingOlder(false);
    }
  }, [hasMore, jobId, loadingInitial, loadingOlder, mergeEvents, nextCursor, recoveringEvents]);

  const anchoredIndex = visibleAnchorSequence === null
    ? -1
    : events.findIndex((event) => event.sequence === visibleAnchorSequence);
  const visibleStart = anchoredIndex >= 0 ? anchoredIndex : Math.max(0, events.length - PAGE_SIZE);
  const visibleEnd = Math.min(events.length, visibleStart + PAGE_SIZE);
  const visibleEvents = events.slice(visibleStart, visibleEnd);
  const hasLoadedOlderPage = visibleStart > 0;
  const hasLoadedNewerPage = visibleEnd < events.length;

  const showOlderEvents = useCallback(async () => {
    if (loadingInitial || loadingOlder || recoveringEvents) return;
    if (hasLoadedOlderPage) {
      isAtBottomRef.current = false;
      setVisibleAnchorSequence(events[Math.max(0, visibleStart - PAGE_SIZE)]?.sequence ?? null);
      return;
    }
    if (!hasMore || nextCursor === null) return;
    // Keep the page the user was reading fixed while the older-page request is
    // in flight. Without this immediate anchor, incoming SSE events can move
    // the visible slice forward before the response supplies its older anchor.
    isAtBottomRef.current = false;
    setVisibleAnchorSequence(events[0]?.sequence ?? null);
    const page = await loadOlderEvents();
    if (page !== null && page.length > 0) setVisibleAnchorSequence(page[0]!.sequence);
  }, [events, hasLoadedOlderPage, hasMore, loadOlderEvents, loadingInitial, loadingOlder, nextCursor, recoveringEvents, visibleStart]);

  const showNewerEvents = useCallback(() => {
    if (!hasLoadedNewerPage) return;
    if (visibleEnd + PAGE_SIZE >= events.length) {
      isAtBottomRef.current = true;
      setVisibleAnchorSequence(null);
      return;
    }
    const nextAnchor = events[visibleEnd]?.sequence ?? null;
    setVisibleAnchorSequence(nextAnchor);
  }, [events, hasLoadedNewerPage, visibleEnd]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 30;
    if (el.scrollTop <= 24) void showOlderEvents();
  }, [showOlderEvents]);

  if (jobId === null) return <p className="empty">Selecciona un trabajo para ver su actividad.</p>;

  return (
    <div
      className={`activity-panel ${className}`.trim()}
      ref={containerRef}
      onScroll={handleScroll}
      tabIndex={0}
      role="region"
      aria-label="Panel de actividad del trabajo"
    >
      {loadingInitial && <div className="activity-status" role="status"><span className="status-dot" /> Cargando actividad…</div>}
      {error !== null && (
        <div className="activity-error" role="alert">
          <p>{error}</p>
          <button type="button" className="secondary" onClick={() => void loadLatestEvents(jobId, true)}>Reintentar</button>
        </div>
      )}
      {!loadingInitial && error === null && (
        <>
          {loadingOlder && <div className="activity-status" role="status"><span className="status-dot" /> Cargando eventos anteriores…</div>}
          {recoveringEvents && <div className="activity-status" role="status"><span className="status-dot" /> Recuperando eventos perdidos…</div>}
          {!loadingOlder && (hasLoadedOlderPage || hasMore) && (
            <button type="button" className="activity-load-more" onClick={() => void showOlderEvents()}>
              ↑ Mostrar eventos anteriores
            </button>
          )}
          {hasLoadedNewerPage && <button type="button" className="activity-load-more" onClick={showNewerEvents}>↓ Mostrar eventos más recientes</button>}
          {!loadingOlder && !hasLoadedOlderPage && !hasMore && events.length > 0 && <div className="activity-status muted">No hay más eventos</div>}
          {events.length > 0 && <div className="activity-status muted">Eventos {visibleStart + 1}–{visibleEnd} de {events.length} cargados</div>}
          {events.length === 0 ? <p className="empty">No hay eventos registrados para este trabajo.</p> : (
            <ol className="timeline">
              {visibleEvents.map((event) => (
                <li key={event.id}>
                  <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                  <span><b>{event.kind.replace("job.", "")}</b>{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
