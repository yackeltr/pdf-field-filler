import { z } from "zod";
import { assertAllowedPath } from "../paths.js";
import { extractFields } from "../fields.js";
import { pdfIdentity } from "../identity.js";

export const ListPdfFieldsInput = z.object({
  pdf_path: z.string().min(1),
});

export type ListPdfFieldsInputT = z.infer<typeof ListPdfFieldsInput>;

export async function listPdfFields(input: ListPdfFieldsInputT) {
  const resolved = assertAllowedPath(input.pdf_path, { mustExist: true });
  const identity = pdfIdentity(resolved);
  const result = await extractFields(resolved);
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
