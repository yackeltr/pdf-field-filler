import { z } from "zod";
import { assertAllowedPath } from "../paths.js";
import { extractFields } from "../fields.js";

export const ListPdfFieldsInput = z.object({
  pdf_path: z.string().min(1),
});

export type ListPdfFieldsInputT = z.infer<typeof ListPdfFieldsInput>;

export async function listPdfFields(input: ListPdfFieldsInputT) {
  const resolved = assertAllowedPath(input.pdf_path, { mustExist: true });
  const result = await extractFields(resolved);
  if (!result.has_fields) {
    return {
      has_fields: false,
      field_count: 0,
      message: result.message,
    };
  }
  return {
    has_fields: true,
    field_count: result.field_count,
    fields: result.fields,
  };
}
