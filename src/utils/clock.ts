import { v4 as uuidv4 } from 'uuid';

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export function generateId(): string {
  return uuidv4();
}