import type { ZodType, ZodTypeDef } from 'zod';

/** An error a route throws to answer with a status and a one-line reason. */
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
/** Parses a request body or query with a zod schema; a failure becomes a 400 in the app's error handler. */
export const parseWith = <T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T => schema.parse(input);
