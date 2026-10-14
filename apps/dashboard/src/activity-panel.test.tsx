import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent } from "@orquest/contracts";
import { ActivityPanel } from "./activity-panel.js";
import { getEventsPage } from "./api.js";

vi.mock("./api.js", () => ({ getEventsPage: vi.fn() }));

const getEventsPageMock = vi.mocked(getEventsPage);

function event(jobId: string, sequence: number): JobEvent {
  return {
    id: `event-${jobId}-${sequence}`,
    jobId,
    sequence,
    timestamp: "2026-10-06T14:00:00.000Z",
    kind: "job.progress",
    source: "daemon",
    message: `${jobId} event ${sequence}`,
    payload: {},
    deduplicationKey: null,
  };
}

function events(jobId: string, from: number, to: number): JobEvent[] {
  return Array.from({ length: to - from + 1 }, (_, index) => event(jobId, from + index));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityPanel", () => {
  it("does not republish unchanged events when the parent callback identity changes", async () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    getEventsPageMock.mockResolvedValue({ items: [event("job-a", 1)], nextCursor: null, hasMore: false });

    const { rerender } = render(<ActivityPanel jobId="job-a" onEventsChanged={firstCallback} />);
    await waitFor(() => expect(firstCallback).toHaveBeenLastCalledWith([event("job-a", 1)]));

    rerender(<ActivityPanel jobId="job-a" onEventsChanged={secondCallback} />);
    expect(screen.getByText("job-a event 1")).toBeTruthy();
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it("invalidates an older-page request when the selected job changes", async () => {
    const oldJobPage = deferred<{ items: JobEvent[]; nextCursor: string | null; hasMore: boolean }>();
    getEventsPageMock
      .mockResolvedValueOnce({ items: [event("job-a", 2)], nextCursor: "before-a", hasMore: true })
      .mockImplementationOnce(() => oldJobPage.promise)
      .mockResolvedValueOnce({ items: [event("job-b", 2)], nextCursor: "before-b", hasMore: true })
      .mockResolvedValueOnce({ items: [event("job-b", 1)], nextCursor: null, hasMore: false });

    const { rerender } = render(<ActivityPanel jobId="job-a" />);
    const loadMore = await screen.findByRole("button", { name: "↑ Mostrar eventos anteriores" });
    fireEvent.click(loadMore);
    await waitFor(() => expect(getEventsPageMock).toHaveBeenCalledTimes(2));

    rerender(<ActivityPanel jobId="job-b" />);
    await screen.findByText("job-b event 2");
    expect(getEventsPageMock.mock.calls).toEqual([
      ["job-a", undefined, 10, "backward"],
      ["job-a", "before-a", 10, "backward"],
      ["job-b", undefined, 10, "backward"],
    ]);
    oldJobPage.resolve({ items: [event("job-a", 1)], nextCursor: null, hasMore: false });

    const loadMoreForB = await screen.findByRole("button", { name: "↑ Mostrar eventos anteriores" });
    fireEvent.click(loadMoreForB);
    await waitFor(() => expect(getEventsPageMock).toHaveBeenCalledTimes(4));
    expect(screen.queryByText("job-a event 1")).toBeNull();
  });

  it("does not duplicate the initial page after a reconnect reload", async () => {
    getEventsPageMock.mockResolvedValue({
      items: [event("job-a", 1)],
      nextCursor: "before-1",
      hasMore: true,
    });

    render(<ActivityPanel jobId="job-a" reloadKey={1} />);

    await screen.findByText("job-a event 1");
    expect(getEventsPageMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" })).toBeTruthy();
  });

  it("fills the reconnect gap and keeps the older-history cursor", async () => {
    getEventsPageMock
      .mockResolvedValueOnce({ items: events("job-a", 91, 100), nextCursor: "90", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 116, 125), nextCursor: "115", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 106, 115), nextCursor: "105", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 96, 105), nextCursor: "95", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 81, 90), nextCursor: "80", hasMore: true });

    const { rerender } = render(<ActivityPanel jobId="job-a" reloadKey={0} />);
    await screen.findByText("job-a event 100");

    rerender(<ActivityPanel jobId="job-a" reloadKey={1} />);
    await screen.findByText("job-a event 125");

    expect(getEventsPageMock.mock.calls).toEqual([
      ["job-a", undefined, 10, "backward"],
      ["job-a", undefined, 10, "backward"],
      ["job-a", "115", 10, "backward"],
      ["job-a", "105", 10, "backward"],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 106");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 101");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 91");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 81");
    expect(getEventsPageMock.mock.calls[4]).toEqual(["job-a", "90", 10, "backward"]);
  });

  it("replaces an invalidated initial load when the stream reconnects", async () => {
    const firstPage = deferred<{ items: JobEvent[]; nextCursor: string | null; hasMore: boolean }>();
    getEventsPageMock
      .mockImplementationOnce(() => firstPage.promise)
      .mockResolvedValueOnce({ items: events("job-a", 91, 100), nextCursor: "90", hasMore: true });

    const { rerender } = render(<ActivityPanel jobId="job-a" reloadKey={0} />);
    await waitFor(() => expect(getEventsPageMock).toHaveBeenCalledTimes(1));
    rerender(<ActivityPanel jobId="job-a" reloadKey={1} />);

    await screen.findByText("job-a event 100");
    expect(screen.queryByText("Cargando actividad…")).toBeNull();
    firstPage.resolve({ items: events("job-a", 81, 90), nextCursor: "80", hasMore: true });
  });

  it("does not let a live event hide a reconnect gap", async () => {
    getEventsPageMock
      .mockResolvedValueOnce({ items: events("job-a", 91, 100), nextCursor: "90", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 116, 125), nextCursor: "115", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 106, 115), nextCursor: "105", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 96, 105), nextCursor: "95", hasMore: true });

    const { rerender } = render(<ActivityPanel jobId="job-a" reloadKey={0} />);
    await screen.findByText("job-a event 100");
    rerender(<ActivityPanel jobId="job-a" reloadKey={0} liveEvents={[event("job-a", 125)]} />);
    await screen.findByText("job-a event 125");
    rerender(<ActivityPanel jobId="job-a" reloadKey={1} liveEvents={[event("job-a", 125)]} />);

    await waitFor(() => expect(getEventsPageMock).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 106");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    expect(screen.getByText("job-a event 101")).toBeTruthy();
  });

  it("renders only one page when the live timeline has 250 events", async () => {
    getEventsPageMock.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    render(<ActivityPanel jobId="job-a" liveEvents={events("job-a", 1, 250)} />);

    await screen.findByText("job-a event 250");
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByText("job-a event 240")).toBeNull();
  });

  it("keeps the historical page anchored when newer live events arrive", async () => {
    getEventsPageMock
      .mockResolvedValueOnce({ items: events("job-a", 11, 20), nextCursor: "10", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 1, 10), nextCursor: null, hasMore: false });

    const { rerender } = render(<ActivityPanel jobId="job-a" />);
    await screen.findByText("job-a event 20");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 1");

    rerender(<ActivityPanel jobId="job-a" liveEvents={events("job-a", 21, 30)} />);

    expect(screen.getByText("job-a event 1")).toBeTruthy();
    expect(screen.queryByText("job-a event 11")).toBeNull();
  });

  it("anchors the current page while an older-page request is still pending", async () => {
    const olderPage = deferred<{ items: JobEvent[]; nextCursor: string | null; hasMore: boolean }>();
    getEventsPageMock
      .mockResolvedValueOnce({ items: events("job-a", 11, 20), nextCursor: "10", hasMore: true })
      .mockImplementationOnce(() => olderPage.promise);

    const { rerender } = render(<ActivityPanel jobId="job-a" />);
    await screen.findByText("job-a event 20");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await waitFor(() => expect(getEventsPageMock).toHaveBeenCalledTimes(2));

    rerender(<ActivityPanel jobId="job-a" liveEvents={events("job-a", 21, 30)} />);
    expect(screen.getByText("job-a event 11")).toBeTruthy();
    expect(screen.queryByText("job-a event 21")).toBeNull();

    olderPage.resolve({ items: events("job-a", 1, 10), nextCursor: null, hasMore: false });
    await screen.findByText("job-a event 1");
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it.each([20, 23])("resumes live following after returning to the last page of %i events", async (lastSequence) => {
    getEventsPageMock
      .mockResolvedValueOnce({ items: events("job-a", 11, 20), nextCursor: "older", hasMore: true })
      .mockResolvedValueOnce({ items: events("job-a", 1, 10), nextCursor: null, hasMore: false });

    const { rerender } = render(<ActivityPanel jobId="job-a" />);
    await screen.findByText("job-a event 20");
    fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    await screen.findByText("job-a event 1");
    if (lastSequence > 20) {
      rerender(<ActivityPanel jobId="job-a" liveEvents={events("job-a", 21, lastSequence)} />);
      expect(screen.getByText("job-a event 1")).toBeTruthy();
    }

    while (screen.queryByRole("button", { name: "↓ Mostrar eventos más recientes" }) !== null) {
      fireEvent.click(screen.getByRole("button", { name: "↓ Mostrar eventos más recientes" }));
    }
    expect(screen.getByText(`job-a event ${lastSequence}`)).toBeTruthy();

    rerender(<ActivityPanel jobId="job-a" liveEvents={[event("job-a", lastSequence + 1)]} />);
    await screen.findByText(`job-a event ${lastSequence + 1}`);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "↓ Mostrar eventos más recientes" })).toBeNull();
  });

  it("navigates every page of a 250-event timeline with ten rendered events", async () => {
    getEventsPageMock.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    render(<ActivityPanel jobId="job-a" liveEvents={events("job-a", 1, 250)} />);
    for (let end = 250; end >= 10; end -= 10) {
      await screen.findByText(`job-a event ${end}`);
      expect(screen.getAllByRole("listitem")).toHaveLength(10);
      if (end > 10) fireEvent.click(screen.getByRole("button", { name: "↑ Mostrar eventos anteriores" }));
    }
    for (let end = 20; end <= 250; end += 10) {
      fireEvent.click(screen.getByRole("button", { name: "↓ Mostrar eventos más recientes" }));
      await screen.findByText(`job-a event ${end}`);
    }
  });
});
