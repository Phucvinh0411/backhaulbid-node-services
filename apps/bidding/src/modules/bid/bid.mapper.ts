import { BidDocument } from './schemas/bid.schema';

export interface BidResponseDto {
  id: string;
  auctionId: string;
  carrierId: string;
  bidAmount: string;
  bidTime: Date;
  idempotencyKey: string | null;
}

export function toBidResponse(bid: BidDocument): BidResponseDto {
  return {
    id: bid._id,
    auctionId: bid.auctionId,
    carrierId: bid.carrierId,
    bidAmount: bid.bidAmount.toString(),
    bidTime: bid.bidTime,
    idempotencyKey: bid.idempotencyKey ?? null,
  };
}

export function toBidResponses(bids: BidDocument[]): BidResponseDto[] {
  return bids.map(toBidResponse);
}
