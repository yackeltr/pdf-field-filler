import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface PdfIdentity {
  pdf_sha256: string;
  pdf_size_bytes: number;
  pdf_mtime: string;
}

export function pdfIdentity(pdfPath: string): PdfIdentity {
  const st = statSync(pdfPath);
  const bytes = readFileSync(pdfPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    pdf_sha256: hash,
    pdf_size_bytes: st.size,
    pdf_mtime: st.mtime.toISOString(),
  };
}
