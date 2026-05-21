import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

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

export function readPdfWithIdentity(pdfPath: string): ReadPdfResult {
  const st = statSync(pdfPath);
  const bytes = readFileSync(pdfPath);
  return {
    bytes,
    identity: identityFromBytes(bytes, st.mtime),
  };
}

export function pdfIdentity(pdfPath: string): PdfIdentity {
  return readPdfWithIdentity(pdfPath).identity;
}
