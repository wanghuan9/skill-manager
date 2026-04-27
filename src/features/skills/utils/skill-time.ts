const TODAY_PREFIX = "今天 ";
const YESTERDAY_PREFIX = "昨天 ";
const JUST_NOW = "刚刚";
const JUST_CHECKED = "刚刚检查";

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function formatDate(date: Date) {
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

export function formatSkillUpdatedAt(value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return trimmedValue;
  }
  if (trimmedValue === JUST_NOW || trimmedValue === JUST_CHECKED) {
    return formatDate(new Date());
  }
  if (trimmedValue.startsWith(TODAY_PREFIX)) {
    return withTime(new Date(), trimmedValue.slice(TODAY_PREFIX.length));
  }
  if (trimmedValue.startsWith(YESTERDAY_PREFIX)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return withTime(yesterday, trimmedValue.slice(YESTERDAY_PREFIX.length));
  }

  return trimmedValue;
}
