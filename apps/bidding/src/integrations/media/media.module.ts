import { Module } from '@nestjs/common';
import { MediaFileClient } from './media-file.client';

@Module({
  providers: [MediaFileClient],
  exports: [MediaFileClient],
})
export class MediaModule {}
