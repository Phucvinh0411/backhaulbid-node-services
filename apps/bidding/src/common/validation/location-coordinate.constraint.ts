import { ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

export interface CoordinateLocation {
  latitude?: number | null;
  longitude?: number | null;
  coordinateSource?: string | null;
  coordinateConfirmedAt?: Date | null;
}

export function hasValidCoordinatePair(location: CoordinateLocation): boolean {
  const { latitude, longitude, coordinateSource, coordinateConfirmedAt } = location;
  if (latitude == null && longitude == null)
    return coordinateSource == null && coordinateConfirmedAt == null;
  return typeof latitude === 'number' && typeof longitude === 'number'
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && (coordinateSource == null || coordinateSource === 'USER_CONFIRMED');
}

@ValidatorConstraint({ name: 'coordinatePair', async: false })
export class LocationCoordinateConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return hasValidCoordinatePair(args.object as CoordinateLocation);
  }
  defaultMessage(): string {
    return 'Coordinates must be a complete valid pair with USER_CONFIRMED source';
  }
}
