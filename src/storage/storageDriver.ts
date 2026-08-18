import { Readable } from 'stream';


export interface StorageDriver {
  put(key: string, stream: Readable, contentType: string): Promise<string>;

  get(key: string): Promise<Readable>;

  delete(key: string): Promise<void>;
}