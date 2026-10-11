import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Largest value document media-service will hand back; the same cap the upload policy enforces. */
export const VALUE_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
const UNAVAILABLE_MESSAGE = 'Chưa tải được tệp chứng từ. Vui lòng thử lại sau.';

export interface PrivateFile {
  bytes: Buffer;
  contentType: string;
}

/**
 * Reads one private object from media-service through its token-protected internal route. The caller must already
 * have checked that the requester owns the auction. Any failure to get a complete file is an error, never a partial
 * or empty file.
 */
@Injectable()
export class MediaFileClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(config: ConfigService) {
    this.baseUrl = (
      config.get<string>('MEDIA_SERVICE_URL') || 'http://media-service:8080'
    ).replace(/\/+$/, '');
    this.internalToken = config.get<string>('INTERNAL_SERVICE_TOKEN') ?? '';
  }

  async fetchPrivateFile(objectKey: string): Promise<PrivateFile> {
    if (!this.internalToken) {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/internal/media/objects?key=${encodeURIComponent(objectKey)}`,
        {
          headers: { 'x-internal-token': this.internalToken },
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    if (response.status === 404) {
      throw new NotFoundException('Không tìm thấy tệp chứng từ');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    const declaredLength = Number(
      response.headers.get('content-length') ?? '0',
    );
    if (declaredLength > VALUE_DOCUMENT_MAX_BYTES) {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > VALUE_DOCUMENT_MAX_BYTES) {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    return {
      bytes,
      contentType:
        response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
