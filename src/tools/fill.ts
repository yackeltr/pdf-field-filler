import { z } from "zod";
import {
  existsSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { assertAllowedPath, ensureOutputAllowed } from "../paths.js";
import { extractFieldsFromDoc, FieldInfo, loadPdfFromBytes } from "../fields.js";
import { PdfFillerError } from "../errors.js";
import { readPdfWithIdentity, PdfIdentity } from "../identity.js";
import {
  PDFCheckBox,
  PDFRadioGroup,
  PDFTextField,
  PDFDropdown,
  PDFOptionList,
  PDFName,
  PDFDict,
} from "pdf-lib";

export const FillPdfFieldsInput = z.object({
  pdf_path: z.string().min(1),
  output_path: z.string().min(1),
  field_values: z.record(z.unknown()),
  dry_run: z.boolean(),
  expected_pdf_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export type FillPdfFieldsInputT = z.infer<typeof FillPdfFieldsInput>;

export interface WriteEntry {
  field_name: string;
  field_type: string;
  from: unknown;
  to: unknown;
}

export interface FillResult extends PdfIdentity {
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

function widgetOnName(widgetDict: PDFDict): string | null {
  const ap = widgetDict.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return null;
  const n = ap.lookup(PDFName.of("N"));
  if (!(n instanceof PDFDict)) return null;
  for (const k of n.keys()) {
    const name = k.decodeText();
    if (name !== "Off") return name;
  }
  return null;
}

function applyBtnExport(
  widgets: Array<{ dict: PDFDict }>,
  acroSetValue: (v: PDFName) => void,
  selectedExport: string
): void {
  // 1) Logical /V on the field is the selected export name.
  acroSetValue(PDFName.of(selectedExport));
  // 2) Per-widget /AS: only the widget whose own /AP/N exposes the selected
  //    export gets /AS = selected. Every other widget in the group is
  //    explicitly reset to /Off so no stale appearance lingers from a prior
  //    selection. This is what makes the visible button match /V across all
  //    viewers, including those that don't rebuild appearances from /V alone.
  const offName = PDFName.of("Off");
  const targetName = PDFName.of(selectedExport);
  for (const w of widgets) {
    const own = widgetOnName(w.dict);
    if (own === selectedExport) {
      w.dict.set(PDFName.of("AS"), targetName);
    } else {
      w.dict.set(PDFName.of("AS"), offName);
    }
  }
}

function uncheckBtn(widgets: Array<{ dict: PDFDict }>, acroSetValue: (v: PDFName) => void): void {
  acroSetValue(PDFName.of("Off"));
  const offName = PDFName.of("Off");
  for (const w of widgets) {
    w.dict.set(PDFName.of("AS"), offName);
  }
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

  // Open the input ONCE. Identity (size/mtime/hash), extract, and load all
  // derive from the bytes read from this single fd, so neither a file-swap
  // nor a path-rebind between calls can defeat the identity check.
  const { bytes: inputBytes, identity } = readPdfWithIdentity(resolvedInput);

  if (input.expected_pdf_sha256 && input.expected_pdf_sha256.toLowerCase() !== identity.pdf_sha256) {
    throw new PdfFillerError(
      "PDF_IDENTITY_MISMATCH",
      "Input PDF SHA-256 does not match expected_pdf_sha256.",
      {
        expected_pdf_sha256: input.expected_pdf_sha256.toLowerCase(),
        actual_pdf_sha256: identity.pdf_sha256,
      }
    );
  }

  const doc = await loadPdfFromBytes(inputBytes, { path: resolvedInput });
  const extraction = await extractFieldsFromDoc(doc);
  const byName = new Map<string, FieldInfo>();
  for (const f of extraction.fields) byName.set(f.name, f);

  const unknown_fields: string[] = [];
  const blocked_human_only_fields: string[] = [];
  const blocked_read_only_fields: string[] = [];
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
    if (field.is_read_only) {
      blocked_read_only_fields.push(key);
      continue;
    }
    if (isSkipValue(proposed)) {
      skipped.push({ field_name: key, reason: "value is null/undefined" });
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
  if (blocked_read_only_fields.length > 0) {
    throw new PdfFillerError(
      "READ_ONLY_FIELDS",
      `Refused to fill read-only fields: ${blocked_read_only_fields.join(", ")}`,
      { blocked_read_only_fields }
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
      ...identity,
      dry_run: true,
      would_write: writeEntries,
      blocked_human_only_fields: [],
      unknown_fields: [],
      illegal_values: [],
      skipped,
    };
  }

  const form = doc.getForm();

  for (const p of planned) {
    const fieldName = p.field.name;
    try {
      switch (p.field.type) {
        case "text": {
          const f = form.getField(fieldName) as PDFTextField;
          if (!(f instanceof PDFTextField)) throw new Error("expected text field");
          // Always write the literal string; "" writes an empty value rather than clearing /V.
          f.setText(p.normalized as string);
          break;
        }
        case "checkbox": {
          const f = form.getField(fieldName) as PDFCheckBox;
          if (!(f instanceof PDFCheckBox)) throw new Error("expected checkbox");
          const v = p.normalized;
          const widgets = f.acroField.getWidgets();
          const set = (n: PDFName) => f.acroField.setValue(n);
          if (typeof v === "boolean") {
            if (!v) uncheckBtn(widgets, set);
            else applyBtnExport(widgets, set, p.field.options[0] ?? "Yes");
          } else if (typeof v === "string") {
            if (v === "Off") uncheckBtn(widgets, set);
            else applyBtnExport(widgets, set, v);
          }
          break;
        }
        case "radio": {
          const f = form.getField(fieldName) as PDFRadioGroup;
          if (!(f instanceof PDFRadioGroup)) throw new Error("expected radio group");
          const widgets = f.acroField.getWidgets();
          applyBtnExport(widgets, (n) => f.acroField.setValue(n), p.normalized as string);
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

  let bytes: Uint8Array;
  try {
    bytes = await doc.save({ updateFieldAppearances: true });
  } catch (err) {
    throw new PdfFillerError("WRITE_FAILED", `Failed to serialize PDF: ${(err as Error).message}`);
  }

  // Step 1: write + fsync temp first, so a durable copy exists on disk
  // before we touch the pre-existing output. A crash between backup-rename
  // and final-rename otherwise leaves no file at output_path.
  const tmpPath = path.join(
    path.dirname(resolvedOutput),
    `.${path.basename(resolvedOutput)}.tmp.${process.pid}.${timestamp()}`
  );
  try {
    writeFileSync(tmpPath, bytes);
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw new PdfFillerError(
      "WRITE_FAILED",
      `Failed to write temp output PDF: ${(err as Error).message}`,
      { output_path: resolvedOutput }
    );
  }

  // Step 2: back up an existing output (rename moves it out of the way).
  let backup_path: string | null = null;
  if (existsSync(resolvedOutput)) {
    backup_path = `${resolvedOutput}.backup.${timestamp()}`;
    try {
      renameSync(resolvedOutput, backup_path);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      throw new PdfFillerError(
        "OUTPUT_BACKUP_FAILED",
        `Failed to back up existing output file.`,
        { output_path: resolvedOutput, cause: (err as Error).message }
      );
    }
  }

  // Step 3: atomic rename temp -> final.
  try {
    renameSync(tmpPath, resolvedOutput);
  } catch (err) {
    const original_error = (err as Error).message;
    // Clean up the temp file if it's still around.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    // If we moved the previous output to backup and nothing now lives at
    // output_path, try to undo the backup so the caller's filesystem returns
    // to its pre-fill state. Only rename back if output_path is empty (we
    // don't want to clobber a file that some other process wrote in the gap).
    let rollback_attempted = false;
    let rollback_succeeded = false;
    let rollback_error: string | undefined;
    if (backup_path && !existsSync(resolvedOutput)) {
      rollback_attempted = true;
      try {
        renameSync(backup_path, resolvedOutput);
        rollback_succeeded = true;
      } catch (rbErr) {
        rollback_error = (rbErr as Error).message;
      }
    }
    throw new PdfFillerError(
      "WRITE_FAILED",
      `Failed to publish output PDF: ${original_error}`,
      {
        output_path: resolvedOutput,
        backup_path,
        rollback_attempted,
        rollback_succeeded,
        original_error,
        ...(rollback_error ? { rollback_error } : {}),
        recovery_hint: rollback_succeeded
          ? "Auto-rollback restored the pre-existing output file from backup."
          : backup_path
          ? "The pre-existing output is preserved at backup_path; rename it back to recover."
          : "No prior output existed; nothing to recover.",
      }
    );
  }

  return {
    ...identity,
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
