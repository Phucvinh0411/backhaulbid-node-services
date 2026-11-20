import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionDocument } from './schemas/auction.schema';

export interface AwardProgressResponseDto {
  currentAttempt: number;
  maximumAttempts: number;
  status: string | null;
  signingDeadlineAt: Date | null;
}

export function toAwardProgressResponse(
  auction: AuctionDocument,
): AwardProgressResponseDto {
  const attempts = auction.awardAttempts ?? [];
  const current = attempts.find((attempt) =>
    [
      'CREATING',
      'CREATION_FAILED',
      'AWAITING_CARRIER_SIGNATURE',
      'AWAITING_SHIPPER_SIGNATURE',
    ].includes(attempt.status),
  );
  return {
    currentAttempt: current?.attemptNumber ?? attempts.length,
    maximumAttempts: 1 + 3,
    status: current?.status ?? auction.awardStatus ?? null,
    signingDeadlineAt: current?.signingDeadlineAt ?? null,
  };
}

/**
 * Maps an Auction Mongo document to its public API DTO.
 * Security invariant: private `valueDocuments`, `valueDocumentKeys`, and their `objectKey` values
 * must NEVER be included here; owners access those only through owner-checked endpoints.
 */
export function toAuctionResponse(
  auction: AuctionDocument,
  now: Date = new Date(),
) {
  const registrationStartTime = auction.registrationStartTime
    ? new Date(auction.registrationStartTime)
    : null;
  const registrationEndTime = new Date(auction.registrationEndTime);

  return {
    id: auction._id,
    shipperId: auction.shipperId,
    title: auction.title,
    goodsType: auction.goodsType,
    weight: auction.weight,
    volume: auction.volume ?? null,
    goodsValue: auction.goodsValue?.toString() ?? null,
    vehicleTypeRequired: auction.vehicleTypeRequired,
    requiredTemp: auction.requiredTemp ?? null,
    vehicleSpecs: auction.vehicleSpecs ?? null,
    requiredVehicleDims: auction.vehicleSpecs
      ? {
          length: auction.vehicleSpecs.length,
          width: auction.vehicleSpecs.width,
          height: auction.vehicleSpecs.height,
        }
      : null,
    origin: auction.origin,
    destination: auction.destination,
    pickupLocation: auction.pickupLocation,
    deliveryLocation: auction.deliveryLocation,
    originLocationName: auction.pickupLocation?.locationName ?? null,
    originAddress: auction.pickupLocation?.address ?? null,
    originProvince: auction.pickupLocation?.province ?? null,
    originContactName: auction.pickupLocation?.contactName ?? null,
    originContactPhone: auction.pickupLocation?.contactPhone ?? null,
    destinationLocationName: auction.deliveryLocation?.locationName ?? null,
    destinationAddress: auction.deliveryLocation?.address ?? null,
    destinationProvince: auction.deliveryLocation?.province ?? null,
    destinationContactName: auction.deliveryLocation?.contactName ?? null,
    destinationContactPhone: auction.deliveryLocation?.contactPhone ?? null,
    earliestPickup: auction.pickupLocation?.earliestTime ?? null,
    latestPickup: auction.pickupLocation?.latestTime ?? null,
    earliestDelivery: auction.deliveryLocation?.earliestTime ?? null,
    latestDelivery: auction.deliveryLocation?.latestTime ?? null,
    auctionType: auction.auctionType,
    requireCarrierCoverage: auction.requireCarrierCoverage === true,
    maxPrice: auction.maxPrice.toString(),
    priceStep: auction.priceStep ? auction.priceStep.toString() : null,
    maxBids: auction.maxBids ?? null,
    images: auction.images,
    notes: auction.notes,
    isDepositRequired: auction.isDepositRequired,
    depositAmount: auction.depositAmount?.toString() ?? null,
    participationFeeTier: auction.participationFeeTier,
    participationFeeAmount: auction.participationFeeAmount.toString(),
    creationFeeTier: auction.creationFeeTier || null,
    creationFeeAmount: auction.creationFeeAmount
      ? auction.creationFeeAmount.toString()
      : null,
    creationFeeStatus: auction.creationFeeStatus ?? null,
    registrationStartTime: auction.registrationStartTime ?? null,
    registrationEndTime: auction.registrationEndTime,
    startTime: auction.startTime,
    endTime: auction.endTime,
    status: auction.status,
    registrationOpen:
      auction.status === AuctionStatus.PENDING &&
      (!registrationStartTime || now >= registrationStartTime) &&
      now < registrationEndTime,
    roomOpen:
      auction.status === AuctionStatus.OPEN &&
      now >= auction.startTime &&
      now < auction.endTime,
    winningBidId: auction.winningBidId ?? null,
    awardStatus: auction.awardStatus ?? null,
    awardTripId: auction.awardTripId ?? null,
    awardError: auction.awardError ?? null,
    awardProgress: toAwardProgressResponse(auction),
    cancellationReason: auction.cancellationReason ?? null,
    fraudFlag: auction.fraudFlag ?? false,
    fraudReason: auction.fraudReason ?? null,
    createdAt: auction.createdAt,
    updatedAt: auction.updatedAt,
  };
}

export type AuctionResponseDto = ReturnType<typeof toAuctionResponse>;

export function toAuctionResponses(
  auctions: AuctionDocument[],
  now: Date = new Date(),
): AuctionResponseDto[] {
  return auctions.map((auction) => toAuctionResponse(auction, now));
}
