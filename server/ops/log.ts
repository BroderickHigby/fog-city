// Structured logs: one JSON object per line on stdout (stderr for errors), which Fly and most hosts
// collect as-is. Never log tokens, device ids, IP addresses or full room codes.
export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, fields?: Record<string, string | number | boolean>) => void;

export function jsonLogger(write: (line: string, error: boolean) => void = (line, error) => (error ? process.stderr : process.stdout).write(line + "\n"), now: () => number = Date.now): Logger {
  return (level, event, fields = {}) => write(JSON.stringify({ ts: new Date(now()).toISOString(), level, event, ...fields }), level === "error");
}
export const silentLogger: Logger = () => {};
/** A room code safe to log: enough to correlate lines, not enough to join. */
export const codeTag = (code: string): string => `${code.slice(0, 2)}…`;
