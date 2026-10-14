import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JobEventSchema, type JobRecord } from "@orquest/contracts";
import { blockJob, completeJob, createJob, transitionJob, type JobRunner } from "@orquest/core";
import { OrquestDatabase } from "@orquest/persistence";
import { createDaemonServer } from "../../daemon/src/server.js";

// Standalone D00 fixture: no Antigravity invocation or production runner changes.
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixtureDirectory = join(repositoryRoot, ".orquest");
mkdirSync(fixtureDirectory, { recursive: true });
const stateRoot = process.env.ORQUEST_D00_STATE_ROOT
  ? resolve(process.env.ORQUEST_D00_STATE_ROOT)
  : mkdtempSync(join(fixtureDirectory, "d00-"));
mkdirSync(stateRoot, { recursive: true });
const database = new OrquestDatabase(join(stateRoot, "orquest.db"));
const token = process.env.ORQUEST_D00_TOKEN ?? randomBytes(32).toString("hex");
writeFileSync(join(stateRoot, "daemon.token"), token, { mode: 0o600 });
const baseTime = Date.now() - 360_000;

function seed(title: string, eventCount: number, blocked = false): JobRecord {
  const draft = createJob({
    title,
    task: "D00 deterministic fixture; no files inspected or changed.",
    workspacePath: repositoryRoot,
    profileId: "quick",
    accessMode: "read-only",
  }, new Date(baseTime));
  const running = transitionJob(transitionJob(draft, "QUEUED", new Date(baseTime)), "RUNNING", new Date(baseTime));
  const final = blocked
    ? blockJob(running, "AUTH_REQUIRED", "D00 simulated authentication block", new Date(baseTime + 42_000))
    : completeJob(running, {
      summary: title.includes("historial")
        ? `${"D00 resultado sintético largo. Ningún proveedor de IA fue invocado. Este párrafo permite comprobar el scroll independiente del resultado y del detalle.\n\n".repeat(80)}FIN DEL RESULTADO D00`
        : "D00 seeded fixture; no AI provider was invoked.",
      tests: [],
      filesChanged: [],
      risks: ["Synthetic acceptance data."],
      conversationId: `d00-${draft.id}`,
    }, new Date(baseTime + 60_000));
  const stored = database.saveJob(final);
  for (let index = 1; index <= eventCount; index += 1) {
    const event = JobEventSchema.parse({
      id: randomUUID(),
      jobId: stored.id,
      sequence: index,
      timestamp: new Date(baseTime + index * 100).toISOString(),
      kind: "job.tool",
      source: "runner",
      message: `${title.includes("historial") ? "HIST" : "ALT"}-${String(index).padStart(3, "0")}`,
      payload: { synthetic: true, index },
    });
    database.appendEvent(event);
  }
  return stored;
}

const history = seed("D00 A - historial 250", 250);
const alternate = seed("D00 B - seleccion alternativa", 20);
const blocked = seed("D00 C - bloqueado 42s", 7, true);

const runner: JobRunner = {
  async execute(job, emit, signal) {
    // `D00:quick` supplies a completion notice. `D00:controlled` emits twelve
    // events, pauses for an observable return-to-live window, then completes.
    // `D00:long-live` is an isolated three-minute stream for manual network
    // interruption checks. Every other task remains the original 250-event
    // live fixture.
    const controlled = job.task === "D00:controlled";
    const longLive = job.task === "D00:long-live";
    const count = job.task === "D00:quick" ? 4 : controlled ? 24 : longLive ? 360 : 250;
    const intervalMs = controlled || longLive ? 500 : 100;
    for (let index = 1; index <= count; index += 1) {
      if (controlled && index === 13) await delay(30_000, undefined, { signal });
      await delay(intervalMs, undefined, { signal });
      emit({
        id: `d00-live-${index}`,
        kind: "job.tool",
        message: `LIVE-${String(index).padStart(3, "0")}`,
        payload: { synthetic: true, index },
      });
    }
    return {
      summary: "D00 local fake runner completed; no AI provider was invoked.",
      tests: [],
      filesChanged: [],
      risks: ["Synthetic acceptance data."],
      conversationId: `d00-${job.id}`,
    };
  },
};

const daemon = createDaemonServer({
  host: "127.0.0.1",
  port: 4417,
  stateRoot,
  database,
  runner,
  isRealRunner: false,
  token,
  allowedRoots: [repositoryRoot],
  profilesPath: join(repositoryRoot, "config", "profiles.example.yaml"),
});
daemon.server.once("error", (error: Error) => {
  console.error(`D00 daemon failed: ${error.message}`);
  database.close();
  process.exitCode = 1;
});
await daemon.start();
const manifest = {
  stateRoot,
  workspacePath: repositoryRoot,
  daemonUrl: "http://127.0.0.1:4417",
  dashboardUrl: "http://127.0.0.1:4418",
  historyJobId: history.id,
  alternateJobId: alternate.id,
  blockedJobId: blocked.id,
  historyEventCount: database.getLatestEventSequence(history.id),
};
writeFileSync(join(fixtureDirectory, "d00-latest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
console.log("D00 fixture ready. Keep this terminal open; Ctrl+C stops only this fixture.");

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  daemon.server.closeAllConnections();
  void daemon.stop().then(() => {
    console.log("D00 daemon stopped. Fixture data retained.");
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
