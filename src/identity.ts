import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { PdfFillerError } from "./errors.js";

export interface PdfIdentity {
  pdf_sha256: string;
  pdf_size_bytes: number;
  pdf_mtime: string;
}

// Cap on PDF size loaded into memory. A multi-gigabyte file (legitimate or
// adversarial) would otherwise OOM the Node process. Overridable via env so
// operators with genuinely large fillable PDFs can opt in. Default 100 MB.
const DEFAULT_MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024;

function maxPdfSizeBytes(): number {
  const raw = process.env.PDF_FIELD_FILLER_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_PDF_SIZE_BYTES;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_MAX_PDF_SIZE_BYTES;
}

export function identityFromBytes(bytes: Uint8Array, mtime: Date): PdfIdentity {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    pdf_sha256: hash,
    pdf_size_bytes: bytes.byteLength,
    pdf_mtime: mtime.toISOString(),
  };
}

export interface ReadPdfResult {
  bytes: Buffer;
  identity: PdfIdentity;
}

/**
 * Open the file once, fstat the fd, and read the bytes from the same fd, so
 * size/mtime/hash all come from a single atomic view of the on-disk file.
 * Eliminates the small TOCTOU window between separate stat() and read() calls.
 */
export function readPdfWithIdentity(pdfPath: string): ReadPdfResult {
  const fd = openSync(pdfPath, "r");
  try {
    const st = fstatSync(fd);
    const limit = maxPdfSizeBytes();
    // Guard against memory exhaustion BEFORE the readFileSync(fd) call.
    if (st.size > limit) {
      throw new PdfFillerError(
        "PDF_TOO_LARGE",
        `PDF size ${st.size} bytes exceeds limit ${limit} bytes. Set PDF_FIELD_FILLER_MAX_BYTES to raise the cap.`,
        { path: pdfPath, size: st.size, limit }
      );
    }
    const bytes = readFileSync(fd);
    return { bytes, identity: identityFromBytes(bytes, st.mtime) };
  } finally {
    closeSync(fd);
  }
}

// Path-based pdfIdentity is intentionally removed; callers should use
// readPdfWithIdentity so identity and bytes share a single fd snapshot.
