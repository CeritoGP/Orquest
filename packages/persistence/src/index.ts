import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  JobEvent,
  JobEventDraft,
  JobListQuery,
  JobRecord,
  PaginatedResult,
  PaginationQuery,
  TaskMessageAttemptDispatch,
  TaskMessage,
  TaskSession,
} from "@orquest/contracts";
import {
  decodeCursor,
  encodeCursor,
  JobEventSchema,
  JobRecordSchema,
  PaginationQuerySchema,
  TaskAttemptCursorSchema,
  TaskMessageAttemptDispatchSchema,
  TaskMessageCursorSchema,
  TaskMessageSchema,
  TaskSessionSchema,
} from "@orquest/contracts";

interface JobRow {
  payload: string;
  task_session_id?: string | null;
  attempt_index?: number | null;
}

interface EventRow {
  payload: string;
}

interface TaskSessionRow {
  id: string;
  root_job_id: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
}

interface ColumnRow {
  name: string;
}

interface JobCursorData {
  u: string;
  id: string;
}

interface EventCursorData {
  s: number;
}

interface LegacyMessageCursorData { t: string; id: string; }

type SqlParam = string | number | bigint | null | Uint8Array;

const TaskSessionCursorSchema = TaskSessionSchema.pick({ id: true, updatedAt: true });

export type TaskMutationOperation = "continue" | "retry" | "queue";

export interface TaskMutationInput {
  taskSessionId: string;
  idempotencyKey: string;
  operation: TaskMutationOperation;
  /** Normalized request input only: never generated IDs or resolved job state. */
  request: unknown;
  job: JobRecord;
  message: TaskMessage;
  event: JobEventDraft;
}

export interface TaskMutationResult {
  job: JobRecord;
  message: TaskMessage;
  event: JobEvent;
  idempotentReplay: boolean;
}

/** Result of a first-attempt write, ready to publish only after its commit. */
export interface InitialTaskWriteResult {
  job: JobRecord;
  message: TaskMessage;
  event: JobEvent;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new Error("Idempotency request must be JSON-compatible");
}

export function createTaskMutationFingerprint(operation: TaskMutationOperation, request: unknown): string {
  return createHash("sha256").update(`${operation}:${canonicalize(request)}`, "utf8").digest("hex");
}

export class OrquestDatabase {
  readonly #database: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.#database = new DatabaseSync(filePath);
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        idempotency_key TEXT,
        parent_job_id TEXT,
        retry_of_job_id TEXT,
        workspace_path TEXT,
        profile_id TEXT,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_by_status_updated_at ON jobs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        deduplication_key TEXT,
        payload TEXT NOT NULL,
        UNIQUE(job_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_by_job_sequence ON events(job_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS job_dependencies (
        job_id TEXT NOT NULL,
        depends_on_job_id TEXT NOT NULL,
        PRIMARY KEY(job_id, depends_on_job_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS dependencies_by_prerequisite ON job_dependencies(depends_on_job_id);
    `);

    this.#database.exec("PRAGMA busy_timeout = 5000;");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.migrateEventsTable();
      this.migrateJobsTable();
      this.migrateDependenciesTable();
      this.migrateTaskSessionsTable();
      this.migrateTaskMessagesTable();
      this.migrateTaskAttemptIndexes();
      this.migrateTaskIdempotencyTable();
      this.migrateTaskMessageDispatchesTable();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      this.#database.close();
      throw error;
    }
  }

  private migrateEventsTable(): void {
    const columns = this.#database.prepare("PRAGMA table_info(events)").all() as unknown as ColumnRow[];
    if (!columns.some((column) => column.name === "deduplication_key")) {
      this.#database.exec("ALTER TABLE events ADD COLUMN deduplication_key TEXT;");
    }
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_by_job_deduplication_key ON events(job_id, deduplication_key) WHERE deduplication_key IS NOT NULL;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
  }

  private migrateJobsTable(): void {
    const columns = this.#database.prepare("PRAGMA table_info(jobs)").all() as unknown as ColumnRow[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("idempotency_key")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;");
    }
    if (!columnNames.has("parent_job_id")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN parent_job_id TEXT;");
    }
    if (!columnNames.has("retry_of_job_id")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN retry_of_job_id TEXT;");
    }
    if (!columnNames.has("workspace_path")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN workspace_path TEXT;");
    }
    if (!columnNames.has("profile_id")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN profile_id TEXT;");
    }
    if (!columnNames.has("task_session_id")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN task_session_id TEXT;");
    }
    if (!columnNames.has("attempt_index")) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN attempt_index INTEGER;");
    }

    this.#database.exec(`
      UPDATE jobs
      SET
        workspace_path = COALESCE(workspace_path, json_extract(payload, '$.workspacePath')),
        profile_id = COALESCE(profile_id, json_extract(payload, '$.profileId')),
        idempotency_key = COALESCE(idempotency_key, json_extract(payload, '$.idempotencyKey')),
        parent_job_id = COALESCE(parent_job_id, json_extract(payload, '$.parentJobId')),
        retry_of_job_id = COALESCE(retry_of_job_id, json_extract(payload, '$.retryOfJobId')),
        task_session_id = COALESCE(task_session_id, json_extract(payload, '$.taskSessionId')),
        attempt_index = COALESCE(attempt_index, json_extract(payload, '$.attemptIndex'), 1)
      WHERE workspace_path IS NULL OR profile_id IS NULL OR task_session_id IS NULL OR attempt_index IS NULL;

      CREATE INDEX IF NOT EXISTS jobs_by_idempotency_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_by_parent_job_id ON jobs(parent_job_id) WHERE parent_job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_by_retry_of_job_id ON jobs(retry_of_job_id) WHERE retry_of_job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_by_workspace_updated ON jobs(workspace_path, updated_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_by_profile_updated ON jobs(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_by_task_session_updated ON jobs(task_session_id, updated_at DESC);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (2), (4);
    `);

    // A pre-session database has no reliable group key. Explicit parent/retry
    // links are enough to recover it; unrelated jobs deliberately stay apart.
    const rows = this.#database.prepare(
      "SELECT id, parent_job_id, retry_of_job_id, task_session_id, workspace_path FROM jobs",
    ).all() as unknown as Array<{
      id: string;
      parent_job_id: string | null;
      retry_of_job_id: string | null;
      task_session_id: string | null;
      workspace_path: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const resolved = new Map<string, string>();
    const resolveSession = (id: string, visiting = new Set<string>()): string => {
      const cached = resolved.get(id);
      if (cached !== undefined) return cached;
      const row = byId.get(id);
      if (row === undefined || visiting.has(id)) return id;
      const known = row.task_session_id;
      if (known !== null && known !== "") {
        resolved.set(id, known);
        return known;
      }
      visiting.add(id);
      const linkedId = row.retry_of_job_id ?? row.parent_job_id;
      const ancestor = linkedId === null ? undefined : byId.get(linkedId);
      const sessionId = ancestor !== undefined && ancestor.workspace_path === row.workspace_path
        ? resolveSession(ancestor.id, visiting)
        : row.id;
      visiting.delete(id);
      resolved.set(id, sessionId);
      return sessionId;
    };
    const updateSession = this.#database.prepare("UPDATE jobs SET task_session_id = ? WHERE id = ?");
    for (const row of rows) updateSession.run(resolveSession(row.id), row.id);
  }

  private migrateDependenciesTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS job_dependencies (
        job_id TEXT NOT NULL,
        depends_on_job_id TEXT NOT NULL,
        PRIMARY KEY(job_id, depends_on_job_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS dependencies_by_prerequisite ON job_dependencies(depends_on_job_id);
      INSERT OR IGNORE INTO job_dependencies(job_id, depends_on_job_id)
      SELECT jobs.id, dependencies.value
      FROM jobs, json_each(jobs.payload, '$.dependsOnJobIds') AS dependencies
      WHERE json_type(jobs.payload, '$.dependsOnJobIds') = 'array';
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
    `);
  }

  private migrateTaskSessionsTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_sessions (
        id TEXT PRIMARY KEY,
        root_job_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS task_sessions_by_workspace_updated ON task_sessions(workspace_path, updated_at DESC);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
    `);
    this.#database.exec(`
      INSERT OR IGNORE INTO task_sessions(id, root_job_id, workspace_path, created_at, updated_at)
      SELECT
        jobs.task_session_id,
        COALESCE(
          (SELECT ancestor.id FROM jobs AS ancestor WHERE ancestor.task_session_id = jobs.task_session_id
            AND ancestor.parent_job_id IS NULL AND ancestor.retry_of_job_id IS NULL
            ORDER BY json_extract(ancestor.payload, '$.createdAt') ASC LIMIT 1),
          jobs.id
        ),
        COALESCE(jobs.workspace_path, ''),
        COALESCE(json_extract(jobs.payload, '$.createdAt'), jobs.updated_at),
        jobs.updated_at
      FROM jobs
      WHERE jobs.task_session_id IS NOT NULL;
    `);
  }

  private migrateTaskMessagesTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        task_session_id TEXT NOT NULL,
        job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS task_messages_by_session_created ON task_messages(task_session_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS task_messages_by_job_created ON task_messages(job_id, created_at ASC) WHERE job_id IS NOT NULL;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (6);
    `);
  }

  private migrateTaskAttemptIndexes(): void {
    // Version 7 also repairs databases opened by the initial P1a release,
    // where all historical attempts (and sibling retries) could share index 1/2.
    const applied = this.#database.prepare("SELECT version FROM schema_migrations WHERE version = 7").get();
    if (applied === undefined) {
      this.#database.exec(`
        WITH numbered AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY task_session_id
            ORDER BY CASE WHEN parent_job_id IS NULL AND retry_of_job_id IS NULL THEN 0 ELSE 1 END,
              json_extract(payload, '$.createdAt'), id
          ) AS attempt
          FROM jobs
          WHERE task_session_id IN (
            SELECT task_session_id FROM jobs GROUP BY task_session_id
            HAVING COUNT(DISTINCT attempt_index) <> COUNT(*) OR MIN(attempt_index) < 1
          )
        )
        UPDATE jobs SET attempt_index = (SELECT attempt FROM numbered WHERE numbered.id = jobs.id)
          WHERE id IN (SELECT id FROM numbered);
        UPDATE jobs SET payload = json_set(payload,
          '$.taskSessionId', task_session_id, '$.attemptIndex', attempt_index);
        INSERT INTO schema_migrations(version) VALUES (7);
      `);
    }
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_by_task_attempt ON jobs(task_session_id, attempt_index);
    `);
  }

  private migrateTaskIdempotencyTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_idempotency (
        task_session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_session_id, idempotency_key)
      ) STRICT;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (8);
    `);
  }

  private migrateTaskMessageDispatchesTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_message_attempt_dispatches (
        id TEXT PRIMARY KEY,
        task_session_id TEXT NOT NULL,
        task_message_id TEXT NOT NULL UNIQUE,
        attempt_job_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS task_message_attempt_dispatches_by_attempt
        ON task_message_attempt_dispatches(attempt_job_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (9);
    `);
  }

  private parseJobRow(row: JobRow): JobRecord {
    const raw: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    if (row.task_session_id !== undefined && row.task_session_id !== null) raw.taskSessionId = row.task_session_id;
    if (row.attempt_index !== undefined && row.attempt_index !== null) raw.attemptIndex = row.attempt_index;
    return JobRecordSchema.parse(raw);
  }

  private normalizeStoredJob(job: JobRecord): JobRecord {
    const parsed = JobRecordSchema.parse(job);
    const existing = this.getJob(parsed.id);
    if (existing !== null) {
      if (parsed.taskSessionId !== null && parsed.taskSessionId !== existing.taskSessionId) {
        throw new Error("Cannot change an existing job's task session");
      }
      if (parsed.workspacePath !== existing.workspacePath) {
        throw new Error("Cannot change an existing job's workspace");
      }
      return { ...parsed, taskSessionId: existing.taskSessionId, attemptIndex: existing.attemptIndex };
    }
    const linkedId = parsed.retryOfJobId ?? parsed.parentJobId;
    const ancestor = linkedId == null ? null : this.getJob(linkedId);
    if (ancestor !== null && ancestor.workspacePath !== parsed.workspacePath) {
      throw new Error("Cannot link attempts across workspaces");
    }
    const taskSessionId = ancestor?.taskSessionId ?? parsed.taskSessionId ?? parsed.id;
    const session = this.#database.prepare("SELECT workspace_path FROM task_sessions WHERE id = ?")
      .get(taskSessionId) as { workspace_path: string } | undefined;
    if (session !== undefined && session.workspace_path !== parsed.workspacePath) {
      throw new Error("Cannot share a task session across workspaces");
    }
    // Called after BEGIN IMMEDIATE: the number is allocated by SQLite, not by
    // a stale parent snapshot or a competing caller. Updating a job keeps it.
    const latest = this.#database.prepare(
      "SELECT COALESCE(MAX(attempt_index), 0) AS last_attempt FROM jobs WHERE task_session_id = ?",
    ).get(taskSessionId) as { last_attempt: number };
    return { ...parsed, taskSessionId, attemptIndex: latest.last_attempt + 1 };
  }

  private saveJobInTransaction(storedJob: JobRecord): void {
    const taskSessionId = storedJob.taskSessionId;
    if (taskSessionId === null) throw new Error("Task session ID is required for persisted jobs");
    const parentJobId = storedJob.parentJobId ?? null;
    const retryOfJobId = storedJob.retryOfJobId ?? null;
    const idempotencyKey = storedJob.idempotencyKey ?? null;
    this.#database
        .prepare(`
          INSERT INTO jobs(id, status, updated_at, idempotency_key, parent_job_id, retry_of_job_id, workspace_path, profile_id, task_session_id, attempt_index, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            idempotency_key = excluded.idempotency_key,
            parent_job_id = excluded.parent_job_id,
            retry_of_job_id = excluded.retry_of_job_id,
            workspace_path = excluded.workspace_path,
            profile_id = excluded.profile_id,
            task_session_id = excluded.task_session_id,
            attempt_index = excluded.attempt_index,
            payload = excluded.payload
        `)
        .run(
          storedJob.id,
          storedJob.status,
          storedJob.updatedAt,
          idempotencyKey,
          parentJobId,
          retryOfJobId,
          storedJob.workspacePath,
          storedJob.profileId,
          taskSessionId,
          storedJob.attemptIndex,
          JSON.stringify(storedJob),
        );

    this.#database.prepare(`
        INSERT INTO task_sessions(id, root_job_id, workspace_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = MAX(task_sessions.updated_at, excluded.updated_at)
      `).run(
        taskSessionId,
        storedJob.id,
        storedJob.workspacePath,
        storedJob.createdAt,
        storedJob.updatedAt,
      );

    this.#database.prepare("DELETE FROM job_dependencies WHERE job_id = ?").run(storedJob.id);
    const insertDependency = this.#database.prepare(
      "INSERT INTO job_dependencies(job_id, depends_on_job_id) VALUES (?, ?)",
    );
    for (const dependencyId of storedJob.dependsOnJobIds) {
      insertDependency.run(storedJob.id, dependencyId);
    }
  }

  saveJob(job: JobRecord): JobRecord {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const storedJob = this.normalizeStoredJob(job);
      this.saveJobInTransaction(storedJob);
      this.#database.exec("COMMIT");
      return storedJob;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      throw error;
    }
  }

  /**
   * Stores a newly-created attempt and its first visible message as one unit.
   * P1b uses this to avoid a continuation with a missing user instruction.
   */
  saveJobWithTaskMessage(job: JobRecord, message: TaskMessage): JobRecord {
    const parsedMessage = TaskMessageSchema.parse(message);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const storedJob = this.normalizeStoredJob(job);
      if (parsedMessage.taskSessionId !== storedJob.taskSessionId) {
        throw new Error("Task message session does not match the stored job");
      }
      if (parsedMessage.jobId !== null && parsedMessage.jobId !== storedJob.id) {
        throw new Error("Task message job does not match the stored job");
      }
      this.saveJobInTransaction(storedJob);
      this.saveTaskMessageInTransaction(parsedMessage);
      this.#database.exec("COMMIT");
      return storedJob;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      throw error;
    }
  }

  /**
   * Stores a new initial attempt, its first message, and its persisted event
   * as one unit. It deliberately retains the optional workspace-scoped legacy
   * idempotency key; task-scoped mutations use saveTaskMutation instead.
   */
  saveInitialJobWithTaskMessageAndEvent(
    job: JobRecord,
    message: TaskMessage,
    event: JobEventDraft,
  ): InitialTaskWriteResult {
    const parsedMessage = TaskMessageSchema.parse(message);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (this.getJob(job.id) !== null) {
        throw new Error("Initial task write requires a new attempt job id");
      }
      const storedJob = this.normalizeStoredJob(job);
      if (parsedMessage.taskSessionId !== storedJob.taskSessionId) {
        throw new Error("Task message session does not match the stored job");
      }
      if (parsedMessage.jobId !== null && parsedMessage.jobId !== storedJob.id) {
        throw new Error("Task message job does not match the stored job");
      }
      if (event.jobId !== storedJob.id) {
        throw new Error("Initial task event must belong to the stored job");
      }
      this.saveJobInTransaction(storedJob);
      this.saveTaskMessageInTransaction(parsedMessage);
      const storedEvent = this.appendEventInTransaction(event);
      if (storedEvent === null) throw new Error("Initial task event must not collide with an existing event");
      this.#database.exec("COMMIT");
      return { job: storedJob, message: parsedMessage, event: storedEvent };
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  getJob(id: string): JobRecord | null {
    const row = this.#database.prepare("SELECT payload, task_session_id, attempt_index FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row === undefined ? null : this.parseJobRow(row);
  }

  findJobByIdempotencyKey(key: string, workspacePath?: string): JobRecord | null {
    if (workspacePath !== undefined) {
      const row = this.#database
        .prepare("SELECT payload, task_session_id, attempt_index FROM jobs WHERE idempotency_key = ? AND workspace_path = ? ORDER BY updated_at DESC LIMIT 1")
        .get(key, workspacePath) as JobRow | undefined;
      return row === undefined ? null : this.parseJobRow(row);
    }
    const row = this.#database
      .prepare("SELECT payload, task_session_id, attempt_index FROM jobs WHERE idempotency_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(key) as JobRow | undefined;
    return row === undefined ? null : this.parseJobRow(row);
  }

  listDependentJobs(dependsOnJobId: string): JobRecord[] {
    const rows = this.#database
      .prepare(`
        SELECT jobs.payload, jobs.task_session_id, jobs.attempt_index
        FROM job_dependencies
        INNER JOIN jobs ON jobs.id = job_dependencies.job_id
        WHERE job_dependencies.depends_on_job_id = ?
        ORDER BY jobs.updated_at ASC
      `)
      .all(dependsOnJobId) as unknown as JobRow[];
    return rows.map((row) => this.parseJobRow(row));
  }
  listJobsByParentId(parentJobId: string): JobRecord[] {
    const rows = this.#database
      .prepare("SELECT payload, task_session_id, attempt_index FROM jobs WHERE parent_job_id = ? ORDER BY updated_at ASC")
      .all(parentJobId) as unknown as JobRow[];
    return rows.map((row) => this.parseJobRow(row));
  }

  listJobsByRetryOfId(retryOfJobId: string): JobRecord[] {
    const rows = this.#database
      .prepare("SELECT payload, task_session_id, attempt_index FROM jobs WHERE retry_of_job_id = ? ORDER BY updated_at ASC")
      .all(retryOfJobId) as unknown as JobRow[];
    return rows.map((row) => this.parseJobRow(row));
  }

  listJobsByTaskSessionId(taskSessionId: string): JobRecord[] {
    const rows = this.#database
      .prepare("SELECT payload, task_session_id, attempt_index FROM jobs WHERE task_session_id = ? ORDER BY updated_at ASC, id ASC")
      .all(taskSessionId) as unknown as JobRow[];
    return rows.map((row) => this.parseJobRow(row));
  }

  getTaskSession(taskSessionId: string): TaskSession | null {
    const row = this.#database.prepare(
      "SELECT id, root_job_id, workspace_path, created_at, updated_at FROM task_sessions WHERE id = ?",
    ).get(taskSessionId) as TaskSessionRow | undefined;
    if (row === undefined) return null;
    return TaskSessionSchema.parse({
      id: row.id,
      rootJobId: row.root_job_id,
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  queryTaskSessions(query?: PaginationQuery): PaginatedResult<TaskSession> {
    const parsed = PaginationQuerySchema.parse(query ?? {});
    if (parsed.direction !== "forward") {
      throw new Error("Task session queries use fixed forward order");
    }
    let cursor: { u: string; id: string } | undefined;
    if (parsed.cursor) {
      const decoded = decodeCursor(parsed.cursor);
      const result = TaskSessionCursorSchema.safeParse({
        id: decoded && typeof decoded === "object" ? decoded.id : undefined,
        updatedAt: decoded && typeof decoded === "object" ? decoded.u : undefined,
      });
      if (!result.success) {
        throw new Error("Invalid cursor: Malformed or unparseable task session cursor");
      }
      cursor = { u: result.data.updatedAt, id: result.data.id };
    }
    const rows = cursor === undefined
      ? this.#database.prepare("SELECT id, root_job_id, workspace_path, created_at, updated_at FROM task_sessions ORDER BY updated_at DESC, id DESC LIMIT ?")
        .all(parsed.limit + 1) as unknown as TaskSessionRow[]
      : this.#database.prepare("SELECT id, root_job_id, workspace_path, created_at, updated_at FROM task_sessions WHERE updated_at < ? OR (updated_at = ? AND id < ?) ORDER BY updated_at DESC, id DESC LIMIT ?")
        .all(cursor.u, cursor.u, cursor.id, parsed.limit + 1) as unknown as TaskSessionRow[];
    const hasMore = rows.length > parsed.limit;
    const selected = hasMore ? rows.slice(0, parsed.limit) : rows;
    const items = selected.map((row) => TaskSessionSchema.parse({
      id: row.id,
      rootJobId: row.root_job_id,
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const boundary = selected[selected.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && boundary !== undefined ? encodeCursor({ u: boundary.updated_at, id: boundary.id }) : null,
    };
  }

  queryTaskAttempts(taskSessionId: string, query?: PaginationQuery): PaginatedResult<JobRecord> {
    const parsed = PaginationQuerySchema.parse(query ?? {});
    let cursor: ReturnType<typeof TaskAttemptCursorSchema.parse> | undefined;
    if (parsed.cursor) {
      const decoded = decodeCursor(parsed.cursor);
      const result = TaskAttemptCursorSchema.safeParse(decoded);
      if (!result.success || result.data.taskSessionId !== taskSessionId || result.data.direction !== parsed.direction) {
        throw new Error("Invalid cursor: Task attempt cursor does not match this query");
      }
      cursor = result.data;
    }
    const descending = parsed.direction === "backward";
    const order = descending ? "DESC" : "ASC";
    const comparison = descending ? "<" : ">";
    const rows = cursor === undefined
      ? this.#database.prepare(`SELECT id, attempt_index, payload, task_session_id FROM jobs WHERE task_session_id = ? ORDER BY attempt_index ${order}, id ${order} LIMIT ?`)
        .all(taskSessionId, parsed.limit + 1) as unknown as Array<JobRow & { id: string; attempt_index: number }>
      : this.#database.prepare(`SELECT id, attempt_index, payload, task_session_id FROM jobs WHERE task_session_id = ? AND (attempt_index ${comparison} ? OR (attempt_index = ? AND id ${comparison} ?)) ORDER BY attempt_index ${order}, id ${order} LIMIT ?`)
        .all(taskSessionId, cursor.attemptIndex, cursor.attemptIndex, cursor.jobId, parsed.limit + 1) as unknown as Array<JobRow & { id: string; attempt_index: number }>;
    const hasMore = rows.length > parsed.limit;
    const selected = hasMore ? rows.slice(0, parsed.limit) : rows;
    const items = selected.map((row) => this.parseJobRow(row))
      .sort((left, right) => left.attemptIndex - right.attemptIndex || left.id.localeCompare(right.id));
    const boundary = parsed.direction === "backward" ? items[0] : items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && boundary !== undefined ? encodeCursor({
        taskSessionId,
        direction: parsed.direction,
        attemptIndex: boundary.attemptIndex,
        jobId: boundary.id,
      }) : null,
    };
  }

  listJobs(filter?: Partial<JobListQuery>): JobRecord[] {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.workspace) {
      conditions.push("workspace_path = ?");
      params.push(filter.workspace);
    }
    if (filter?.profile) {
      conditions.push("profile_id = ?");
      params.push(filter.profile);
    }
    if (filter?.taskSessionId) {
      conditions.push("task_session_id = ?");
      params.push(filter.taskSessionId);
    }
    if (filter?.parentJobId) {
      conditions.push("parent_job_id = ?");
      params.push(filter.parentJobId);
    }
    if (filter?.retryOfJobId) {
      conditions.push("retry_of_job_id = ?");
      params.push(filter.retryOfJobId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT payload, task_session_id, attempt_index FROM jobs ${whereClause} ORDER BY updated_at DESC`;
    const rows = this.#database.prepare(sql).all(...params) as unknown as JobRow[];
    return rows.map((row) => this.parseJobRow(row));
  }

  queryJobs(query: JobListQuery): PaginatedResult<JobRecord> {
    const limit = query.limit ?? 20;
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (query.cursor) {
      const decoded = decodeCursor<JobCursorData>(query.cursor);
      if (decoded && typeof decoded.u === "string" && typeof decoded.id === "string") {
        conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
        params.push(decoded.u, decoded.u, decoded.id);
      } else {
        throw new Error("Invalid cursor: Malformed or unparseable job cursor");
      }
    }

    if (query.status) {
      conditions.push("status = ?");
      params.push(query.status);
    }
    if (query.workspace) {
      conditions.push("workspace_path = ?");
      params.push(query.workspace);
    }
    if (query.profile) {
      conditions.push("profile_id = ?");
      params.push(query.profile);
    }
    if (query.taskSessionId) {
      conditions.push("task_session_id = ?");
      params.push(query.taskSessionId);
    }
    if (query.parentJobId) {
      conditions.push("parent_job_id = ?");
      params.push(query.parentJobId);
    }
    if (query.retryOfJobId) {
      conditions.push("retry_of_job_id = ?");
      params.push(query.retryOfJobId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, updated_at, payload, task_session_id, attempt_index FROM jobs ${whereClause} ORDER BY updated_at DESC, id DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.#database.prepare(sql).all(...params) as unknown as Array<JobRow & { id: string; updated_at: string }>;
    const hasMore = rows.length > limit;
    const selectedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = selectedRows.map((row) => this.parseJobRow(row));

    let nextCursor: string | null = null;
    if (hasMore && selectedRows.length > 0) {
      const lastRow = selectedRows[selectedRows.length - 1];
      if (lastRow !== undefined) {
        nextCursor = encodeCursor({ u: lastRow.updated_at, id: lastRow.id } satisfies JobCursorData);
      }
    }

    return {
      items,
      nextCursor,
      hasMore,
    };
  }

  private saveTaskMessageInTransaction(parsed: TaskMessage): void {
    const session = this.#database.prepare("SELECT id FROM task_sessions WHERE id = ?").get(parsed.taskSessionId);
    if (session === undefined) {
      throw new Error(`Cannot store message for unknown task session: ${parsed.taskSessionId}`);
    }
    if (parsed.jobId !== null) {
      const job = this.getJob(parsed.jobId);
      if (job === null || job.taskSessionId !== parsed.taskSessionId) {
        throw new Error("Task message job does not belong to its task session");
      }
    }
    const row = this.#database.prepare("SELECT payload FROM task_messages WHERE id = ?")
      .get(parsed.id) as { payload: string } | undefined;
    if (row !== undefined) {
      const existing = TaskMessageSchema.parse(JSON.parse(row.payload));
      if (existing.taskSessionId !== parsed.taskSessionId || existing.jobId !== parsed.jobId
        || existing.createdAt !== parsed.createdAt || existing.role !== parsed.role
        || existing.source !== parsed.source
        || canonicalize(existing.recipient) !== canonicalize(parsed.recipient)
        || canonicalize(existing.intent) !== canonicalize(parsed.intent)
        || canonicalize(existing.target) !== canonicalize(parsed.target)
        || canonicalize(existing.providerIdentity) !== canonicalize(parsed.providerIdentity)
        || canonicalize(existing.orchestratorContext) !== canonicalize(parsed.orchestratorContext)) {
        throw new Error("Cannot change an existing task message's identity");
      }
    }
    this.#database.prepare(`
      INSERT INTO task_messages(id, task_session_id, job_id, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `).run(
      parsed.id,
      parsed.taskSessionId,
      parsed.jobId,
      parsed.createdAt,
      parsed.updatedAt,
      JSON.stringify(parsed),
    );
  }

  saveTaskMessage(message: TaskMessage): void {
    const parsed = TaskMessageSchema.parse(message);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.saveTaskMessageInTransaction(parsed);
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      throw error;
    }
  }

  /** Runtime identity enrichment is deliberately separate from generic message
   * updates. It is set-once: a retry may repeat the same identity but cannot
   * replace a provider identity that was already recorded. */
  enrichTaskMessageProviderIdentity(messageId: string, providerIdentity: NonNullable<TaskMessage["providerIdentity"]>, updatedAt: string): TaskMessage {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare("SELECT payload FROM task_messages WHERE id = ?").get(messageId) as { payload: string } | undefined;
      if (row === undefined) throw new Error("Cannot enrich an unknown task message");
      const existing = TaskMessageSchema.parse(JSON.parse(row.payload));
      if (existing.providerIdentity !== undefined && existing.providerIdentity !== null
        && canonicalize(existing.providerIdentity) !== canonicalize(providerIdentity)) {
        throw new Error("Cannot replace an existing task message provider identity");
      }
      const enriched = TaskMessageSchema.parse({ ...existing, providerIdentity, updatedAt });
      this.#database.prepare("UPDATE task_messages SET updated_at = ?, payload = ? WHERE id = ?")
        .run(enriched.updatedAt, JSON.stringify(enriched), enriched.id);
      this.#database.exec("COMMIT");
      return enriched;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  listTaskMessages(taskSessionId: string, query?: PaginationQuery): PaginatedResult<TaskMessage> {
    const limit = query?.limit ?? 20;
    const direction = query?.direction ?? "forward";
    let cursor: LegacyMessageCursorData | undefined;
    if (query?.cursor) {
      const decoded = decodeCursor<LegacyMessageCursorData>(query.cursor);
      if (!decoded || typeof decoded.t !== "string" || typeof decoded.id !== "string") {
        throw new Error("Invalid cursor: Malformed or unparseable task message cursor");
      }
      cursor = decoded;
    }

    const descending = direction === "backward";
    const order = descending ? "DESC" : "ASC";
    const comparison = descending ? "<" : ">";
    const sql = cursor === undefined
      ? `SELECT payload FROM task_messages WHERE task_session_id = ? ORDER BY created_at ${order}, id ${order} LIMIT ?`
      : `SELECT payload FROM task_messages WHERE task_session_id = ? AND (created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?)) ORDER BY created_at ${order}, id ${order} LIMIT ?`;
    const params: SqlParam[] = cursor === undefined
      ? [taskSessionId, limit + 1]
      : [taskSessionId, cursor.t, cursor.t, cursor.id, limit + 1];
    const rows = this.#database.prepare(sql).all(...params) as unknown as Array<{ payload: string }>;
    const hasMore = rows.length > limit;
    const selectedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = selectedRows
      .map((row) => TaskMessageSchema.parse(JSON.parse(row.payload)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const boundary = descending ? items[0] : items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && boundary !== undefined
        ? encodeCursor({ t: boundary.createdAt, id: boundary.id } satisfies LegacyMessageCursorData)
        : null,
      hasMore,
    };
  }

  queryTaskMessages(taskSessionId: string, query?: PaginationQuery): PaginatedResult<TaskMessage> {
    const parsed = PaginationQuerySchema.parse(query ?? {});
    let cursor: ReturnType<typeof TaskMessageCursorSchema.parse> | undefined;
    if (parsed.cursor) {
      const decoded = decodeCursor(parsed.cursor);
      const result = TaskMessageCursorSchema.safeParse(decoded);
      if (!result.success || result.data.taskSessionId !== taskSessionId || result.data.direction !== parsed.direction) {
        throw new Error("Invalid cursor: Task message cursor does not match this query");
      }
      cursor = result.data;
    }
    const descending = parsed.direction === "backward";
    const order = descending ? "DESC" : "ASC";
    const comparison = descending ? "<" : ">";
    const rows = cursor === undefined
      ? this.#database.prepare(`SELECT payload FROM task_messages WHERE task_session_id = ? ORDER BY created_at ${order}, id ${order} LIMIT ?`)
        .all(taskSessionId, parsed.limit + 1) as unknown as Array<{ payload: string }>
      : this.#database.prepare(`SELECT payload FROM task_messages WHERE task_session_id = ? AND (created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?)) ORDER BY created_at ${order}, id ${order} LIMIT ?`)
        .all(taskSessionId, cursor.createdAt, cursor.createdAt, cursor.messageId, parsed.limit + 1) as unknown as Array<{ payload: string }>;
    const hasMore = rows.length > parsed.limit;
    const selected = hasMore ? rows.slice(0, parsed.limit) : rows;
    const items = selected.map((row) => TaskMessageSchema.parse(JSON.parse(row.payload)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const boundary = parsed.direction === "backward" ? items[0] : items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && boundary !== undefined ? encodeCursor({
        taskSessionId,
        direction: parsed.direction,
        createdAt: boundary.createdAt,
        messageId: boundary.id,
      }) : null,
    };
  }

  getTaskMessageAttemptDispatch(taskMessageId: string): TaskMessageAttemptDispatch | null {
    const row = this.#database.prepare(
      "SELECT id, task_session_id, task_message_id, attempt_job_id, created_at FROM task_message_attempt_dispatches WHERE task_message_id = ?",
    ).get(taskMessageId) as {
      id: string;
      task_session_id: string;
      task_message_id: string;
      attempt_job_id: string;
      created_at: string;
    } | undefined;
    if (row === undefined) return null;
    return TaskMessageAttemptDispatchSchema.parse({
      id: row.id,
      taskSessionId: row.task_session_id,
      taskMessageId: row.task_message_id,
      attemptJobId: row.attempt_job_id,
      createdAt: row.created_at,
    });
  }

  saveTaskMessageAttemptDispatch(dispatch: TaskMessageAttemptDispatch): TaskMessageAttemptDispatch {
    const parsed = TaskMessageAttemptDispatchSchema.parse(dispatch);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const messageRow = this.#database.prepare("SELECT payload FROM task_messages WHERE id = ?").get(parsed.taskMessageId) as { payload: string } | undefined;
      if (messageRow === undefined) throw new Error("Cannot dispatch an unknown task message");
      const message = TaskMessageSchema.parse(JSON.parse(messageRow.payload));
      const attempt = this.getJob(parsed.attemptJobId);
      if (message.taskSessionId !== parsed.taskSessionId || attempt === null || attempt.taskSessionId !== parsed.taskSessionId) {
        throw new Error("Task message dispatch does not belong to one task session");
      }
      const existing = this.getTaskMessageAttemptDispatch(parsed.taskMessageId);
      if (existing !== null) {
        if (canonicalize(existing) !== canonicalize(parsed)) {
          throw new Error("Task message already has a different attempt dispatch");
        }
        this.#database.exec("COMMIT");
        return existing;
      }
      this.#database.prepare(`
        INSERT INTO task_message_attempt_dispatches(id, task_session_id, task_message_id, attempt_job_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(parsed.id, parsed.taskSessionId, parsed.taskMessageId, parsed.attemptJobId, parsed.createdAt);
      this.#database.exec("COMMIT");
      return parsed;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  saveTaskMutation(input: TaskMutationInput): TaskMutationResult {
    const taskSessionId = input.taskSessionId;
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length === 0) throw new Error("Task mutation idempotency key is required");
    const fingerprint = createTaskMutationFingerprint(input.operation, input.request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(`
        SELECT operation, request_fingerprint, response_payload FROM task_idempotency
        WHERE task_session_id = ? AND idempotency_key = ?
      `).get(taskSessionId, idempotencyKey) as {
        operation: TaskMutationOperation;
        request_fingerprint: string;
        response_payload: string;
      } | undefined;
      if (existing !== undefined) {
        if (existing.operation !== input.operation || existing.request_fingerprint !== fingerprint) {
          throw new Error("Task idempotency conflict");
        }
        const replay = JSON.parse(existing.response_payload) as Omit<TaskMutationResult, "idempotentReplay">;
        const result: TaskMutationResult = {
          job: JobRecordSchema.parse(replay.job),
          message: TaskMessageSchema.parse(replay.message),
          event: JobEventSchema.parse(replay.event),
          idempotentReplay: true,
        };
        this.#database.exec("COMMIT");
        return result;
      }

      // This is the creation path, distinct from the idempotent replay above.
      // Do not let it reuse saveJob's ordinary update semantics: doing so would
      // overwrite an existing attempt and could clear its legacy idempotency
      // lookup while creating an unrelated message and event.
      if (this.getJob(input.job.id) !== null) {
        throw new Error("Task mutation requires a new attempt job id");
      }

      // Task-scoped replay uses task_idempotency exclusively. Never copy that
      // key into jobs.idempotency_key, whose legacy lookup is workspace-scoped.
      const storedJob = this.normalizeStoredJob({ ...input.job, idempotencyKey: undefined });
      const message = TaskMessageSchema.parse(input.message);
      if (storedJob.taskSessionId !== taskSessionId || message.taskSessionId !== taskSessionId || message.jobId !== storedJob.id) {
        throw new Error("Task mutation job and message must belong to the requested task session");
      }
      if (input.event.jobId !== storedJob.id) {
        throw new Error("Task mutation event must belong to the newly stored attempt");
      }
      this.saveJobInTransaction(storedJob);
      this.saveTaskMessageInTransaction(message);
      const event = this.appendEventInTransaction(input.event);
      if (event === null) throw new Error("Task mutation event must not collide with an existing event");
      const response = { job: storedJob, message, event };
      this.#database.prepare(`
        INSERT INTO task_idempotency(task_session_id, idempotency_key, operation, request_fingerprint, response_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskSessionId, idempotencyKey, input.operation, fingerprint, JSON.stringify(response), storedJob.createdAt);
      this.#database.exec("COMMIT");
      return { ...response, idempotentReplay: false };
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  appendEvent(draft: JobEventDraft): JobEvent | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.appendEventInTransaction(draft);

      this.#database.exec("COMMIT");
      return event;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      throw error;
    }
  }

  private appendEventInTransaction(draft: JobEventDraft): JobEvent | null {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events WHERE job_id = ?")
      .get(draft.jobId) as { next_sequence: number };
    const event = JobEventSchema.parse({ ...draft, sequence: row.next_sequence });
    const result = this.#database
      .prepare(
        "INSERT OR IGNORE INTO events(id, job_id, sequence, timestamp, deduplication_key, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(event.id, event.jobId, event.sequence, event.timestamp, event.deduplicationKey, JSON.stringify(event));
    return result.changes === 1 ? event : null;
  }

  listEvents(jobId: string, afterSequence = 0, limit = 100): JobEvent[] {
    const rows = this.#database
      .prepare("SELECT payload FROM events WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(jobId, afterSequence, limit) as unknown as EventRow[];
    return rows.map((row) => JobEventSchema.parse(JSON.parse(row.payload)));
  }

  listEventsPaginated(jobId: string, query?: PaginationQuery): PaginatedResult<JobEvent> {
    const limit = query?.limit ?? 20;
    const direction = query?.direction ?? "forward";
    let cursorSequence: number | undefined;

    if (query?.cursor) {
      const decoded = decodeCursor<EventCursorData>(query.cursor);
      if (decoded && typeof decoded.s === "number") {
        cursorSequence = decoded.s;
      } else {
        throw new Error("Invalid cursor: Malformed or unparseable event cursor");
      }
    }

    const rows = direction === "backward"
      ? cursorSequence === undefined
        ? this.#database
          .prepare("SELECT payload FROM events WHERE job_id = ? ORDER BY sequence DESC LIMIT ?")
          .all(jobId, limit + 1) as unknown as EventRow[]
        : this.#database
          .prepare("SELECT payload FROM events WHERE job_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?")
          .all(jobId, cursorSequence, limit + 1) as unknown as EventRow[]
      : this.#database
        .prepare("SELECT payload FROM events WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
        .all(jobId, cursorSequence ?? 0, limit + 1) as unknown as EventRow[];

    const hasMore = rows.length > limit;
    const selectedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = selectedRows
      .map((row) => JobEventSchema.parse(JSON.parse(row.payload)))
      .sort((left, right) => left.sequence - right.sequence);

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const boundary = direction === "backward" ? items[0] : items[items.length - 1];
      if (boundary !== undefined) {
        nextCursor = encodeCursor({ s: boundary.sequence } satisfies EventCursorData);
      }
    }

    return {
      items,
      nextCursor,
      hasMore,
    };
  }

  getLatestEventSequence(jobId: string): number {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM events WHERE job_id = ?")
      .get(jobId) as { max_sequence: number } | undefined;
    return row?.max_sequence ?? 0;
  }

  close(): void {
    this.#database.close();
  }
}
