import { NotificationDocument } from './schemas/notification.schema.js';

export interface NotificationResponseDto {
  id: string;
  userId: string;
  title: string;
  message: string;
  referenceId: string | null;
  type: string;
  isRead: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

type NotificationSource =
  | NotificationDocument
  | {
      _id?: unknown;
      id?: unknown;
      userId?: string;
      title?: string;
      message?: string;
      referenceId?: string | null;
      type?: string;
      isRead?: boolean;
      createdAt?: Date | string | null;
      updatedAt?: Date | string | null;
      toObject?: () => Record<string, unknown>;
    };

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * Maps a persisted Mongoose NotificationDocument to a clean public DTO.
 * Strips internal persistence fields (`_id`, `__v`, `dedupeKey`).
 */
export function toNotificationResponse(
  source: NotificationSource,
): NotificationResponseDto {
  const raw: Record<string, unknown> =
    typeof source?.toObject === 'function'
      ? source.toObject()
      : ((source as Record<string, unknown>) ?? {});

  const idValue = raw._id ?? raw.id ?? '';
  return {
    id: String(idValue),
    userId: String(raw.userId ?? ''),
    title: String(raw.title ?? ''),
    message: String(raw.message ?? ''),
    referenceId:
      raw.referenceId === undefined || raw.referenceId === null
        ? null
        : String(raw.referenceId),
    type: String(raw.type ?? 'NEW_AUCTION'),
    isRead: Boolean(raw.isRead),
    createdAt: toIsoString(raw.createdAt),
    updatedAt: toIsoString(raw.updatedAt),
  };
}

export function toNotificationResponses(
  sources: NotificationSource[] | null | undefined,
): NotificationResponseDto[] {
  if (!Array.isArray(sources)) return [];
  return sources.map((doc) => toNotificationResponse(doc));
}
