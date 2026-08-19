import { Readable } from 'stream';

export interface StorageDriver {
  put(key: string, stream: Readable, contentType: string, sizeBytes?: number): Promise<string>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}