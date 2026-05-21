export type ErrorCode =
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_ALLOWED"
  | "PDF_NOT_FOUND"
  | "PDF_PARSE_ERROR"
  | "PDF_ENCRYPTED"
  | "NO_ACROFORM_FIELDS"
  | "UNKNOWN_FIELDS"
  | "ILLEGAL_VALUES"
  | "HUMAN_ONLY_FIELDS"
  | "OUTPUT_EQUALS_INPUT"
  | "OUTPUT_BACKUP_FAILED"
  | "WRITE_FAILED"
  | "INVALID_INPUT"
  | "PDF_IDENTITY_MISMATCH"
  | "OUTPUT_EXISTS";

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
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error_code: "PDF_PARSE_ERROR",
    message,
    details: {},
  };
}
