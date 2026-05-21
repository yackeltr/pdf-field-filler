import { z } from "zod";
import { assertAllowedPath } from "../paths.js";
import { extractFields, looksLikeDateField, FieldInfo, FieldType } from "../fields.js";

export const ValidatePdfFillInput = z.object({
  pdf_path: z.string().min(1),
  field_values: z.record(z.unknown()),
});

export type ValidatePdfFillInputT = z.infer<typeof ValidatePdfFillInput>;

export interface IllegalValueEntry {
  field_name: string;
  proposed_value: unknown;
  reason: string;
  legal_options: string[];
}

export interface ReviewEntry {
  field_name: string;
  proposed_value: unknown;
  field_type: string;
  current_value: unknown;
  legal_options: string[];
  is_signature_field: boolean;
  is_human_only: boolean;
  is_required: boolean;
  needs_review: boolean;
  review_reason: string;
}

export interface ValidateResult {
  valid: boolean;
  unknown_fields: string[];
  illegal_values: IllegalValueEntry[];
  review: ReviewEntry[];
}

interface CheckOutcome {
  illegal?: { reason: string; legal_options: string[] };
  normalized: unknown;
}

function checkValueAgainstField(field: FieldInfo, proposed: unknown): CheckOutcome {
  const type = field.type;
  switch (type) {
    case "text": {
      if (typeof proposed === "string" || typeof proposed === "number") {
        return { normalized: String(proposed) };
      }
      if (proposed === null || proposed === undefined) {
        return { normalized: proposed };
      }
      return {
        illegal: { reason: "Text fields accept string or number.", legal_options: [] },
        normalized: proposed,
      };
    }
    case "checkbox": {
      if (typeof proposed === "boolean") return { normalized: proposed };
      if (proposed === null || proposed === undefined) return { normalized: proposed };
      if (typeof proposed === "string") {
        if (field.options.length === 0) return { normalized: proposed };
        if (field.options.includes(proposed)) return { normalized: proposed };
        return {
          illegal: {
            reason: `Checkbox value "${proposed}" is not a legal option.`,
            legal_options: field.options,
          },
          normalized: proposed,
        };
      }
      return {
        illegal: { reason: "Checkbox accepts boolean or a legal option string.", legal_options: field.options },
        normalized: proposed,
      };
    }
    case "radio": {
      if (proposed === null || proposed === undefined) return { normalized: proposed };
      if (typeof proposed === "string") {
        if (field.options.length === 0) {
          return {
            illegal: {
              reason: "Radio field has no detected options.",
              legal_options: [],
            },
            normalized: proposed,
          };
        }
        if (field.options.includes(proposed)) return { normalized: proposed };
        return {
          illegal: {
            reason: `Radio value "${proposed}" is not a legal option.`,
            legal_options: field.options,
          },
          normalized: proposed,
        };
      }
      return {
        illegal: { reason: "Radio accepts only a legal option string.", legal_options: field.options },
        normalized: proposed,
      };
    }
    case "dropdown":
    case "option_list": {
      if (proposed === null || proposed === undefined) return { normalized: proposed };
      const opts = field.options;
      if (Array.isArray(proposed)) {
        if (type !== "option_list") {
          return {
            illegal: { reason: "Dropdown accepts a single value.", legal_options: opts },
            normalized: proposed,
          };
        }
        if (opts.length === 0) return { normalized: proposed };
        const bad = proposed.find((p) => typeof p !== "string" || !opts.includes(p));
        if (bad !== undefined) {
          return {
            illegal: {
              reason: `Option list value "${String(bad)}" is not a legal option.`,
              legal_options: opts,
            },
            normalized: proposed,
          };
        }
        return { normalized: proposed };
      }
      if (typeof proposed === "string") {
        if (opts.length === 0) return { normalized: proposed };
        if (opts.includes(proposed)) return { normalized: proposed };
        return {
          illegal: {
            reason: `Value "${proposed}" is not a legal option.`,
            legal_options: opts,
          },
          normalized: proposed,
        };
      }
      return {
        illegal: {
          reason: `${type} accepts only a legal option string.`,
          legal_options: opts,
        },
        normalized: proposed,
      };
    }
    case "signature":
      return { normalized: proposed };
    case "button":
      return {
        illegal: { reason: "Pushbutton fields are not fillable.", legal_options: [] },
        normalized: proposed,
      };
    default:
      return { normalized: proposed };
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function isEmptyCurrent(v: unknown): boolean {
  return isEmptyValue(v) || v === false;
}

function looksLikeAttestationCheckbox(field: FieldInfo): boolean {
  if (field.type !== "checkbox") return false;
  const lower = field.name.toLowerCase();
  return /attest|certif/.test(lower);
}

export async function validatePdfFill(input: ValidatePdfFillInputT): Promise<ValidateResult> {
  const resolved = assertAllowedPath(input.pdf_path, { mustExist: true });
  const extraction = await extractFields(resolved);
  const byName = new Map<string, FieldInfo>();
  for (const f of extraction.fields) byName.set(f.name, f);

  const unknown_fields: string[] = [];
  const illegal_values: IllegalValueEntry[] = [];
  const review: ReviewEntry[] = [];

  for (const [key, proposed] of Object.entries(input.field_values)) {
    const field = byName.get(key);
    if (!field) {
      unknown_fields.push(key);
      continue;
    }
    const outcome = checkValueAgainstField(field, proposed);
    const reasons: string[] = [];
    let needs_review = false;

    if (outcome.illegal) {
      illegal_values.push({
        field_name: key,
        proposed_value: proposed,
        reason: outcome.illegal.reason,
        legal_options: outcome.illegal.legal_options,
      });
      reasons.push("illegal value");
      needs_review = true;
    }

    if (field.is_signature_field) {
      reasons.push("signature field");
      needs_review = true;
    }
    if (field.is_human_only) {
      reasons.push("human-only field");
      needs_review = true;
    }
    if (looksLikeAttestationCheckbox(field)) {
      reasons.push("attestation/certification checkbox");
      needs_review = true;
    }
    if (looksLikeDateField(field.name)) {
      reasons.push("date field — confirm format");
      needs_review = true;
    }
    if (isEmptyValue(proposed)) {
      reasons.push("empty value");
      needs_review = true;
    }
    if (
      !isEmptyCurrent(field.current_value) &&
      proposed !== field.current_value
    ) {
      reasons.push("differs from non-empty current value");
      needs_review = true;
    }

    review.push({
      field_name: key,
      proposed_value: proposed,
      field_type: field.type,
      current_value: field.current_value,
      legal_options: field.options,
      is_signature_field: field.is_signature_field,
      is_human_only: field.is_human_only,
      is_required: field.is_required,
      needs_review,
      review_reason: reasons.join("; "),
    });
  }

  return {
    valid: unknown_fields.length === 0 && illegal_values.length === 0,
    unknown_fields,
    illegal_values,
    review,
  };
}

export type { FieldInfo, FieldType };
