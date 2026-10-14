import { afterEach, describe, expect, it, vi } from "vitest";
import { getDiff, getEvents, getEventsPage, listJobs, listProfiles, subscribeToJobs } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard API client", () => {
  it("reads jobs from the paginated daemon contract", async () => {
    const job = { id: "job-1" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [job], nextCursor: null, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listJobs()).resolves.toEqual([job]);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs?limit=100", expect.any(Object));
  });

  it("reads effective execution profiles", async () => {
    const profiles = { quick: { effort: "low", accessMode: "read-only" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ profiles }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProfiles()).resolves.toEqual(profiles);
    expect(fetchMock).toHaveBeenCalledWith("/api/profiles", expect.any(Object));
  });

  it("reads a paginated worktree diff", async () => {
    const diff = { jobId: "job-1", available: true, files: ["src/app.ts"], diff: "diff --git", nextCursor: null, hasMore: false };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(diff), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDiff("job-1")).resolves.toEqual(diff);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/diff?limit=100", expect.any(Object));
  });

  it("reads activity from the paginated transcript contract", async () => {
    const event = { id: "event-1" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [event], nextCursor: null, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getEvents("job-1")).resolves.toEqual([event]);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/events?limit=100", expect.any(Object));
  });

  it("reads a specific page of events with opaque cursor and limit", async () => {
    const event = { id: "event-2" };
    const pageResponse = { items: [event], nextCursor: "cursor-abc-123", hasMore: true };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(pageResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getEventsPage("job-1", "cursor-prev-xyz", 10);
    expect(result).toEqual(pageResponse);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/events?limit=10&cursor=cursor-prev-xyz", expect.any(Object));
  });

  it("requests the newest activity page with backward pagination", async () => {
    const pageResponse = { items: [], nextCursor: "older-events", hasMore: true };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(pageResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getEventsPage("job-1", undefined, 10, "backward")).resolves.toEqual(pageResponse);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/events?limit=10&direction=backward", expect.any(Object));
  });

  it("reports an unavailable daemon when the proxy returns an empty error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));

    await expect(listJobs()).rejects.toThrow("Daemon unavailable (HTTP 502)");
  });

  it("reports reconnecting on an EventSource error and live after it reopens", () => {
    const sources: Array<{
      onopen: ((event: Event) => void) | null;
      onerror: ((event: Event) => void) | null;
      close: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }> = [];
    class MockEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      constructor() {
        sources.push(this);
      }
    }
    vi.stubGlobal("EventSource", MockEventSource);
    const connectionChanges = vi.fn();
    const onReconnected = vi.fn();

    const unsubscribe = subscribeToJobs(vi.fn(), connectionChanges, onReconnected);
    const source = sources[0]!;
    source.onopen?.(new Event("open"));
    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open"));

    expect(connectionChanges.mock.calls).toEqual([[true], [false], [true]]);
    expect(onReconnected).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
    expect(connectionChanges).toHaveBeenLastCalledWith(false);
  });
});
