'use strict';
/**
 * 时间工具：
 *  - 一律以 IANA 时区（如 Asia/Shanghai）解释当地墙钟时间，得到绝对时刻(UTC ISO)存储；
 *  - 同时保留原始表达 raw（如 "农历正月十五（组织方公告原文）"），不做静默改写；
 *  - 支持跨午夜窗口（22:00–次日02:00）与跨年（2026-12-31 23:30 → 2027-01-01 00:30）。
 */

const MS = 60 * 1000;

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) throw new Error(`非法时间表达式: "${s}"（应为 HH:MM）`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`非法时间表达式: "${s}"`);
  return h * 60 + min;
}

function pad(n) { return String(n).padStart(2, '0'); }
function hhmm(mins) { return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`; }

/** 用 Intl 计算某绝对时刻在指定时区的墙钟分量。 */
function localParts(instantMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  // 部分环境午夜 hour 为 24
  if (p.hour === 24) p.hour = 0;
  return p;
}

/** 当地墙钟 -> UTC 毫秒。在 [-14h,+14h) 的时区偏移范围内二分，保证收敛且无过冲。 */
function wallToMs(y, mo, d, h, mi, tz) {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let lo = target - 14 * 3600 * 1000;
  let hi = target + 14 * 3600 * 1000;
  const keyOf = (ms) => {
    const p = localParts(ms, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  for (let i = 0; i < 32; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (keyOf(mid) < target) lo = mid; else hi = mid;
  }
  // 返回满足“在 tz 下墙钟==目标”的时刻（跳变间隙若不存在则取 hi）
  return keyOf(hi) === target ? hi : hi;
}

function localDateToInstant(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const mins = parseHHMM(timeStr);
  return new Date(wallToMs(y, mo, d, Math.floor(mins / 60), mins % 60, tz)).toISOString();
}

function instantToLocal(iso, tz) {
  const p = localParts(new Date(iso).getTime(), tz);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    tz,
    text: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${tz})`,
  };
}

/** 把窗口规格解析为 [openMs, closeMs]；close<=open 视为跨午夜，close 顺延一天。 */
function windowOnDate(dateStr, win, tz = win.tz) {
  const open = parseHHMM(win.open);
  let close = parseHHMM(win.close);
  const overnight = close <= open;
  if (overnight) close += 24 * 60;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const openMs = wallToMs(y, mo, d, Math.floor(open / 60), open % 60, tz);
  return { openMs, closeMs: openMs + (close - open) * MS, overnight };
}

/**
 * 给定抵达时刻，判定节点窗口状态。
 * 返回 {state:'open'|'before_open'|'after_close', openMs, closeMs, overnight}。
 * 跨午夜窗口（19:00–次日02:00）的 closeMs 已在 windowOnDate 中顺延到次日；
 * 凌晨早于 close 的时刻归属“前一晚开窗”的那次窗口。
 */
function resolveWindow(arrivalMs, tz, win) {
  if (!win || !win.open || !win.close) return null; // 无窗口=全天可达（交通换乘点）
  const here = instantToLocal(new Date(arrivalMs).toISOString(), tz);
  const lp = localParts(arrivalMs, tz);
  const minsNow = lp.hour * 60 + lp.minute;
  const openMin = parseHHMM(win.open);
  const closeRaw = parseHHMM(win.close);
  const overnight = closeRaw <= openMin;

  const shiftDate = (dateStr, n) => {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const base = new Date(Date.UTC(y, mo - 1, d));
    base.setUTCDate(base.getUTCDate() + n); // 按当地日历分量加减
    return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
  };

  // 凌晨时刻（早于跨夜窗口的关门点）：先对照“昨晚开窗”的那次区间
  if (overnight && minsNow < closeRaw) {
    const prev = windowOnDate(shiftDate(here.date, -1), win, tz);
    if (arrivalMs >= prev.openMs && arrivalMs <= prev.closeMs) return { state: 'open', ...prev };
    // 上一场已错过（错过的是 prev），下一场是今晚 openMs；两者都返回，调用方各取所需
    const next = windowOnDate(here.date, win, tz);
    return { state: 'after_close', openMs: next.openMs, closeMs: next.closeMs, overnight, missed_close_ms: prev.closeMs };
  }

  const today = windowOnDate(here.date, win, tz);
  if (arrivalMs >= today.openMs && arrivalMs <= today.closeMs) return { state: 'open', ...today };
  if (minsNow < openMin) return { state: 'before_open', ...today };
  // 今日窗口已错过（错过的是 today），下一窗口在明天
  const next = windowOnDate(shiftDate(here.date, 1), win, tz);
  return { state: 'after_close', openMs: next.openMs, closeMs: next.closeMs, overnight, missed_close_ms: today.closeMs };
}

/** 最早可进入时刻：窗口内立即进入；开窗前等待；关窗后进入下一次窗口。是否允许由调用方比较 closeMs。 */
function earliestEntry(arrivalMs, node) {
  const rw = resolveWindow(arrivalMs, node.tz, node.window);
  if (!rw) return { enterMs: arrivalMs, waitMs: 0, window: null };
  if (rw.state === 'open') return { enterMs: arrivalMs, waitMs: 0, window: rw };
  // before_open：等待当天开窗；after_close：进入下一开窗
  return { enterMs: rw.openMs, waitMs: rw.openMs - arrivalMs, window: rw };
}

/** 时长（分钟），允许跨午夜/跨年。 */
function durationMinutes(fromIso, toIso) {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / MS);
}

function addMinutesISO(iso, mins) {
  return new Date(new Date(iso).getTime() + mins * MS).toISOString();
}

/** 检测跨年/跨午夜，用于解释与提示（原始表达不丢）。 */
function spansBoundary(fromIso, toIso, tz) {
  const a = instantToLocal(fromIso, tz);
  const b = instantToLocal(toIso, tz);
  return { overnight: a.date !== b.date && b.time < a.time || (a.date !== b.date), crossYear: a.date.slice(0, 4) !== b.date.slice(0, 4) };
}

module.exports = {
  parseHHMM, hhmm, localParts, wallToMs, localDateToInstant, instantToLocal,
  windowOnDate, resolveWindow, earliestEntry, durationMinutes, addMinutesISO, spansBoundary, MS,
};
