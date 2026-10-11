import { BadRequestException } from '@nestjs/common';

/**
 * Shipper's proof of the goods' declared value. The files live in the private media folder goods-value-docs; this
 * service keeps only the object key, a document id taken from the file name, the kind and who added it. Nothing here
 * sends a document to a provider, and no response returns a key. Public auction, bid and socket payloads never list
 * these documents at all; only the owner (or an admin) reads them through owner-checked endpoints.
 */
export const VALUE_DOCUMENT_FOLDER = 'goods-value-docs';
export const MAX_VALUE_DOCUMENTS = 5;

export enum ValueDocumentKind {
  INVOICE = 'INVOICE',
  RECEIPT = 'RECEIPT',
  CONTRACT = 'CONTRACT',
  PAYMENT_PROOF = 'PAYMENT_PROOF',
  OTHER = 'OTHER',
  /** Records saved before kinds existed. Never satisfies the value-proof checklist. */
  UNCLASSIFIED = 'UNCLASSIFIED',
}

/** The kinds a shipper can choose. UNCLASSIFIED is only how a legacy record is read. */
export const SELECTABLE_VALUE_DOCUMENT_KINDS: readonly ValueDocumentKind[] = [
  ValueDocumentKind.INVOICE,
  ValueDocumentKind.RECEIPT,
  ValueDocumentKind.CONTRACT,
  ValueDocumentKind.PAYMENT_PROOF,
  ValueDocumentKind.OTHER,
];

/**
 * Kinds that count as proof of the goods' value in the carrier-coverage checklist. Keep this list in step with
 * contract-service's ClaimRequirements.VALUE_PROOF.
 */
export const VALUE_PROOF_KINDS: ReadonlySet<ValueDocumentKind> = new Set([
  ValueDocumentKind.INVOICE,
  ValueDocumentKind.RECEIPT,
  ValueDocumentKind.CONTRACT,
  ValueDocumentKind.PAYMENT_PROOF,
]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXTENSION = '(pdf|png|jpe?g|webp|gif)';
const KEY_PATTERN = new RegExp(
  `^(${VALUE_DOCUMENT_FOLDER}/${UUID}\\.${EXTENSION})$`,
  'i',
);

/** One document as stored on the auction (or read from a legacy auction). `objectKey` is server-side only. */
export interface ValueDocumentRecord {
  documentId: string;
  kind: ValueDocumentKind;
  objectKey: string;
  uploadedBy: string;
  uploadedAt: Date;
}

/** A reference from the request before it is matched with stored metadata. */
export interface ValueDocumentInput {
  objectKey: string;
  kind: ValueDocumentKind;
}

/** Fields of an auction that hold documents. Legacy auctions carry only `valueDocumentKeys`. */
export interface StoredValueDocuments {
  valueDocuments?: ValueDocumentRecord[] | null;
  valueDocumentKeys?: string[] | null;
  shipperId: string;
  createdAt?: Date;
}

export interface ValueDocumentChecklist {
  required: boolean;
  satisfied: boolean;
  missingItems: string[];
}

export interface AwardValueDocumentRef {
  documentId: string;
  kind: ValueDocumentKind;
  objectKey: string;
  uploadedBy: string;
  uploadedAt: string;
}

const INVALID_REFERENCE =
  'Chứng từ giá trị hàng không hợp lệ. Hãy tải lại tệp PDF hoặc ảnh.';

/**
 * Reads the shipper's references. An item is either {key, kind} or a bare key from an older client, which is read as
 * UNCLASSIFIED. A key must sit in goods-value-docs with a UUID file name and a known extension. Storage URLs are refused:
 * the server never accepts a URL as a reference, so the only thing it can ever store or read is a private key.
 * Duplicates and more than MAX_VALUE_DOCUMENTS entries are refused. `undefined` or `null` means no documents.
 */
export function parseValueDocumentInputs(items: unknown): ValueDocumentInput[] {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw new BadRequestException('valueDocuments phải là danh sách chứng từ');
  }
  if (items.length > MAX_VALUE_DOCUMENTS) {
    throw new BadRequestException(
      `Tối đa ${MAX_VALUE_DOCUMENTS} chứng từ giá trị hàng`,
    );
  }
  const inputs: ValueDocumentInput[] = [];
  const seen = new Set<string>();
  for (const item of items as unknown[]) {
    let input: ValueDocumentInput;
    if (typeof item === 'string') {
      input = {
        objectKey: canonicalObjectKey(item),
        kind: ValueDocumentKind.UNCLASSIFIED,
      };
    } else if (
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item)
    ) {
      const record = item as { key?: unknown; kind?: unknown };
      input = {
        objectKey: canonicalObjectKey(record.key),
        kind: selectableKind(record.kind),
      };
    } else {
      throw new BadRequestException(INVALID_REFERENCE);
    }
    if (seen.has(input.objectKey)) {
      throw new BadRequestException(
        'Chứng từ giá trị hàng bị trùng. Mỗi tệp chỉ thêm một lần.',
      );
    }
    seen.add(input.objectKey);
    inputs.push(input);
  }
  return inputs;
}

/**
 * Turns parsed inputs into stored records. A key that already exists keeps its original uploader and time, so
 * changing only a kind or dropping another file does not rewrite who added the rest.
 */
export function recordsFromInputs(
  inputs: readonly ValueDocumentInput[],
  added: { uploadedBy: string; uploadedAt: Date },
  previous: readonly ValueDocumentRecord[] = [],
): ValueDocumentRecord[] {
  const known = new Map(previous.map((record) => [record.objectKey, record]));
  return inputs.map((input) => {
    const before = known.get(input.objectKey);
    return {
      documentId: documentIdOf(input.objectKey),
      kind: input.kind,
      objectKey: input.objectKey,
      uploadedBy: before?.uploadedBy ?? added.uploadedBy,
      uploadedAt: before?.uploadedAt ?? added.uploadedAt,
    };
  });
}

/**
 * The documents an auction holds. Typed records win; an auction saved before typed records reads its bare keys as
 * UNCLASSIFIED, dated at creation. Unreadable legacy keys are skipped rather than failing the read.
 */
export function valueDocumentsOf(
  auction: StoredValueDocuments,
): ValueDocumentRecord[] {
  if (auction.valueDocuments?.length) {
    return auction.valueDocuments.map((record) => ({
      documentId: record.documentId,
      kind: record.kind,
      objectKey: record.objectKey,
      uploadedBy: record.uploadedBy,
      uploadedAt: record.uploadedAt,
    }));
  }
  const addedAt = auction.createdAt ?? new Date(0);
  return (auction.valueDocumentKeys ?? []).flatMap((key) => {
    const objectKey = KEY_PATTERN.test(String(key))
      ? canonicalObjectKey(key)
      : null;
    if (!objectKey) return [];
    return [
      {
        documentId: documentIdOf(objectKey),
        kind: ValueDocumentKind.UNCLASSIFIED,
        objectKey,
        uploadedBy: auction.shipperId,
        uploadedAt: addedAt,
      },
    ];
  });
}

/**
 * The carrier-coverage checklist. It is the platform's own preparation list: a declared value above zero and at least
 * one value-proof document. It says nothing about what an insurer will accept, and it applies only when coverage is
 * required for the auction.
 */
export function valueDocumentChecklist(input: {
  requireCarrierCoverage: boolean;
  goodsValue: string | null | undefined;
  documents: readonly ValueDocumentRecord[];
}): ValueDocumentChecklist {
  if (!input.requireCarrierCoverage) {
    return { required: false, satisfied: true, missingItems: [] };
  }
  const missingItems: string[] = [];
  if (!(Number(input.goodsValue) > 0)) {
    missingItems.push('Giá trị hàng khai báo lớn hơn 0');
  }
  if (
    !input.documents.some((document) => VALUE_PROOF_KINDS.has(document.kind))
  ) {
    missingItems.push(
      'Ít nhất một chứng từ chứng minh giá trị hàng (hóa đơn, biên nhận, hợp đồng hoặc chứng từ thanh toán)',
    );
  }
  return { required: true, satisfied: missingItems.length === 0, missingItems };
}

/** The owner's view of one document: kind, time and a proxy link. The object key never leaves the server. */
export function ownerValueDocumentView(
  record: ValueDocumentRecord,
  auctionId: string,
) {
  return {
    documentId: record.documentId,
    kind: record.kind,
    uploadedAt: record.uploadedAt,
    fileLink: `/api/v1/bidding/auctions/${auctionId}/value-documents/${record.documentId}/file`,
  };
}

/**
 * The declared value and the document references that go to contract-service with each award attempt. Sent with the
 * internal token only; the same snapshot is sent for every attempt of one auction.
 */
export function awardValueSnapshot(
  auction: StoredValueDocuments & {
    goodsValue?: { toString(): string } | null;
  },
): {
  declaredGoodsValue: string | null;
  valueDocuments: AwardValueDocumentRef[];
} {
  return {
    declaredGoodsValue: auction.goodsValue
      ? auction.goodsValue.toString()
      : null,
    valueDocuments: valueDocumentsOf(auction).map((record) => ({
      documentId: record.documentId,
      kind: record.kind,
      objectKey: record.objectKey,
      uploadedBy: record.uploadedBy,
      uploadedAt: record.uploadedAt.toISOString(),
    })),
  };
}

/** The document id is the file's UUID, so it is stable and unique within the folder. */
export function documentIdOf(objectKey: string): string {
  const match = KEY_PATTERN.exec(objectKey);
  if (!match) throw new Error('Not a goods-value-docs object key');
  const key = match[1];
  return key
    .slice(VALUE_DOCUMENT_FOLDER.length + 1, key.lastIndexOf('.'))
    .toLowerCase();
}

function canonicalObjectKey(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const key = KEY_PATTERN.exec(text);
  if (!key) throw new BadRequestException(INVALID_REFERENCE);
  // Stored keys are lowercase, the same form media-service writes.
  return key[1].toLowerCase();
}

function selectableKind(value: unknown): ValueDocumentKind {
  const kind = SELECTABLE_VALUE_DOCUMENT_KINDS.find(
    (candidate) => candidate === value,
  );
  if (!kind) {
    throw new BadRequestException(
      'Chọn loại cho từng chứng từ: hóa đơn, biên nhận, hợp đồng, chứng từ thanh toán hoặc khác',
    );
  }
  return kind;
}
