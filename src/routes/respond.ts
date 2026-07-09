/**
 * The one error → HTTP response funnel every router uses, so the mapping
 * (zod flattening, typed-error passthrough, provider mapping, 5xx logging)
 * cannot drift between planes.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { TelegramToolError, mapTelegramError, validationFromZod } from '../errors.js';
import { logError } from '../logger.js';

/** Convert any thrown value to a typed TelegramToolError. */
export function toTelegramToolError(err: unknown): TelegramToolError {
  if (err instanceof z.ZodError) return validationFromZod(err);
  if (err instanceof TelegramToolError) return err;
  return mapTelegramError(err);
}

/** Send the uniform JSON error response; 5xx failures are logged with the original error. */
export function respondWithError(res: Response, err: unknown, context: string): void {
  const mapped = toTelegramToolError(err);
  if (mapped.httpStatus >= 500) logError(`${context} failure`, err);
  res.status(mapped.httpStatus).json(mapped.toBody());
}
