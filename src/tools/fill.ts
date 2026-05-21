import { z } from "zod";
import {
  existsSync,
  renameSync as fsRenameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";

// Module-private indirection for renameSync so tests can inject failures at
// the precise rename phase (backup vs publish vs rollback) — vitest cannot
// spy on ESM exports, and the rollback branch is otherwise unexercised.
// Production code always uses fs.renameSync via this binding; the only
// caller of __setRenameImpl is the test suite.
type RenameFn = typeof fsRenameSync;
let renameImpl: RenameFn = fsRenameSync;
export function __setRenameImplForTests(fn: RenameFn | null): void {
  // Refuse calls from production. vitest sets process.env.VITEST,
  // NODE_ENV=test is the conventional alternative. Either is sufficient.
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setRenameImplForTests is a test-only seam; refusing to mutate the fill path in production."
    );
  }
  renameImpl = fn ?? fsRenameSync;
}
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

import { timestamp } from "../utils.js";

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
  fieldDict: PDFDict,
  widgets: Array<{ dict: PDFDict }>,
  selectedExport: string
): void {
  // 1) Logical /V on the field is the selected export name. We write directly
  //    to the field dict rather than going through pdf-lib's
  //    PDFAcroCheckBox.setValue, which validates the name against its own
  //    notion of the "on" state — that validation rejects per-widget exports
  //    in heterogeneous-checkbox-group fields. Direct write is faithful to
  //    the AcroForm spec, which allows any non-Off /AP/N name as the /V.
  fieldDict.set(PDFName.of("V"), PDFName.of(selectedExport));
  // 2) Per-widget /AS:
  //    - The widget whose own /AP/N exposes `selectedExport` as a non-Off
  //      state gets /AS = selectedExport.
  //    - Every other widget in the group is explicitly reset to /Off.
  //
  //    This handles two distinct cases under a single rule:
  //      (a) Homogeneous widgets (the common case): all widgets share the
  //          same non-Off /AP/N key. Only one widget matches the selection
  //          per call; the rest go Off.
  //      (b) Heterogeneous widgets (rare, e.g. some government forms model
  //          a mutually-exclusive checkbox group as one field with different
  //          per-widget export names): the matching widget shows its own
  //          appearance, the others go Off. Setting every widget's AS to
  //          the same target name would produce broken appearances on
  //          widgets whose /AP/N doesn't contain that key.
  //
  //    The per-widget /AP/N inspection (via widgetOnName) is what makes
  //    case (b) correct rather than relying on validate having narrowed
  //    the value space.
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

function uncheckBtn(fieldDict: PDFDict, widgets: Array<{ dict: PDFDict }>): void {
  // Write /V = /Off directly for the same reason as applyBtnExport.
  fieldDict.set(PDFName.of("V"), PDFName.of("Off"));
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
      let s: string | null = null;
      if (typeof proposed === "string") s = proposed;
      else if (typeof proposed === "number") s = String(proposed);
      else return { ok: false, reason: "Text fields accept string or number.", legal_options: [] };
      // Enforce AcroForm /MaxLen at fill time. pdf-lib's setText does not
      // honor MaxLen, and viewers that do enforce it will either clip the
      // value silently or reject the filled PDF.
      if (field.max_length !== null && s.length > field.max_length) {
        return {
          ok: false,
          reason: `Value length ${s.length} exceeds MaxLen ${field.max_length}.`,
          legal_options: [],
        };
      }
      return { ok: true, normalized: s };
    }
    case "checkbox": {
      if (typeof proposed === "boolean") {
        // If we couldn't read any /AP/N states off the widgets, we have no
        // export name to write — applyBtnExport would set /V to a guessed
        // "Yes" while every widget gets /AS = Off, producing a logically
        // checked but visually unchecked field. Refuse rather than write a
        // broken state.
        if (proposed === true && field.options.length === 0) {
          return {
            ok: false,
            reason:
              "Checkbox has no readable /AP/N export states; cannot honor `true`. Supply the exact export name instead, or leave the field empty.",
            legal_options: [],
          };
        }
        return { ok: true, normalized: proposed };
      }
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
  // Refuse to write any AcroForm changes if the PDF carries an /XFA stream.
  // pdf-lib's form/save path can drop or rewrite /XFA when AcroForm fields
  // are touched, which would violate the "never mutates XFA" guarantee in
  // SECURITY.md. list_pdf_fields and validate_pdf_fill are read-only and
  // remain allowed on XFA-bearing PDFs; only fill is gated.
  if (extraction.has_xfa) {
    throw new PdfFillerError(
      "XFA_PRESENT",
      "Refusing to fill: the input PDF contains an /XFA stream. Filling AcroForm fields here can cause pdf-lib to drop or rewrite XFA on save, which is outside this server's safety guarantee.",
      { path: resolvedInput }
    );
  }
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
          const fdict = f.acroField.dict;
          if (typeof v === "boolean") {
            if (!v) uncheckBtn(fdict, widgets);
            else applyBtnExport(fdict, widgets, p.field.options[0] ?? "Yes");
          } else if (typeof v === "string") {
            if (v === "Off") uncheckBtn(fdict, widgets);
            else applyBtnExport(fdict, widgets, v);
          }
          break;
        }
        case "radio": {
          const f = form.getField(fieldName) as PDFRadioGroup;
          if (!(f instanceof PDFRadioGroup)) throw new Error("expected radio group");
          applyBtnExport(f.acroField.dict, f.acroField.getWidgets(), p.normalized as string);
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
      renameImpl(resolvedOutput, backup_path);
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
    renameImpl(tmpPath, resolvedOutput);
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
        renameImpl(backup_path, resolvedOutput);
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
