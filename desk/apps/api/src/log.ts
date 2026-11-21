/** The slice of a logger the shell needs; Fastify's logger and `console` both fit. */
export interface Log { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

export const consoleLog: Log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};
export const silentLog: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
