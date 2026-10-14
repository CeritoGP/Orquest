import type { DashboardEvent, EventPageDirection, JobDiffResponse, JobEvent, JobInput, JobRecord, PaginatedEventsResponse, PaginatedJobsResponse } from "@orquest/contracts";

export type ExecutionProfile = {
  model?: string;
  effort?: string;
  agent?: string;
  accessMode?: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.text();
  let payload: T & { error?: string };
  try {
    payload = JSON.parse(body) as T & { error?: string };
  } catch {
    if (!response.ok) throw new Error(`Daemon unavailable (HTTP ${response.status})`);
    throw new Error("Daemon returned an invalid JSON response");
  }
  if (!response.ok) throw new Error(payload.error ?? `Request failed (HTTP ${response.status})`);
  return payload;
}

export async function listJobs(): Promise<JobRecord[]> {
  const response = await request<PaginatedJobsResponse>("/api/jobs?limit=100");
  return response.items;
}

export async function listProfiles(): Promise<Record<string, ExecutionProfile>> {
  const response = await request<{ profiles: Record<string, ExecutionProfile> }>("/api/profiles");
  return response.profiles;
}

export async function createJob(input: JobInput): Promise<JobRecord> {
  const response = await request<{ job: JobRecord }>("/api/jobs", { method: "POST", body: JSON.stringify(input) });
  return response.job;
}

export async function getEventsPage(jobId: string, cursor?: string, limit = 20, direction: EventPageDirection = "forward"): Promise<PaginatedEventsResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (direction === "backward") params.set("direction", direction);
  if (cursor !== undefined && cursor.length > 0) {
    params.set("cursor", cursor);
  }
  return request<PaginatedEventsResponse>(`/api/jobs/${jobId}/events?${params.toString()}`);
}

export async function getEvents(jobId: string, limit = 100): Promise<JobEvent[]> {
  const response = await request<PaginatedEventsResponse>(`/api/jobs/${jobId}/events?limit=${limit}`);
  return response.items;
}

export async function getDiff(jobId: string): Promise<JobDiffResponse> {
  return request<JobDiffResponse>(`/api/jobs/${jobId}/diff?limit=100`);
}

export async function cancelJob(jobId: string): Promise<JobRecord> {
  const response = await request<{ job: JobRecord }>(`/api/jobs/${jobId}/cancel`, { method: "POST", body: "{}" });
  return response.job;
}

export function subscribeToJobs(
  onEvent: (event: DashboardEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
  onReconnected?: () => void,
): () => void {
  const events = new EventSource("/api/events/stream");
  const handler = (event: MessageEvent<string>) => onEvent(JSON.parse(event.data) as DashboardEvent);
  let opened = false;
  events.onopen = () => {
    if (opened) onReconnected?.();
    opened = true;
    onConnectionChange?.(true);
  };
  events.onerror = () => onConnectionChange?.(false);
  events.addEventListener("job.updated", handler);
  return () => {
    onConnectionChange?.(false);
    events.removeEventListener("job.updated", handler);
    events.close();
  };
}
