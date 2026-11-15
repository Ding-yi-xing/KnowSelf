/**
 * 日志（L3 journal）只读路由（M3/T08 新增）。
 *
 *   GET /journal        → 200 + JournalDateSummary[]（按日期倒序）
 *   GET /journal/:date  → 200 + { date, records: JournalRecordStored[] }（无数据返回空数组，不抛错）
 *
 * 日期格式固定 `YYYY-MM-DD`（领域库 `JournalDateSchema`），非法格式 → 400 `{error}`，
 * 不以空结果冒充「参数错了」。与画像路由一样只依赖**核心层**，不造 503。
 */
import type { ProfileStore } from "@knowself/profile-store";
import type { KnowselfServices } from "../services.js";
import {
  BadRequestError,
  decodePathSegment,
  type DispatchResult,
  type RouteContext,
} from "./http.js";

/** 领域库的日志日期形态：`YYYY-MM-DD`（同时校验字面格式与真实日历日期）。 */
const JOURNAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 取核心层（必有）。
 * @param services 已装配的领域服务
 * @returns profileStore
 * @throws Error 核心层缺失（装配异常 → bridge 转 500）
 */
function requireProfileStore(services: KnowselfServices): ProfileStore {
  const store = services.profileStore;
  if (store === undefined) {
    throw new Error("核心层 profileStore 未装配（assembleServices 第 1 层应保证其必有）");
  }
  return store;
}

/**
 * 校验并解码日志日期路径片段。
 *
 * 除正则外还回算一次 `Date`，挡掉 `2026-02-31` 这类「格式对但日历不存在」的输入
 * （SQLite 对它只会返回空记录，会把「参数错」伪装成「没有数据」）。
 *
 * @param raw 未解码的路径片段
 * @returns 合法的 `YYYY-MM-DD`
 * @throws BadRequestError 非法格式 / 非法日历日期 → 400
 */
function decodeJournalDate(raw: string | undefined): string {
  const date = decodePathSegment(raw, "日志日期");
  const m = JOURNAL_DATE_RE.exec(date);
  if (m === null) {
    throw new BadRequestError(`日志日期格式非法（应为 YYYY-MM-DD）：${date}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const roundTrip =
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day;
  if (!roundTrip) {
    throw new BadRequestError(`日志日期不存在：${date}`);
  }
  return date;
}

/**
 * 处理日志两个只读端点。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 命中的 `{ status, body }`；非日志路径 / 非 GET → `undefined`（交由 404）
 */
export function handleJournalRoute(ctx: RouteContext): DispatchResult | undefined {
  const { path, services, method } = ctx;
  const isGet = method === "GET";

  if (path === "/journal" && isGet) {
    const store = requireProfileStore(services);
    // 领域库 SQL 已是 `ORDER BY date DESC`；这里再显式排一次，把「按日期倒序」
    // 变成路由层可独立验证的契约（字符串比较对 `YYYY-MM-DD` 等价于日期比较）。
    const dates = [...store.journal.listDates()].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
    );
    return { status: 200, body: dates };
  }

  const mDate = /^\/journal\/([^/]+)$/.exec(path);
  if (mDate !== null && isGet) {
    const date = decodeJournalDate(mDate[1]);
    const store = requireProfileStore(services);
    // 领域库 `journal.get(date)` 对无数据日期返回 `{ date, records: [] }`，不抛错。
    return { status: 200, body: store.journal.get(date) };
  }

  return undefined;
}
