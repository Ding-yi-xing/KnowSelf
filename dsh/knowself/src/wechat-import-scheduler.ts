/**
 * Configured WeChat export-directory scheduler.
 *
 * This stays at the DSH host boundary: cursoring and message de-duplication
 * remain owned by the existing chat-import route and domain packages.
 */
import type { AutomationSchedule, WechatImportConfig } from "@knowself/contracts";
import { importChat } from "./routes/chat-import.js";
import { sanitizeReason, type DispatchResult } from "./routes/http.js";
import type { KnowselfServices } from "./services.js";

export type WechatImportRunState =
  | "disabled"
  | "dry_run"
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped_overlap";

export interface WechatImportStatusEntry {
  id: string;
  source_id: string;
  enabled: boolean;
  state: WechatImportRunState;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: number | null;
  last_error: string | null;
}

export interface WechatImportStatusSnapshot {
  mode: "disabled" | "dry_run" | "active";
  task_id: "ingest";
  entries: WechatImportStatusEntry[];
}

export interface WechatImportScheduler {
  getStatus(): WechatImportStatusSnapshot;
  dispose(): void;
}

interface SchedulerLogger {
  error(message: string, meta?: unknown): void;
}

type IntervalHandle = ReturnType<typeof setInterval>;
type SetIntervalFn = (callback: () => void, ms: number) => IntervalHandle;
type ClearIntervalFn = (handle: IntervalHandle) => void;

export interface WechatImportSchedulerDeps {
  logger: SchedulerLogger;
  importChat?: typeof importChat;
  now?: () => Date;
  setInterval?: SetIntervalFn;
  clearInterval?: ClearIntervalFn;
}

interface EntryRuntime {
  config: WechatImportConfig;
  status: WechatImportStatusEntry;
  running: boolean;
  lastIntervalAt: number | null;
  lastWindowKey: string | null;
}

function toLocalDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toMonthKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function atMinutes(schedule: AutomationSchedule): number {
  const [hour, minute] = schedule.at_hhmm.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function nowMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

function weeklyKey(now: Date): string {
  const sunday = new Date(now);
  sunday.setHours(0, 0, 0, 0);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  return toLocalDateKey(sunday);
}

function previousWindowKey(schedule: AutomationSchedule, now: Date): string {
  const previous = new Date(now);
  previous.setHours(0, 0, 0, 0);
  if (schedule.kind === "daily") previous.setDate(previous.getDate() - 1);
  if (schedule.kind === "weekly") previous.setDate(previous.getDate() - 7);
  if (schedule.kind === "monthly") previous.setMonth(previous.getMonth() - 1);
  return schedule.kind === "monthly" ? toMonthKey(previous) : schedule.kind === "weekly" ? weeklyKey(previous) : toLocalDateKey(previous);
}

function currentWindowKey(schedule: AutomationSchedule, now: Date): string | null {
  if (schedule.kind === "daily") return toLocalDateKey(now);
  if (schedule.kind === "weekly") return weeklyKey(now);
  if (schedule.kind === "monthly") return toMonthKey(now);
  return null;
}

/** True once the current schedule period has passed its configured run point. */
function windowHasPassed(schedule: AutomationSchedule, now: Date): boolean {
  const minutes = nowMinutes(now);
  if (schedule.kind === "daily") return minutes >= atMinutes(schedule);
  if (schedule.kind === "weekly") {
    return now.getDay() > schedule.weekday ||
      (now.getDay() === schedule.weekday && minutes >= atMinutes(schedule));
  }
  if (schedule.kind === "monthly") {
    return now.getDate() > schedule.day_of_month ||
      (now.getDate() === schedule.day_of_month && minutes >= atMinutes(schedule));
  }
  return false;
}

function isDue(schedule: AutomationSchedule, runtime: EntryRuntime, now: Date): boolean {
  if (schedule.kind === "interval") {
    return runtime.lastIntervalAt === null || now.getTime() - runtime.lastIntervalAt >= schedule.interval_ms;
  }

  const windowKey = currentWindowKey(schedule, now);
  if (windowKey === null || runtime.lastWindowKey === windowKey) return false;
  if (schedule.kind === "daily") return nowMinutes(now) >= atMinutes(schedule);
  if (schedule.kind === "weekly") {
    return now.getDay() === schedule.weekday && nowMinutes(now) >= atMinutes(schedule);
  }
  return now.getDate() === schedule.day_of_month && nowMinutes(now) >= atMinutes(schedule);
}

function markScheduleAttempt(schedule: AutomationSchedule, runtime: EntryRuntime, now: Date): void {
  if (schedule.kind === "interval") {
    runtime.lastIntervalAt = now.getTime();
    return;
  }
  runtime.lastWindowKey = currentWindowKey(schedule, now);
}

function establishBaseline(schedule: AutomationSchedule, runtime: EntryRuntime, now: Date): void {
  if (schedule.kind === "interval") {
    runtime.lastIntervalAt = now.getTime();
    return;
  }
  runtime.lastWindowKey = windowHasPassed(schedule, now)
    ? currentWindowKey(schedule, now)
    : previousWindowKey(schedule, now);
}

function initialMode(services: KnowselfServices): {
  mode: WechatImportStatusSnapshot["mode"];
  task: NonNullable<KnowselfServices["settings"]["automation"]>["tasks"][number] | undefined;
} {
  const automation = services.settings.automation;
  const task = automation?.tasks.find((candidate) => candidate.task_id === "ingest");
  if (automation?.enabled !== true || task?.enabled !== true) return { mode: "disabled", task };
  if (automation.dry_run || task.dry_run) return { mode: "dry_run", task };
  return { mode: "active", task };
}

function errorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeReason(raw, "微信导入失败").slice(0, 512);
}

/**
 * Starts the safe, per-directory scheduler. A stable source id is mandatory so
 * repeated runs reuse the existing ingestion cursor instead of creating sources.
 */
export function startWechatImportScheduler(
  services: KnowselfServices,
  deps: WechatImportSchedulerDeps,
): WechatImportScheduler {
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer = deps.clearInterval ?? ((handle) => clearInterval(handle));
  const importer = deps.importChat ?? importChat;
  const { mode, task } = initialMode(services);
  const configs = services.settings.automation?.wechat_imports ?? [];
  const entries = configs.map((config): EntryRuntime => ({
    config,
    status: {
      id: config.id,
      source_id: config.source_id,
      enabled: config.enabled,
      state: config.enabled ? (mode === "active" ? "idle" : mode) : "disabled",
      last_started_at: null,
      last_finished_at: null,
      last_status: null,
      last_error: null,
    },
    running: false,
    lastIntervalAt: null,
    lastWindowKey: null,
  }));

  const runEntry = async (entry: EntryRuntime): Promise<void> => {
    if (entry.running) {
      entry.status.state = "skipped_overlap";
      return;
    }
    entry.running = true;
    entry.status.state = "running";
    entry.status.last_started_at = now().toISOString();
    entry.status.last_error = null;
    try {
      const result: DispatchResult = await importer(services, {
        source_path: entry.config.source_path,
        source_id: entry.config.source_id,
        platform: "wechat",
        reader: entry.config.reader,
        ...(entry.config.only ? { only: entry.config.only } : {}),
      });
      entry.status.last_status = result.status;
      entry.status.last_finished_at = now().toISOString();
      if (result.status >= 400) {
        entry.status.state = "failed";
        entry.status.last_error = `HTTP ${result.status}`;
        deps.logger.error("WeChat scheduled import failed", {
          entry_id: entry.config.id,
          status: result.status,
        });
      } else {
        entry.status.state = "succeeded";
      }
    } catch (error) {
      entry.status.last_finished_at = now().toISOString();
      entry.status.last_status = null;
      entry.status.state = "failed";
      entry.status.last_error = errorSummary(error);
      deps.logger.error("WeChat scheduled import failed", {
        entry_id: entry.config.id,
        error: entry.status.last_error,
      });
    } finally {
      entry.running = false;
    }
  };

  const runDueEntries = (): void => {
    if (mode !== "active" || task === undefined) return;
    const current = now();
    for (const entry of entries) {
      if (!entry.config.enabled || !isDue(task.schedule, entry, current)) continue;
      markScheduleAttempt(task.schedule, entry, current);
      void runEntry(entry);
    }
  };

  let timer: IntervalHandle | null = null;
  if (mode === "active" && task !== undefined) {
    const startedAt = now();
    for (const entry of entries) {
      if (!entry.config.enabled) continue;
      establishBaseline(task.schedule, entry, startedAt);
      if (task.catch_up) void runEntry(entry);
    }
    timer = setTimer(runDueEntries, services.settings.automation!.tick_ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    getStatus: (): WechatImportStatusSnapshot => ({
      mode,
      task_id: "ingest",
      entries: entries.map(({ status }) => ({ ...status })),
    }),
    dispose: () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
