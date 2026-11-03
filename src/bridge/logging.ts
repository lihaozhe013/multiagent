export interface LogFields {
  [key: string]: unknown;
}

function write(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    scope: 'bridge',
    message,
    ...fields
  };
  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(message: string, fields: LogFields = {}): void {
  write('info', message, fields);
}

export function logWarn(message: string, fields: LogFields = {}): void {
  write('warn', message, fields);
}

export function logError(message: string, fields: LogFields = {}): void {
  write('error', message, fields);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
