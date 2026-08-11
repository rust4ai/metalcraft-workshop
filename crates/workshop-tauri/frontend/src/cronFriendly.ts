// Friendly ⇄ cron helpers for the schedule editor's "Simple" mode.
//
// The agent's `cron` crate uses a 6-field expression (seconds first):
//   sec min hour day-of-month month day-of-week
// and accepts weekday NAMES (SUN..SAT), which we emit for readability and to
// avoid the 0-vs-1 Sunday ambiguity between cron dialects. Parsing accepts names
// AND numbers (the crate numbers Sun=1..Sat=7; some dialects use 0=Sun), so a
// hand-written or imported cron still round-trips into the Simple view when it
// matches a daily/weekly pattern — otherwise it falls back to "custom" (Advanced).

/** UI day index 0=Sun..6=Sat → label. */
export const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const NAME_TO_IDX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thurs: 4, fri: 5, sat: 6,
}

/** A cron expression that maps onto a Simple pattern, or `custom`. */
export type CronParts =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; days: number[] }
  | { kind: 'custom' }

const isNum = (s: string) => /^\d+$/.test(s)

/** Parse one day-of-week token list (e.g. `MON,WED` or `2,4`) into UI indices
 *  0=Sun..6=Sat, or `null` if it uses ranges/steps/unknown names. */
function parseDows(field: string): number[] | null {
  const out = new Set<number>()
  for (const tok of field.split(',')) {
    const t = tok.trim().toLowerCase()
    if (t in NAME_TO_IDX) {
      out.add(NAME_TO_IDX[t])
    } else if (isNum(t)) {
      const n = Number(t)
      // cron crate: Sun=1..Sat=7; also accept 0=Sun (other dialects). >7 invalid.
      if (n === 0) out.add(0)
      else if (n >= 1 && n <= 7) out.add(n - 1)
      else return null
    } else {
      return null
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** Map a cron string onto a Simple pattern, or `{ kind: 'custom' }`. */
export function parseCron(cron: string): CronParts {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 6) return { kind: 'custom' }
  const [sec, min, hour, dom, mon, dow] = f
  if (sec !== '0' || !isNum(min) || !isNum(hour) || mon !== '*') return { kind: 'custom' }
  const minute = Number(min)
  const h = Number(hour)
  if (minute > 59 || h > 23) return { kind: 'custom' }
  if (dom === '*' && dow === '*') return { kind: 'daily', hour: h, minute }
  if (dom === '*' && dow !== '*') {
    const days = parseDows(dow)
    if (days && days.length) return { kind: 'weekly', hour: h, minute, days }
  }
  return { kind: 'custom' }
}

export function dailyCron(hour: number, minute: number): string {
  return `0 ${minute} ${hour} * * *`
}

export function weeklyCron(hour: number, minute: number, days: number[]): string {
  const d = (days.length ? days : [1]).map((i) => DOW_NAMES[i]).join(',')
  return `0 ${minute} ${hour} * * ${d}`
}

/** A `Date`-free 12-hour clock label, e.g. `9:05 AM`. */
export function clockLabel(hour: number, minute: number): string {
  const ampm = hour < 12 ? 'AM' : 'PM'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${String(minute).padStart(2, '0')} ${ampm}`
}

/** `HH:MM` (24h) for an <input type="time"> value. */
export function toTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Parse an <input type="time"> `HH:MM` value into `[hour, minute]`. */
export function fromTimeInput(v: string): [number, number] {
  const [h, m] = v.split(':').map(Number)
  return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0]
}

/** Human summary of a cron, e.g. `Daily at 9:00 AM` / `Weekly on Tue, Thu at 9:00 AM`. */
export function describeCron(cron: string): string {
  const p = parseCron(cron)
  if (p.kind === 'daily') return `Daily at ${clockLabel(p.hour, p.minute)}`
  if (p.kind === 'weekly') {
    const days = p.days.map((d) => DOW_LABELS[d]).join(', ')
    return `Weekly on ${days} at ${clockLabel(p.hour, p.minute)}`
  }
  return `Custom: ${cron}`
}
