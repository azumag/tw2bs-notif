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
