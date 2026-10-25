import { createHash } from 'node:crypto';

export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

export const shortHash = (value: string | Buffer): string => sha256(value).slice(0, 16);
