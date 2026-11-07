/**
 * 时间解析（descriptor 驱动，纯函数）：格式串 → 正则 → 墙钟 → epoch 毫秒。
 * 为什么单独成文件：`normalize.ts` 受「单文件 ≤200 行」约束，按职责拆出。
 * 实测前提：txt 时间戳是**分钟精度墙钟**（无秒、非 epoch），换算只依赖固定 UTC 偏移。
 */
const TOKEN_PATTERN: Record<string, string> = {
  YYYY: "(\\d{4})",
  MM: "(\\d{2})",
  DD: "(\\d{2})",
  HH: "(\\d{2})",
  mm: "(\\d{2})",
  ss: "(\\d{2})",
};
const TOKEN_RE = /YYYY|MM|DD|HH|mm|ss/g;

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface TimestampPattern {
  readonly regex: RegExp;
  readonly fields: readonly string[];
}

/** 把 `YYYY-MM-DD HH:mm` 这类格式串编译成正则 + 字段顺序（格式是数据，不是代码）。 */
export function timestampPattern(format: string): TimestampPattern {
  const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(TOKEN_RE, (token) => TOKEN_PATTERN[token] ?? token);
  return { regex: new RegExp(`^${source}$`), fields: format.match(TOKEN_RE) ?? [] };
}

export function toWallClock(match: RegExpExecArray, fields: readonly string[]): WallClock {
  const clock: WallClock = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  fields.forEach((field, index) => {
    const value = Number(match[index + 1] ?? "0");
    if (field === "YYYY") clock.year = value;
    else if (field === "MM") clock.month = value;
    else if (field === "DD") clock.day = value;
    else if (field === "HH") clock.hour = value;
    else if (field === "mm") clock.minute = value;
    else clock.second = value;
  });
  return clock;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function toMsgDate(clock: WallClock): string {
  return `${pad(clock.year, 4)}-${pad(clock.month, 2)}-${pad(clock.day, 2)}`;
}

/** 墙钟 + 固定偏移 → epoch 毫秒（Asia/Shanghai 无夏令时，故无需 tz 库）。 */
export function toEpochMs(clock: WallClock, offsetMinutes: number): number {
  return (
    Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) -
    offsetMinutes * 60_000
  );
}

export interface TimestampSpec {
  readonly long: TimestampPattern;
  readonly short: TimestampPattern;
  readonly offsetMinutes: number;
}

/**
 * 解析消息头里的时间串：先试 `long`（带日期），再试 `short`（当日时间，需 `fallbackDate`）。
 * 两者都不命中 → `null`（调用方记 `TIMESTAMP_UNKNOWN`，**不猜**时间）。
 */
export function resolveTimestamp(
  token: string,
  fallbackDate: string | null,
  spec: TimestampSpec,
): { ts_ms: number; msg_date: string } | null {
  const long = spec.long.regex.exec(token);
  if (long !== null) {
    const clock = toWallClock(long, spec.long.fields);
    return { ts_ms: toEpochMs(clock, spec.offsetMinutes), msg_date: toMsgDate(clock) };
  }
  const short = spec.short.regex.exec(token);
  if (short === null || fallbackDate === null) return null;
  const [year, month, day] = fallbackDate.split("-").map(Number);
  const dated = {
    ...toWallClock(short, spec.short.fields),
    year: year ?? 1970,
    month: month ?? 1,
    day: day ?? 1,
  };
  return { ts_ms: toEpochMs(dated, spec.offsetMinutes), msg_date: fallbackDate };
}
