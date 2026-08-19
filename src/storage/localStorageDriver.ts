import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { env } from '../config/env';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import type { StorageDriver } from './storageDriver';


const SAFE_KEY_RE = /^[a-f0-9-]{36}\.[a-z0-9]{1,10}$/i;

function resolveSafePath(key: string): string {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`Unsafe storage key rejected: ${key}`);
  }
  const base = path.resolve(env.STORAGE_LOCAL_DIR);
  const target = path.resolve(base, key);
  // Double-check after resolve — belt-and-suspenders guard against symlink tricks.
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error(`Path traversal attempt blocked: ${key}`);
  }
  return target;
}

export class LocalStorageDriver implements StorageDriver {
  constructor() {
    fs.mkdirSync(path.resolve(env.STORAGE_LOCAL_DIR), { recursive: true });
  }

  async put(key: string, stream: Readable, _contentType: string, _sizeBytes?: number): Promise<string> {
    const finalPath = resolveSafePath(key);
    const tmpPath = `${finalPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const writeStream = fs.createWriteStream(tmpPath);
      await pipeline(stream, writeStream);
      fs.renameSync(tmpPath, finalPath);
      logger.debug({ key }, 'storage.put: file written');
      return key;
    } catch (err) {
      // Clean up the partial tmp file if it exists.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const filePath = resolveSafePath(key);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError(`Attachment not found: ${key}`);
    }
    return fs.createReadStream(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = resolveSafePath(key);
    try {
      fs.unlinkSync(filePath);
      logger.debug({ key }, 'storage.delete: file removed');
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') throw err;
      // ENOENT → already gone, treat as success (idempotent delete).
    }
  }
}