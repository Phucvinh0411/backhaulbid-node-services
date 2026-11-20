import { AuctionRegistrationDocument } from './schemas/auction-registration.schema';

export function toAuctionRegistrationResponse(
  registration: AuctionRegistrationDocument,
  auction: { startTime: Date },
) {
  return {
    id: registration._id,
    auctionId: registration.auctionId,
    carrierId: registration.carrierId,
    vehicleId: registration.vehicleId,
    status: registration.status,
    paymentStatus: registration.paymentStatus,
    depositStatus: registration.depositStatus,
    participationFeeStatus: registration.participationFeeStatus,
    participationFeeAmount: registration.participationFeeAmount.toString(),
    depositAmount: registration.depositAmount?.toString() ?? null,
    depositHoldId: registration.depositHoldId,
    participationFeeTransactionId: registration.participationFeeTransactionId,
    paymentErrorCode: registration.paymentErrorCode,
    startTime: auction.startTime,
    registeredAt: registration.registeredAt ?? registration.createdAt,
    updatedAt: registration.updatedAt,
  };
}

export type AuctionRegistrationResponseDto = ReturnType<
  typeof toAuctionRegistrationResponse
>;
