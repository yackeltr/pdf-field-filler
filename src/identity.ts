import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";

export interface PdfIdentity {
  pdf_sha256: string;
  pdf_size_bytes: number;
  pdf_mtime: string;
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
    const bytes = readFileSync(fd);
    return { bytes, identity: identityFromBytes(bytes, st.mtime) };
  } finally {
    closeSync(fd);
  }
}

// Path-based pdfIdentity is intentionally removed; callers should use
// readPdfWithIdentity so identity and bytes share a single fd snapshot.
