export type ErrorCode =
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_ALLOWED"
  | "PDF_NOT_FOUND"
  | "PDF_PARSE_ERROR"
  | "PDF_ENCRYPTED"
  | "UNKNOWN_FIELDS"
  | "ILLEGAL_VALUES"
  | "HUMAN_ONLY_FIELDS"
  | "OUTPUT_EQUALS_INPUT"
  | "OUTPUT_BACKUP_FAILED"
  | "WRITE_FAILED"
  | "INVALID_INPUT"
  | "PDF_IDENTITY_MISMATCH"
  | "OUTPUT_EXISTS"
  | "READ_ONLY_FIELDS"
  | "PDF_TOO_LARGE";

export interface ErrorPayload {
  ok: false;
  error_code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class PdfFillerError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PdfFillerError";
    this.code = code;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return {
      ok: false,
      error_code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof PdfFillerError) return err.toPayload();
  // ZodError comes from tool input parsing — it's an input contract failure,
  // not a PDF problem. Returning PDF_PARSE_ERROR here would mislead the
  // caller into looking at the file instead of the arguments. Detect by
  // shape rather than by importing zod (avoids a hard dep in this module).
  if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") {
    const zerr = err as { issues?: unknown[]; message?: string };
    return {
      ok: false,
      error_code: "INVALID_INPUT",
      message: zerr.message ?? "Invalid tool arguments.",
      details: { issues: zerr.issues ?? [] },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error_code: "PDF_PARSE_ERROR",
    message,
    details: {},
  };
}
