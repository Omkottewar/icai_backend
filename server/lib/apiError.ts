/**
 * Lightweight error type carried through Express's error pipeline.
 * Routes throw it; the top-level handler turns it into a JSON response.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function handleApiError(err: unknown, res: import("express").Response, next: import("express").NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

export const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export const need = (val: string, label: string) => {
  if (!val) throw new ApiError(400, `${label} is required`);
  return val;
};
