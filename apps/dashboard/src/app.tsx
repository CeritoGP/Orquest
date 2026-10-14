import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobDiffResponse, JobEvent, JobRecord, JobStatus } from "@orquest/contracts";
import { ActivityPanel } from "./activity-panel.js";
import { cancelJob, getDiff, listJobs, listProfiles, subscribeToJobs, type ExecutionProfile } from "./api.js";
import { reconcileJobs, sameEventSeries } from "./dashboard-state.js";

type ViewId = "kanban" | "agents" | "sessions" | "logs" | "profiles" | "settings";
type Column = { title: string; statuses: readonly JobStatus[] };
type Subagent = { id: string; name: string; state: string | null; model: string | null };

const columns: readonly Column[] = [
  { title: "TRIAGE", statuses: ["TRIAGE", "TODO"] },
  { title: "READY", statuses: ["READY", "QUEUED"] },
  { title: "IN PROGRESS", statuses: ["RUNNING", "VERIFYING", "CANCELING"] },
  { title: "BLOCKED", statuses: ["BLOCKED", "FAILED", "CANCELED"] },
  { title: "DONE", statuses: ["DONE"] },
];

const TERMINAL_STATUSES: readonly JobStatus[] = ["DONE", "BLOCKED", "FAILED", "CANCELED"];

const views: readonly { id: ViewId; label: string }[] = [
  { id: "kanban", label: "Kanban" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "logs", label: "Logs" },
  { id: "profiles", label: "Profiles" },
  { id: "settings", label: "Settings" },
];

function mergeJob(current: JobRecord[], next: JobRecord): JobRecord[] {
  const index = current.findIndex((job) => job.id === next.id);
  if (index < 0) return [next, ...current];
  const result = current.slice();
  result[index] = next;
  return result;
}

function mergeEvent(current: JobEvent[], next: JobEvent): JobEvent[] {
  return current.some((event) => event.id === next.id) ? current : [...current, next];
}

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function formatShortTime(isoString: string | null): string {
  if (isoString === null) return "—";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(isoString: string | null): string {
  if (isoString === null) return "Sin registro";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "Sin registro";
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(startedAt: string | null, stoppedAt: string | null, executionStopped = false): string {
  if (startedAt === null) return "No iniciada";
  const startMs = Date.parse(startedAt);
  if (isNaN(startMs)) return "—";
  if (stoppedAt === null && executionStopped) return "Sin registro";
  const endMs = stoppedAt !== null ? Date.parse(stoppedAt) : Date.now();
  if (isNaN(endMs)) return "—";
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getStatusLabel(status: JobStatus): string {
  switch (status) {
    case "DONE":
      return "Finalizado";
    case "BLOCKED":
      return "Bloqueado";
    case "FAILED":
      return "Fallido";
    case "CANCELED":
      return "Cancelado";
    case "RUNNING":
      return "En ejecución";
    case "VERIFYING":
      return "Verificando";
    case "CANCELING":
      return "Cancelando";
    case "QUEUED":
      return "En cola";
    case "READY":
      return "Listo";
    case "TRIAGE":
      return "Triaje";
    case "TODO":
      return "Pendiente";
    default:
      return status;
  }
}

function getStatusDotClass(status: JobStatus): string {
  switch (status) {
    case "DONE":
      return "dot-done";
    case "BLOCKED":
      return "dot-blocked";
    case "FAILED":
      return "dot-failed";
    case "CANCELED":
      return "dot-canceled";
    case "RUNNING":
      return "dot-running";
    case "VERIFYING":
      return "dot-verifying";
    case "CANCELING":
      return "dot-canceling";
    case "QUEUED":
      return "dot-queued";
    case "READY":
      return "dot-ready";
    case "TRIAGE":
    case "TODO":
    default:
      return "dot-idle";
  }
}

function getNoticeStorageKey(job: JobRecord): string {
  return `orquest:terminal:v1:${job.id}:${job.finishedAt ?? job.stoppedAt ?? "unknown"}`;
}

function subagentFromEvent(event: JobEvent): Subagent | null {
  const value = event.payload.subagent;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const info = value as Record<string, unknown>;
  if (typeof info.name !== "string") return null;
  return {
    id: typeof info.id === "string" ? info.id : info.name,
    name: info.name,
    state: typeof info.state === "string" ? info.state : null,
    model: typeof info.model === "string" ? info.model : null,
  };
}

export function App(): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewId>("kanban");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ExecutionProfile>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<JobEvent[]>([]);
  const [activityEvents, setActivityEvents] = useState<JobEvent[]>([]);
  const [activityReloadKey, setActivityReloadKey] = useState(0);
  const [diff, setDiff] = useState<JobDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [unseenTerminalIds, setUnseenTerminalIds] = useState<Set<string>>(new Set());
  const [, setClockTick] = useState(0);

  const selectedIdRef = useRef<string | null>(null);
  const jobsRef = useRef<JobRecord[]>([]);
  const isInitialLoadRef = useRef(true);
  const refreshGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);

  const refreshDashboard = useCallback(async () => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    try {
      const [loadedJobs, loadedProfiles] = await Promise.all([listJobs(), listProfiles()]);
      if (refreshGenerationRef.current !== generation) return;
      const previousJobs = jobsRef.current;
      const reconciledJobs = reconcileJobs(previousJobs, loadedJobs);
      setJobs(reconciledJobs);
      jobsRef.current = reconciledJobs;
      setProfiles(loadedProfiles);
      setError(null);

      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
        try {
          for (const job of reconciledJobs) {
            if (TERMINAL_STATUSES.includes(job.status) && localStorage.getItem(getNoticeStorageKey(job)) === "unseen") {
              setUnseenTerminalIds((current) => new Set(current).add(job.id));
            }
          }
        } catch {
          // ignore localStorage errors (e.g. private browsing)
        }
      } else {
        const previousById = new Map(previousJobs.map((job) => [job.id, job]));
        for (const job of reconciledJobs) {
          const previous = previousById.get(job.id);
          const newlySettled = TERMINAL_STATUSES.includes(job.status)
            && (previous === undefined
              || !TERMINAL_STATUSES.includes(previous.status)
              || previous.finishedAt !== job.finishedAt
              || previous.stoppedAt !== job.stoppedAt);
          if (newlySettled && selectedIdRef.current !== job.id) {
            try {
              if (localStorage.getItem(getNoticeStorageKey(job)) !== "seen") {
                localStorage.setItem(getNoticeStorageKey(job), "unseen");
                setUnseenTerminalIds((current) => new Set(current).add(job.id));
              }
            } catch {
              setUnseenTerminalIds((current) => new Set(current).add(job.id));
            }
          }
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load dashboard data");
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
    return subscribeToJobs((event) => {
      setJobs((current) => {
        const next = mergeJob(current, event.job);
        jobsRef.current = next;
        return next;
      });
      if (event.job.id === selectedIdRef.current) {
        setLiveEvents((current) => mergeEvent(current, event.event));
      }

      // Check unseen terminal completion notice
      if (TERMINAL_STATUSES.includes(event.job.status)) {
        const isSelected = selectedIdRef.current === event.job.id;
        const key = getNoticeStorageKey(event.job);
        if (isSelected) {
          try {
            localStorage.setItem(key, "seen");
          } catch {
            // ignore localStorage errors
          }
        } else {
          try {
            if (localStorage.getItem(key) !== "seen") {
              localStorage.setItem(key, "unseen");
              setUnseenTerminalIds((prev) => new Set(prev).add(event.job.id));
            }
          } catch {
            // ignore localStorage errors
          }
        }
      }
    }, setConnected, () => {
      void refreshDashboard();
      setActivityReloadKey((current) => current + 1);
    });
  }, [refreshDashboard]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (selectedId === null) {
      detailGenerationRef.current += 1;
      setLiveEvents([]);
      setActivityEvents([]);
      setDiff(null);
      return;
    }
    const generation = detailGenerationRef.current + 1;
    detailGenerationRef.current = generation;
    setLiveEvents([]);
    setActivityEvents([]);
    setDiff(null);
    void getDiff(selectedId)
      .then((loadedDiff) => {
        if (detailGenerationRef.current === generation && selectedIdRef.current === selectedId) {
          setDiff(loadedDiff);
        }
      })
      .catch((cause: unknown) => {
        if (detailGenerationRef.current === generation && selectedIdRef.current === selectedId) {
          setError(cause instanceof Error ? cause.message : "Unable to load job detail");
        }
      });
  }, [selectedId]);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;
  const hasActiveExecution = jobs.some((job) => job.startedAt !== null && !TERMINAL_STATUSES.includes(job.status));
  useEffect(() => {
    if (!hasActiveExecution) return;
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveExecution]);

  const subagents = useMemo(() => {
    const byId = new Map<string, Subagent>();
    for (const event of activityEvents) {
      const subagent = subagentFromEvent(event);
      if (subagent !== null) byId.set(subagent.id, subagent);
    }
    return [...byId.values()];
  }, [activityEvents]);
  const byColumn = useMemo(() => columns.map((column) => ({
    ...column,
    jobs: jobs.filter((job) => column.statuses.includes(job.status)),
  })), [jobs]);
  const profileEntries = useMemo(() => Object.entries(profiles).sort(([left], [right]) => left.localeCompare(right)), [profiles]);
  const sessions = useMemo(() => jobs.filter((job) => job.conversationId !== null || job.parentJobId !== null), [jobs]);
  const handleActivityEventsChanged = useCallback((loadedEvents: readonly JobEvent[]) => {
    setActivityEvents((current) => sameEventSeries(current, loadedEvents) ? current : [...loadedEvents]);
  }, []);

  const selectJob = useCallback((jobId: string, view?: ViewId) => {
    selectedIdRef.current = jobId;
    setSelectedId(jobId);
    if (view !== undefined) setActiveView(view);

    setUnseenTerminalIds((prev) => {
      if (!prev.has(jobId)) return prev;
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });

    const targetJob = jobsRef.current.find((j) => j.id === jobId);
    if (targetJob && TERMINAL_STATUSES.includes(targetJob.status)) {
      try {
        localStorage.setItem(getNoticeStorageKey(targetJob), "seen");
      } catch {
        // ignore storage errors
      }
    }
  }, []);

  const cancelSelected = useCallback(async () => {
    if (selected === null) return;
    try {
      const job = await cancelJob(selected.id);
      setJobs((current) => {
        const next = mergeJob(current, job);
        jobsRef.current = next;
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel job");
    }
  }, [selected]);

  const viewTitle = views.find((view) => view.id === activeView)?.label ?? "Kanban";

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand"><span>ORQUEST</span><small>BRIDGE</small></div>
        <nav>
          {views.map((view) => <button className={`nav-button ${activeView === view.id ? "active" : ""}`} key={view.id} type="button" onClick={() => setActiveView(view.id)}>{view.label}</button>)}
        </nav>
        <div className="system-status"><span className="status-dot" /> Local daemon<br /><small>127.0.0.1:4317</small></div>
      </aside>

      <section className="workspace" aria-label={`${viewTitle} workspace`}>
        <header className="topbar">
          <div><p className="eyebrow">CONTROL PLANE</p><h1>{viewTitle}</h1></div>
          <div className="toolbar">
            <span className={`live ${connected ? "" : "offline"}`}><span className="status-dot" /> {connected ? "LIVE" : "RECONNECTING"}</span>
            <button className="secondary" type="button" onClick={() => void refreshDashboard()}>Refresh</button>
          </div>
        </header>
        {error !== null && <p className="error" role="alert">{error}</p>}

        {activeView === "kanban" && <div className="kanban" aria-label="Job status board">
          {byColumn.map((column) => <section className="column" key={column.title}>
            <header><h2>{column.title}</h2><span>{column.jobs.length}</span></header>
            <div className="card-stack">
              {column.jobs.length === 0 ? <p className="empty">No jobs</p> : column.jobs.map((job) => {
                const isUnseen = unseenTerminalIds.has(job.id);
                const executionStopped = TERMINAL_STATUSES.includes(job.status);
                const stoppedAt = job.finishedAt ?? job.stoppedAt;
                return (
                  <button
                    className={`job-card ${selectedId === job.id ? "selected" : ""} ${isUnseen ? "card-unseen" : ""}`}
                    key={job.id}
                    type="button"
                    onClick={() => selectJob(job.id)}
                  >
                    <div className="card-top">
                      <span className="card-id">#{shortId(job.id)}</span>
                      <span className={`status-badge status-${job.status.toLowerCase()}`}>
                        <span className={`status-dot-indicator ${getStatusDotClass(job.status)} ${isUnseen ? "pulsing-unseen" : ""}`} />
                        {getStatusLabel(job.status)}
                        {isUnseen && <span className="badge-new">NUEVO</span>}
                      </span>
                    </div>
                    <strong>{job.title}</strong>
                    <span className="card-meta">{job.agent ?? job.profileId} / {job.model}</span>
                    <div className="card-timing">
                      {job.startedAt && (
                        <span className="timing-item" title={`Inicio: ${formatDateTime(job.startedAt)}`}>
                          Inicio: {formatShortTime(job.startedAt)}
                        </span>
                      )}
                      {stoppedAt && (
                        <span className="timing-item" title={`${job.finishedAt ? "Fin" : "Pausa"}: ${formatDateTime(stoppedAt)}`}>
                          {job.finishedAt ? "Fin" : "Pausa"}: {formatShortTime(stoppedAt)}
                        </span>
                      )}
                      {job.startedAt && (
                        <span className="timing-item" title="Duración transcurrida / total">
                          ⏱ {formatDuration(job.startedAt, stoppedAt, executionStopped)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>)}
        </div>}

        {activeView === "agents" && <section className="view-panel">
          <p className="eyebrow">WORKER HIERARCHY</p>
          {selected === null ? <p className="empty">Select a job in Kanban or Sessions to inspect its worker and reported subagents.</p> : <>
            <h2>{selected.title}</h2><p className="muted">Primary worker: {selected.agent ?? selected.profileId} / {selected.model} / {selected.effort}</p>
            {subagents.length === 0 ? <p className="empty">This worker did not report subagents. Orquest only displays data emitted by Antigravity.</p> : <ul className="agent-list expanded">{subagents.map((agent) => <li key={agent.id}><b>{agent.name}</b><span>{agent.state ?? "UNKNOWN"}{agent.model ? ` / ${agent.model}` : ""}</span></li>)}</ul>}
          </>}
        </section>}

        {activeView === "sessions" && <section className="view-panel">
          <p className="eyebrow">CONVERSATIONS AND RETRIES</p>
          {sessions.length === 0 ? <p className="empty">No continuation or retry sessions have been created yet.</p> : <ul className="record-list">{sessions.map((job) => <li key={job.id}><button type="button" onClick={() => selectJob(job.id)}><b>#{shortId(job.id)} — {job.title}</b><span>{job.conversationId ? "conversation available" : "linked attempt"} / {getStatusLabel(job.status)}</span></button></li>)}</ul>}
        </section>}

        {activeView === "logs" && <section className="view-panel">
          <p className="eyebrow">PERSISTED EVENT LOG</p>
          {selected === null ? (
            <p className="empty">Select a job to view its persisted, redacted event timeline.</p>
          ) : (
            <>
              <h2>{selected.title}</h2>
              <ActivityPanel
                jobId={selected.id}
                liveEvents={liveEvents}
                reloadKey={activityReloadKey}
                onEventsChanged={handleActivityEventsChanged}
                className="activity-panel-expanded"
              />
            </>
          )}
        </section>}

        {activeView === "profiles" && <section className="view-panel">
          <p className="eyebrow">EXECUTION DEFAULTS</p><h2>Profiles</h2>
          {profileEntries.length === 0 ? <p className="empty">No profiles available.</p> : <ul className="profile-list">{profileEntries.map(([id, profile]) => <li key={id}><b>{id}</b><span>{profile.agent ?? "default"} / {profile.model ?? "auto"} / {profile.effort ?? "medium"} / {profile.accessMode ?? "read-only"}</span></li>)}</ul>}
          <p className="muted">Edit the YAML profile file and restart the daemon to change these defaults.</p>
        </section>}

        {activeView === "settings" && <section className="view-panel">
          <p className="eyebrow">LOCAL RUNTIME</p><h2>Settings</h2>
          <dl className="settings-list"><div><dt>Daemon</dt><dd>127.0.0.1:4317 — loopback only</dd></div><div><dt>Dashboard</dt><dd>127.0.0.1:4318</dd></div><div><dt>Runner</dt><dd>Configured by <code>ORQUEST_RUNNER</code>; use <code>agy</code> only for real workers.</dd></div><div><dt>Profiles</dt><dd>Set <code>ORQUEST_PROFILES_PATH</code> to a private YAML file, then restart the daemon.</dd></div><div><dt>Create work</dt><dd>Ask Codex to use <code>orquest_submit_jobs</code>. This dashboard observes and safely controls jobs; it does not become a second orchestrator.</dd></div></dl>
        </section>}
      </section>

      <aside className="detail-panel" aria-label="Detalle del trabajo" tabIndex={0} aria-live="polite">
        {selected === null ? <div className="detail-empty"><p>Select a job</p><small>Its activity, configuration and result will appear here.</small></div> : <>
          <header className="detail-header">
            <div className="card-top">
              <p className="eyebrow">JOB #{shortId(selected.id)}</p>
              <span className={`status-badge status-${selected.status.toLowerCase()}`}>
                <span className={`status-dot-indicator ${getStatusDotClass(selected.status)}`} />
                {getStatusLabel(selected.status)}
              </span>
            </div>
            <h2>{selected.title}</h2>
            <p className="muted">{selected.agent ?? selected.profileId} / {selected.model} / {selected.effort}</p>
            {["QUEUED", "RUNNING", "VERIFYING"].includes(selected.status) && <button className="danger" type="button" onClick={() => void cancelSelected()}>Cancel job</button>}
          </header>
          <section className="detail-section">
            <h3>Tiempos de Ejecución</h3>
            <div className="timing-grid">
              <div className="timing-row">
                <span className="timing-label">Creado</span>
                <time className="timing-value" title={selected.createdAt}>{formatDateTime(selected.createdAt)}</time>
              </div>
              <div className="timing-row">
                <span className="timing-label">Inicio</span>
                <time className="timing-value" title={selected.startedAt ?? ""}>
                  {selected.startedAt ? formatDateTime(selected.startedAt) : "No iniciado"}
                </time>
              </div>
              <div className="timing-row">
                <span className="timing-label">{selected.finishedAt ? "Finalización" : selected.stoppedAt ? "Última parada" : "Finalización"}</span>
                <time className="timing-value" title={selected.finishedAt ?? selected.stoppedAt ?? ""}>
                  {selected.finishedAt
                    ? formatDateTime(selected.finishedAt)
                    : selected.stoppedAt
                      ? formatDateTime(selected.stoppedAt)
                    : TERMINAL_STATUSES.includes(selected.status)
                      ? "Sin registro"
                      : "En curso / Pendiente"}
                </time>
              </div>
              <div className="timing-row">
                <span className="timing-label">Duración total</span>
                <span className="timing-value">{formatDuration(selected.startedAt, selected.finishedAt ?? selected.stoppedAt, TERMINAL_STATUSES.includes(selected.status))}</span>
              </div>
            </div>
          </section>
          {activeView !== "logs" && <section className="detail-section">
            <h3>Activity</h3>
            <ActivityPanel
              jobId={selected.id}
              liveEvents={liveEvents}
              reloadKey={activityReloadKey}
              onEventsChanged={handleActivityEventsChanged}
            />
          </section>}
          <section className="detail-section"><h3>Execution</h3><p className="muted">Agent: {selected.agent ?? selected.profileId}</p><p className="muted">Access: {selected.accessMode}{selected.worktreePath ? " / isolated worktree" : ""}</p>{selected.dependsOnJobIds.length > 0 && <p className="muted">Depends on: {selected.dependsOnJobIds.map(shortId).join(", ")}</p>}{selected.reviewOfJobId && <p className="muted">Review of: #{shortId(selected.reviewOfJobId)}</p>}</section>
          <section className="detail-section"><h3>Agents</h3>{subagents.length === 0 ? <p className="muted">No subagents reported by the worker.</p> : <ul className="agent-list">{subagents.map((agent) => <li key={agent.id}><b>{agent.name}</b><span>{agent.state ?? "UNKNOWN"}{agent.model ? ` / ${agent.model}` : ""}</span></li>)}</ul>}</section>
          <section className="detail-section"><h3>Changes</h3>{diff === null ? <p className="muted">Loading diff...</p> : !diff.available ? <p className="muted">{diff.reason ?? "No worktree diff is available."}</p> : <>{diff.files.length === 0 ? <p className="muted">No changed files reported.</p> : <ul className="file-list">{diff.files.map((file) => <li key={file}>{file}</li>)}</ul>}{diff.diff && <pre className="diff-output">{diff.diff}</pre>}</>}</section>
          <section className="detail-section"><h3>Tests</h3>{selected.result === null || selected.result.tests.length === 0 ? <p className="muted">No verification results yet.</p> : <ul className="test-list">{selected.result.tests.map((test) => <li key={`${test.command}:${test.status}`}><b className={`test-${test.status}`}>{test.status}</b><code>{test.command}</code></li>)}</ul>}</section>
          <section className="detail-section"><h3 id="job-result-heading">Result</h3>{selected.result === null ? <p className="muted">No result yet.</p> : <><div key={selected.id} className="result-output" role="region" aria-labelledby="job-result-heading" tabIndex={0}><p>{selected.result.summary}</p></div><p className="muted">Tests: {selected.result.tests.length} / Files: {selected.result.filesChanged.length}</p></>}</section>
        </>}
      </aside>
    </main>
  );
}
