export interface TripLocationPointPayload {
  id: string;
  tripId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  source?: string;
  capturedAt?: string;
  recordedAt?: string;
}

export interface TripLocationUpdatedEvent {
  tripId: string;
  shipperId?: string | null;
  carrierId?: string | null;
  status?: string | null;
  point: TripLocationPointPayload;
  heading?: number | null;
  speedKmh?: number | null;
  data?: TripLocationUpdatedEvent;
}

