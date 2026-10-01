export interface MilestoneReachedEvent {
  milestoneId: string;
  tripId: string;
  milestoneName: string;
  actualLat: number;
  actualLng: number;
  reachedAt: string;
  shipperId: string; // UUID Chủ hàng
  carrierId: string; // UUID Chủ xe
}
