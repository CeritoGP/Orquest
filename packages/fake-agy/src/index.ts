import type { JobRecord, JobResult } from "@orquest/contracts";
import type { JobRunner, RunnerEvent } from "@orquest/core";

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Operation aborted", "AbortError"));
    }, { once: true });
  });
}

export class FakeAgyRunner implements JobRunner {
  async execute(job: JobRecord, emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<JobResult> {
    emit({ id: "accepted", kind: "job.message", message: `Worker accepted: ${job.title}` });
    await wait(180, signal);
    emit({ id: "inspect", kind: "job.progress", message: "Inspecting workspace and task constraints", payload: { percent: 25 } });
    await wait(180, signal);
    emit({ id: "read-files", kind: "job.tool", message: "read_files", payload: { tool: "read_files", files: ["README.md", "AGENTS.md"] } });
    await wait(180, signal);
    emit({ id: "handoff", kind: "job.progress", message: "Producing structured handoff", payload: { percent: 75 } });
    await wait(180, signal);

    return {
      summary: `Fake runner completed “${job.title}”. No Antigravity process was started.`,
      tests: [{ command: "fake verification", status: "passed", output: "Fake runner completed successfully." }],
      filesChanged: [],
      risks: ["This is a deterministic local simulation; no Antigravity process was started."],
      conversationId: `fake-${job.id}`,
    };
  }
}