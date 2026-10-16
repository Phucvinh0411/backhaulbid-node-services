/** Body for fleet-service POST /internal/empty-routes/match, built from a serialized auction. */
export interface EmptyRouteMatchRequest {
  origin: string | null;
  destination: string | null;
  latestPickup: string | Date | null;
  vehicleTypeRequired: string | null;
  weight: number | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropLat: number | null;
  dropLng: number | null;
}

interface MatchLocation {
  latitude?: number | null;
  longitude?: number | null;
  latestTime?: string | Date | null;
  timeWindowEnd?: string | Date | null;
}

interface MatchAuction {
  origin?: string | null;
  destination?: string | null;
  latestPickup?: string | Date | null;
  vehicleTypeRequired?: string | null;
  weight?: number | null;
  pickupLocation?: MatchLocation | null;
  deliveryLocation?: MatchLocation | null;
}

const finite = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
};

/**
 * Fleet filters by pickup radius, drop distance and spare capacity only when the coordinates and weight are sent;
 * without them every unexpired route of the right vehicle type matches any auction in the country.
 */
export function buildEmptyRouteMatchRequest(
  auction: MatchAuction,
): EmptyRouteMatchRequest {
  const pickup = auction.pickupLocation ?? {};
  const delivery = auction.deliveryLocation ?? {};
  return {
    origin: auction.origin ?? null,
    destination: auction.destination ?? null,
    latestPickup:
      auction.latestPickup || pickup.latestTime || pickup.timeWindowEnd || null,
    vehicleTypeRequired: auction.vehicleTypeRequired ?? null,
    weight: finite(auction.weight),
    pickupLat: finite(pickup.latitude),
    pickupLng: finite(pickup.longitude),
    dropLat: finite(delivery.latitude),
    dropLng: finite(delivery.longitude),
  };
}
