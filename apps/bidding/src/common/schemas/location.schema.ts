import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { hasValidCoordinatePair } from '../validation/location-coordinate.constraint';

@Schema({ _id: false })
export class LocationDetail {
  @Prop({ type: String, required: true, trim: true })
  locationName!: string;

  @Prop({ type: String, required: true, trim: true })
  province!: string;

  @Prop({ type: String, required: true, trim: true })
  address!: string;

  @Prop({ type: Number, min: -90, max: 90 })
  latitude?: number;

  @Prop({ type: Number, min: -180, max: 180 })
  longitude?: number;

  @Prop({ type: String, enum: ['USER_CONFIRMED'] })
  coordinateSource?: string;

  @Prop({ type: Date })
  coordinateConfirmedAt?: Date;

  @Prop({ type: String, trim: true })
  contactName?: string;

  @Prop({ type: String, trim: true })
  contactPhone?: string;

  @Prop({ type: Date })
  earliestTime?: Date;

  @Prop({ type: Date })
  latestTime?: Date;
}

export const LocationDetailSchema =
  SchemaFactory.createForClass(LocationDetail);

LocationDetailSchema.pre('validate', function () {
  if (!hasValidCoordinatePair(this)) throw new Error('Location coordinates require a complete valid pair');
});
