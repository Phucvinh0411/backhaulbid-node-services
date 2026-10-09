import { BadRequestException } from '@nestjs/common';

/**
 * Shipper's optional proof of the goods' declared value (invoice, receipt, contract). The files live in the private
 * media folder and are stored here only as object keys. Nothing in this service sends them to a provider, and no
 * response returns them: reading them back is a separate, owner-checked path.
 */
export const VALUE_DOCUMENT_FOLDER = 'goods-value-docs';
export const MAX_VALUE_DOCUMENTS = 5;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE = `${VALUE_DOCUMENT_FOLDER}/${UUID}\\.(pdf|png|jpe?g|webp|gif)`;
const DOCUMENT_KEY = new RegExp(`^(${FILE})$`, 'i');
const DOCUMENT_UPLOAD_URL = new RegExp(`^https?://[^\\s]{1,400}/(${FILE})$`, 'i');

/**
 * Turns the client's references into object keys. Accepts a key or an upload URL from the value-document folder and
 * nothing else. Duplicates are dropped, and the order of the first occurrences is kept.
 */
export function normalizeValueDocuments(references: readonly string[] | null | undefined): string[] {
  if (!references || references.length === 0) return [];
  if (references.length > MAX_VALUE_DOCUMENTS) {
    throw new BadRequestException(`Tối đa ${MAX_VALUE_DOCUMENTS} chứng từ giá trị hàng`);
  }
  const keys: string[] = [];
  for (const reference of references) {
    const text = String(reference ?? '').trim();
    const match = DOCUMENT_KEY.exec(text) ?? DOCUMENT_UPLOAD_URL.exec(text);
    if (!match) {
      throw new BadRequestException('Chứng từ giá trị hàng không hợp lệ. Hãy tải lại tệp PDF hoặc ảnh.');
    }
    // Stored keys are lowercase (media-service writes them that way), so the canonical form is lowercase too.
    const key = match[1].toLowerCase();
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}
