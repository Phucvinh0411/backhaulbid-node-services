import { BadRequestException } from '@nestjs/common';
import { LocationDetailDto } from './dtos/location.dto';
import { hasValidCoordinatePair } from './validation/location-coordinate.constraint';

export function confirmedLocation(location: LocationDetailDto): LocationDetailDto {
  if (!hasValidCoordinatePair(location))
    throw new BadRequestException('Location coordinates require a complete valid pair');
  return {
    ...location,
    latitude: location.latitude ?? undefined,
    longitude: location.longitude ?? undefined,
    coordinateSource: location.latitude == null ? undefined : 'USER_CONFIRMED',
    coordinateConfirmedAt: location.latitude == null ? undefined : new Date(),
  };
}
