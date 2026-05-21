import { z } from "zod";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { assertAllowedPath, ensureOutputAllowed } from "../paths.js";
import { extractFields, FieldInfo, loadPdf } from "../fields.js";
import { PdfFillerError } from "../errors.js";
import {
  PDFCheckBox,
  PDFRadioGroup,
  PDFTextField,
  PDFDropdown,
  PDFOptionList,
} from "pdf-lib";

export const FillPdfFieldsInput = z.object({
  pdf_path: z.string().min(1),
  output_path: z.string().min(1),
  field_values: z.record(z.unknown()),
  dry_run: z.boolean(),
});

export type FillPdfFieldsInputT = z.infer<typeof FillPdfFieldsInput>;

export interface WriteEntry {
  field_name: string;
  field_type: string;
  from: unknown;
  to: unknown;
}

export interface FillResult {
  dry_run: boolean;
  output_path?: string;
  backup_path?: string | null;
  would_write?: WriteEntry[];
  written?: WriteEntry[];
  blocked_human_only_fields: string[];
  unknown_fields: string[];
  illegal_values: { field_name: string; proposed_value: unknown; reason: string; legal_options: string[] }[];
  skipped: { field_name: string; reason: string }[];
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

function isSkipValue(v: unknown): boolean {
  return v === null || v === undefined;
}

function validateLegalValue(field: FieldInfo, proposed: unknown):
  | { ok: true; normalized: string | boolean | string[] }
  | { ok: false; reason: string; legal_options: string[] } {
  switch (field.type) {
    case "text": {
      if (typeof proposed === "string") return { ok: true, normalized: proposed };
      if (typeof proposed === "number") return { ok: true, normalized: String(proposed) };
      return { ok: false, reason: "Text fields accept string or number.", legal_options: [] };
    }
    case "checkbox": {
      if (typeof proposed === "boolean") return { ok: true, normalized: proposed };
      if (typeof proposed === "string") {
        if (field.options.length === 0 || field.options.includes(proposed)) {
          return { ok: true, normalized: proposed };
        }
        return {
          ok: false,
          reason: `Checkbox value "${proposed}" is not a legal option.`,
          legal_options: field.options,
        };
      }
      return {
        ok: false,
        reason: "Checkbox accepts boolean or a legal option string.",
        legal_options: field.options,
      };
    }
    case "radio": {
      if (typeof proposed === "string") {
        if (field.options.length === 0) {
          return { ok: false, reason: "Radio field has no detected options.", legal_options: [] };
        }
        if (field.options.includes(proposed)) return { ok: true, normalized: proposed };
        return {
          ok: false,
          reason: `Radio value "${proposed}" is not a legal option.`,
          legal_options: field.options,
        };
      }
      return {
        ok: false,
        reason: "Radio accepts only a legal option string.",
        legal_options: field.options,
      };
    }
    case "dropdown": {
      if (typeof proposed === "string") {
        if (field.options.length === 0 || field.options.includes(proposed)) {
          return { ok: true, normalized: proposed };
        }
        return {
          ok: false,
          reason: `Value "${proposed}" is not a legal option.`,
          legal_options: field.options,
        };
      }
      return {
        ok: false,
        reason: "Dropdown accepts only a legal option string.",
        legal_options: field.options,
      };
    }
    case "option_list": {
      if (Array.isArray(proposed)) {
        for (const p of proposed) {
          if (typeof p !== "string") {
            return {
              ok: false,
              reason: "Option list values must be strings.",
              legal_options: field.options,
            };
          }
          if (field.options.length > 0 && !field.options.includes(p)) {
            return {
              ok: false,
              reason: `Value "${p}" is not a legal option.`,
              legal_options: field.options,
            };
          }
        }
        return { ok: true, normalized: proposed as string[] };
      }
      if (typeof proposed === "string") {
        if (field.options.length === 0 || field.options.includes(proposed)) {
          return { ok: true, normalized: [proposed] };
        }
        return {
          ok: false,
          reason: `Value "${proposed}" is not a legal option.`,
          legal_options: field.options,
        };
      }
      return {
        ok: false,
        reason: "Option list accepts string or string array.",
        legal_options: field.options,
      };
    }
    default:
      return { ok: false, reason: `Field type "${field.type}" is not fillable.`, legal_options: [] };
  }
}

export async function fillPdfFields(input: FillPdfFieldsInputT): Promise<FillResult> {
  const resolvedInput = assertAllowedPath(input.pdf_path, { mustExist: true });
  const resolvedOutput = ensureOutputAllowed(input.output_path, resolvedInput);

  const extraction = await extractFields(resolvedInput);
  const byName = new Map<string, FieldInfo>();
  for (const f of extraction.fields) byName.set(f.name, f);

  const unknown_fields: string[] = [];
  const blocked_human_only_fields: string[] = [];
  const illegal_values: FillResult["illegal_values"] = [];
  const skipped: FillResult["skipped"] = [];

  const planned: { field: FieldInfo; normalized: string | boolean | string[] }[] = [];

  for (const [key, proposed] of Object.entries(input.field_values)) {
    const field = byName.get(key);
    if (!field) {
      unknown_fields.push(key);
      continue;
    }
    if (field.is_human_only || field.is_signature_field) {
      blocked_human_only_fields.push(key);
      continue;
    }
    if (isSkipValue(proposed)) {
      skipped.push({ field_name: key, reason: "value is null/undefined" });
      continue;
    }
    if (field.is_read_only) {
      skipped.push({ field_name: key, reason: "field is read-only" });
      continue;
    }
    const check = validateLegalValue(field, proposed);
    if (!check.ok) {
      illegal_values.push({
        field_name: key,
        proposed_value: proposed,
        reason: check.reason,
        legal_options: check.legal_options,
      });
      continue;
    }
    planned.push({ field, normalized: check.normalized });
  }

  if (unknown_fields.length > 0) {
    throw new PdfFillerError(
      "UNKNOWN_FIELDS",
      `Unknown field names: ${unknown_fields.join(", ")}`,
      { unknown_fields }
    );
  }
  if (blocked_human_only_fields.length > 0) {
    throw new PdfFillerError(
      "HUMAN_ONLY_FIELDS",
      `Refused to fill human-only fields: ${blocked_human_only_fields.join(", ")}`,
      { blocked_human_only_fields }
    );
  }
  if (illegal_values.length > 0) {
    throw new PdfFillerError(
      "ILLEGAL_VALUES",
      `One or more values are not legal for their field types.`,
      { illegal_values }
    );
  }

  const writeEntries: WriteEntry[] = planned.map((p) => ({
    field_name: p.field.name,
    field_type: p.field.type,
    from: p.field.current_value,
    to: p.normalized,
  }));

  if (input.dry_run) {
    return {
      dry_run: true,
      would_write: writeEntries,
      blocked_human_only_fields: [],
      unknown_fields: [],
      illegal_values: [],
      skipped,
    };
  }

  const doc = await loadPdf(resolvedInput);
  const form = doc.getForm();

  for (const p of planned) {
    const fieldName = p.field.name;
    try {
      switch (p.field.type) {
        case "text": {
          const f = form.getField(fieldName) as PDFTextField;
          if (!(f instanceof PDFTextField)) throw new Error("expected text field");
          const v = p.normalized as string;
          if (v.length === 0) f.setText(undefined);
          else f.setText(v);
          break;
        }
        case "checkbox": {
          const f = form.getField(fieldName) as PDFCheckBox;
          if (!(f instanceof PDFCheckBox)) throw new Error("expected checkbox");
          const v = p.normalized;
          if (typeof v === "boolean") {
            if (v) f.check();
            else f.uncheck();
          } else if (typeof v === "string") {
            if (v === "Off") f.uncheck();
            else f.check();
          }
          break;
        }
        case "radio": {
          const f = form.getField(fieldName) as PDFRadioGroup;
          if (!(f instanceof PDFRadioGroup)) throw new Error("expected radio group");
          f.select(p.normalized as string);
          break;
        }
        case "dropdown": {
          const f = form.getField(fieldName) as PDFDropdown;
          if (!(f instanceof PDFDropdown)) throw new Error("expected dropdown");
          f.select(p.normalized as string);
          break;
        }
        case "option_list": {
          const f = form.getField(fieldName) as PDFOptionList;
          if (!(f instanceof PDFOptionList)) throw new Error("expected option list");
          f.select(p.normalized as string[]);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PdfFillerError(
        "WRITE_FAILED",
        `Failed to write field "${fieldName}": ${msg}`,
        { field_name: fieldName }
      );
    }
  }

  let backup_path: string | null = null;
  if (existsSync(resolvedOutput)) {
    backup_path = `${resolvedOutput}.backup.${timestamp()}`;
    try {
      renameSync(resolvedOutput, backup_path);
    } catch (err) {
      throw new PdfFillerError(
        "OUTPUT_BACKUP_FAILED",
        `Failed to back up existing output file.`,
        { output_path: resolvedOutput, cause: (err as Error).message }
      );
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save({ updateFieldAppearances: true });
  } catch (err) {
    throw new PdfFillerError("WRITE_FAILED", `Failed to serialize PDF: ${(err as Error).message}`);
  }
  try {
    writeFileSync(resolvedOutput, bytes);
  } catch (err) {
    throw new PdfFillerError(
      "WRITE_FAILED",
      `Failed to write output PDF: ${(err as Error).message}`,
      { output_path: resolvedOutput }
    );
  }

  return {
    dry_run: false,
    output_path: resolvedOutput,
    backup_path,
    written: writeEntries,
    blocked_human_only_fields: [],
    unknown_fields: [],
    illegal_values: [],
    skipped,
  };
}
