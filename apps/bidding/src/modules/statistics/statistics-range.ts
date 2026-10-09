import { BadRequestException } from '@nestjs/common';

export type StatisticsBucket = 'DAY' | 'WEEK' | 'MONTH';
export type StatisticsRange = { dateFrom: Date; dateTo: Date; bucket: StatisticsBucket };

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

function vietnamDate(value: Date): Date {
  return new Date(value.getTime() + VIETNAM_OFFSET_MS);
}

function vietnamMidnight(localDate: Date): Date {
  return new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()) - VIETNAM_OFFSET_MS);
}

function shiftVietnamDays(value: Date, days: number): Date {
  const localDate = vietnamDate(value);
  localDate.setUTCDate(localDate.getUTCDate() + days);
  return vietnamMidnight(localDate);
}

function shiftVietnamMonths(value: Date, months: number): Date {
  const localDate = vietnamDate(value);
  const target = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(localDate.getUTCDate(), lastDay));
  return vietnamMidnight(target);
}

export function parseStatisticsRange(
  query: { dateFrom?: string; dateTo?: string; bucket?: string },
  now = new Date(),
): StatisticsRange {
  const localNow = vietnamDate(now);
  const defaultEnd = vietnamMidnight(new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + 1)));
  const dateTo = query.dateTo ? new Date(query.dateTo) : defaultEnd;
  const dateFrom = query.dateFrom ? new Date(query.dateFrom) : shiftVietnamDays(dateTo, -30);
  if (!Number.isFinite(dateFrom.getTime()) || !Number.isFinite(dateTo.getTime()) || dateFrom >= dateTo) {
    throw new BadRequestException('dateFrom and dateTo must form a valid increasing range');
  }
  if (dateTo > shiftVietnamMonths(dateFrom, 24)) throw new BadRequestException('Statistics range cannot exceed 24 months');
  const bucket = (query.bucket || 'DAY').toUpperCase();
  if (!['DAY', 'WEEK', 'MONTH'].includes(bucket)) {
    throw new BadRequestException('bucket must be DAY, WEEK, or MONTH');
  }
  return { dateFrom, dateTo, bucket: bucket as StatisticsBucket };
}

export function statisticsBucketStarts(range: StatisticsRange): Date[] {
  let current = vietnamMidnight(vietnamDate(range.dateFrom));
  if (range.bucket === 'WEEK') {
    const localStart = vietnamDate(current);
    current = shiftVietnamDays(current, -((localStart.getUTCDay() + 6) % 7));
  }
  if (range.bucket === 'MONTH') {
    const localStart = vietnamDate(current);
    localStart.setUTCDate(1);
    current = vietnamMidnight(localStart);
  }
  const starts: Date[] = [];
  while (current < range.dateTo) {
    starts.push(new Date(current));
    if (range.bucket === 'DAY') current = shiftVietnamDays(current, 1);
    else if (range.bucket === 'WEEK') current = shiftVietnamDays(current, 7);
    else current = shiftVietnamMonths(current, 1);
  }
  return starts;
}

export function bucketDateKey(value: Date | string): string {
  const localDate = vietnamDate(new Date(value));
  return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`;
}
