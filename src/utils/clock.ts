import { v4 as uuidv4 } from 'uuid';

/**
 * Indirection over time and id generation. Centralizing these makes services
 * deterministic under test (a fake clock / seeded id sequence can be injected)
 * and keeps `new Date()` and uuid calls out of business logic.
 */
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