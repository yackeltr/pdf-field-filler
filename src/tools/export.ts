import { z } from "zod";
import { existsSync, writeFileSync, openSync, fsyncSync, closeSync, unlinkSync, renameSync } from "node:fs";
import path from "node:path";
import { assertAllowedPath, ensureOutputAllowed } from "../paths.js";
import { extractFieldsFromDoc, loadPdfFromBytes } from "../fields.js";
import { readPdfWithIdentity } from "../identity.js";
import { PdfFillerError } from "../errors.js";

export const SERVER_VERSION = "0.3.1";

export const ExportPdfFieldMapInput = z.object({
  pdf_path: z.string().min(1),
  output_json_path: z.string().min(1),
  overwrite: z.boolean().optional().default(false),
});

export type ExportPdfFieldMapInputT = z.infer<typeof ExportPdfFieldMapInput>;

export interface ExportPdfFieldMapResult {
  output_json_path: string;
  pdf_sha256: string;
  pdf_size_bytes: number;
  pdf_mtime: string;
  server_version: string;
  field_count: number;
  has_xfa: boolean;
  xfa_supported: boolean;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export async function exportPdfFieldMap(input: ExportPdfFieldMapInputT): Promise<ExportPdfFieldMapResult> {
  const resolvedInput = assertAllowedPath(input.pdf_path, { mustExist: true });
  const resolvedOutput = ensureOutputAllowed(input.output_json_path, resolvedInput);

  if (existsSync(resolvedOutput) && !input.overwrite) {
    throw new PdfFillerError(
      "OUTPUT_EXISTS",
      `Output file already exists; pass overwrite: true to replace it.`,
      { output_json_path: resolvedOutput }
    );
  }

  const { bytes, identity } = readPdfWithIdentity(resolvedInput);
  const doc = await loadPdfFromBytes(bytes, { path: resolvedInput });
  const extraction = await extractFieldsFromDoc(doc);

  const payload = {
    ...identity,
    server_version: SERVER_VERSION,
    pdf_path: resolvedInput,
    exported_at: new Date().toISOString(),
    has_fields: extraction.has_fields,
    field_count: extraction.field_count,
    has_xfa: extraction.has_xfa,
    xfa_supported: extraction.xfa_supported,
    message: extraction.message,
    fields: extraction.fields,
  };

  const json = JSON.stringify(payload, null, 2);
  const tmpPath = path.join(
    path.dirname(resolvedOutput),
    `.${path.basename(resolvedOutput)}.tmp.${process.pid}.${timestamp()}`
  );
  try {
    writeFileSync(tmpPath, json, "utf-8");
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, resolvedOutput);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw new PdfFillerError(
      "WRITE_FAILED",
      `Failed to write field map JSON: ${(err as Error).message}`,
      { output_json_path: resolvedOutput }
    );
  }

  return {
    output_json_path: resolvedOutput,
    pdf_sha256: identity.pdf_sha256,
    pdf_size_bytes: identity.pdf_size_bytes,
    pdf_mtime: identity.pdf_mtime,
    server_version: SERVER_VERSION,
    field_count: extraction.field_count,
    has_xfa: extraction.has_xfa,
    xfa_supported: extraction.xfa_supported,
  };
}
