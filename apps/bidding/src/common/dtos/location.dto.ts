import { Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsOptional, IsString, IsNumber, Min, Max, Validate, MaxLength } from 'class-validator';
import { LocationCoordinateConstraint } from '../validation/location-coordinate.constraint';

export class LocationDetailDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  locationName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  province!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address!: string;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90) @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180) @Max(180)
  longitude?: number;

  // Always validates the pair, including when this field is absent.
  @Validate(LocationCoordinateConstraint)
  coordinateSource?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  coordinateConfirmedAt?: Date;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  earliestTime?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  latestTime?: Date;
}
