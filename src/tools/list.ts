import { z } from "zod";
import { assertAllowedPath } from "../paths.js";
import { extractFieldsFromDoc, loadPdfFromBytes } from "../fields.js";
import { readPdfWithIdentity } from "../identity.js";

export const ListPdfFieldsInput = z.object({
  pdf_path: z.string().min(1),
});

export type ListPdfFieldsInputT = z.infer<typeof ListPdfFieldsInput>;

export async function listPdfFields(input: ListPdfFieldsInputT) {
  const resolved = assertAllowedPath(input.pdf_path, { mustExist: true });
  // Single-buffer: identity, parse, and extraction all derive from one read.
  // Same TOCTOU rationale as fill_pdf_fields.
  const { bytes, identity } = readPdfWithIdentity(resolved);
  const doc = await loadPdfFromBytes(bytes, { path: resolved });
  const result = await extractFieldsFromDoc(doc);
  if (!result.has_fields) {
    return {
      ...identity,
      has_fields: false,
      field_count: 0,
      has_xfa: result.has_xfa,
      xfa_supported: result.xfa_supported,
      message: result.message,
    };
  }
  return {
    ...identity,
    has_fields: true,
    field_count: result.field_count,
    has_xfa: result.has_xfa,
    xfa_supported: result.xfa_supported,
    fields: result.fields,
    message: result.message,
  };
}
