const TODAY_PREFIX = "今天 ";
const YESTERDAY_PREFIX = "昨天 ";
const JUST_NOW = "刚刚";
const JUST_CHECKED = "刚刚检查";
const TODAY_PREFIX_EN = "Today ";
const YESTERDAY_PREFIX_EN = "Yesterday ";
const JUST_NOW_EN = "Just now";
const JUST_CHECKED_EN = "Just checked";

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function formatDate(date: Date) {
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseUnixTimestampLabel(value: string) {
  if (!/^\d{10,13}$/.test(value)) {
    return null;
  }

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return null;
  }

  return value.length === 13 ? numericValue : numericValue * 1000;
}

function withTime(baseDate: Date, timeText: string) {
  const [hourText, minuteText] = timeText.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return formatDate(baseDate);
  }

  const nextDate = new Date(baseDate);
  nextDate.setHours(hour, minute, 0, 0);
  return formatDate(nextDate);
}

export function parseSkillTimestamp(value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const unixTimestamp = parseUnixTimestampLabel(trimmedValue);
  if (unixTimestamp !== null) {
    return unixTimestamp;
  }
  if (
    trimmedValue === JUST_NOW
    || trimmedValue === JUST_CHECKED
    || trimmedValue === JUST_NOW_EN
    || trimmedValue === JUST_CHECKED_EN
  ) {
    return Date.now();
  }
  if (trimmedValue.startsWith(TODAY_PREFIX)) {
    return Date.parse(withTime(new Date(), trimmedValue.slice(TODAY_PREFIX.length)));
  }
  if (trimmedValue.startsWith(TODAY_PREFIX_EN)) {
    return Date.parse(withTime(new Date(), trimmedValue.slice(TODAY_PREFIX_EN.length)));
  }
  if (trimmedValue.startsWith(YESTERDAY_PREFIX)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return Date.parse(withTime(yesterday, trimmedValue.slice(YESTERDAY_PREFIX.length)));
  }
  if (trimmedValue.startsWith(YESTERDAY_PREFIX_EN)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return Date.parse(withTime(yesterday, trimmedValue.slice(YESTERDAY_PREFIX_EN.length)));
  }

  const parsedTimestamp = Date.parse(trimmedValue);
  return Number.isNaN(parsedTimestamp) ? Number.NEGATIVE_INFINITY : parsedTimestamp;
}

export function formatSkillUpdatedAt(value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return trimmedValue;
  }
  const unixTimestamp = parseUnixTimestampLabel(trimmedValue);
  if (unixTimestamp !== null) {
    return formatDate(new Date(unixTimestamp));
  }
  if (
    trimmedValue === JUST_NOW
    || trimmedValue === JUST_CHECKED
    || trimmedValue === JUST_NOW_EN
    || trimmedValue === JUST_CHECKED_EN
  ) {
    return formatDate(new Date());
  }
  if (trimmedValue.startsWith(TODAY_PREFIX)) {
    return withTime(new Date(), trimmedValue.slice(TODAY_PREFIX.length));
  }
  if (trimmedValue.startsWith(TODAY_PREFIX_EN)) {
    return withTime(new Date(), trimmedValue.slice(TODAY_PREFIX_EN.length));
  }
  if (trimmedValue.startsWith(YESTERDAY_PREFIX)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return withTime(yesterday, trimmedValue.slice(YESTERDAY_PREFIX.length));
  }
  if (trimmedValue.startsWith(YESTERDAY_PREFIX_EN)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return withTime(yesterday, trimmedValue.slice(YESTERDAY_PREFIX_EN.length));
  }

  return trimmedValue;
}
