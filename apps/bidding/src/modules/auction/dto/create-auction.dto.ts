import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  ArrayMaxSize,
  MaxLength,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { AuctionType } from '../../../common/enums/auction-type.enum';
import { LocationDetailDto } from '../../../common/dtos/location.dto';
import { VehicleSpecsDto } from '../../../common/dtos/vehicle.dto';
import { ParticipationFeeTier } from '../fee-policy';

export class CreateAuctionDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  goodsType!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  weight!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  volume?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'goodsValue must be a decimal string',
  })
  goodsValue?: string;

  @IsString()
  @IsNotEmpty()
  vehicleTypeRequired!: string;

  /** Optional shipper proof of the goods' declared value: keys or upload URLs from the goods-value-docs folder. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  valueDocuments?: string[];

  @IsOptional()
  @IsString()
  requiredTemp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VehicleSpecsDto)
  vehicleSpecs?: VehicleSpecsDto;

  @ValidateNested()
  @Type(() => LocationDetailDto)
  pickupLocation!: LocationDetailDto;

  @ValidateNested()
  @Type(() => LocationDetailDto)
  deliveryLocation!: LocationDetailDto;

  @IsEnum(AuctionType)
  auctionType!: AuctionType;

  /** When true, only carriers whose cargo-liability certificate an admin verified (and not expired) may bid. */
  @IsOptional()
  @IsBoolean()
  requireCarrierCoverage?: boolean;

  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'maxPrice must be a decimal string',
  })
  maxPrice!: string;

  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'priceStep must be a decimal string',
  })
  priceStep!: string;

  @IsEnum(ParticipationFeeTier)
  participationFeeTier!: ParticipationFeeTier;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxBids?: number;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsBoolean()
  isDepositRequired!: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'depositAmount must be a decimal string',
  })
  depositAmount?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  registrationStartTime?: Date;

  @Type(() => Date)
  @IsDate()
  registrationEndTime!: Date;

  @Type(() => Date)
  @IsDate()
  startTime!: Date;

  @Type(() => Date)
  @IsDate()
  endTime!: Date;
}
