export interface CurrentLocalTime {
  readonly timestamp: string;
  readonly timeZone: string;
}

export function readCurrentLocalTime(now: Date = new Date()): CurrentLocalTime {
  return {
    timestamp: formatLocalIsoTimestamp(now),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function formatLocalIsoTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainderMinutes = absoluteOffset % 60;

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `.${pad(date.getMilliseconds(), 3)}`,
    `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`,
  ].join("");
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}
