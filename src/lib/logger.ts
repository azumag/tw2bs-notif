export function logInfo(
  component: string,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  console.log(formatLog("info", component, msg, fields));
}

export function logError(
  component: string,
  msg: string,
  err?: unknown,
  fields?: Record<string, unknown>,
): void {
  const errFields: Record<string, unknown> = {
    ...fields,
  };
  if (err instanceof Error) {
    errFields.error = err.message;
    const causes: string[] = [];
    const seen = new Set<Error>([err]);
    let cause: unknown = err.cause;
    while (cause instanceof Error && causes.length < 4 && !seen.has(cause)) {
      seen.add(cause);
      causes.push(`${cause.name}: ${cause.message}`);
      cause = cause.cause;
    }
    if (causes.length > 0) {
      errFields.errorCauses = causes;
    }
  } else if (err !== undefined) {
    errFields.error = String(err);
  }
  console.error(formatLog("error", component, msg, errFields));
}

function formatLog(
  level: "info" | "error",
  component: string,
  msg: string,
  fields?: Record<string, unknown>,
): string {
  const base = `[${level}][${component}] ${msg}`;
  if (!fields || Object.keys(fields).length === 0) {
    return base;
  }
  return `${base} ${JSON.stringify(fields)}`;
}
