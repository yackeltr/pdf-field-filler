import { describe, expect, it, beforeAll } from "vitest";
import { buildKitchenSinkPdf, buildEmptyPdf, FixturePaths } from "./helpers/buildFixture.js";
import { listPdfFields } from "../src/tools/list.js";
import { validatePdfFill } from "../src/tools/validate.js";
import { fillPdfFields } from "../src/tools/fill.js";
import {
  isHumanOnlyName,
  looksLikeDateField,
  looksLikeOrdinaryDataDate,
} from "../src/fields.js";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

let fx: FixturePaths;
let empty: FixturePaths;

beforeAll(async () => {
  fx = await buildKitchenSinkPdf();
  empty = await buildEmptyPdf();
  process.env.ALLOWED_DIRS = `${fx.dir},${empty.dir}`;
});

describe("isHumanOnlyName", () => {
  it("flags signature, initials, signing dates", () => {
    expect(isHumanOnlyName("Signature_Line", "text")).toBe(true);
    expect(isHumanOnlyName("Initials", "text")).toBe(true);
    expect(isHumanOnlyName("Date_Signed", "text")).toBe(true);
    expect(isHumanOnlyName("Signed_Date", "text")).toBe(true);
    expect(isHumanOnlyName("Execution_Date", "text")).toBe(true);
    expect(isHumanOnlyName("BeneficiarySignDate", "text")).toBe(true);
    expect(isHumanOnlyName("Attestation_Checkbox", "checkbox")).toBe(true);
  });
  it("does not flag ordinary data dates or 'certificate'", () => {
    expect(isHumanOnlyName("Date_Of_Birth", "text")).toBe(false);
    expect(isHumanOnlyName("Date_Of_Death", "text")).toBe(false);
    expect(isHumanOnlyName("Policy_Certificate_Number", "text")).toBe(false);
    expect(isHumanOnlyName("Designation", "text")).toBe(false);
    expect(isHumanOnlyName("Assignment", "text")).toBe(false);
  });
  it("always flags signature type", () => {
    expect(isHumanOnlyName("Anything", "signature")).toBe(true);
  });
});

describe("looksLikeDateField + ordinary data date", () => {
  it("date-like names are recognized", () => {
    expect(looksLikeDateField("Date_Of_Birth")).toBe(true);
    expect(looksLikeDateField("DOB")).toBe(true);
    expect(looksLikeDateField("AuthSignDate")).toBe(true);
    expect(looksLikeDateField("FirstName")).toBe(false);
  });
  it("ordinary data dates exclude signing dates", () => {
    expect(looksLikeOrdinaryDataDate("Date_Of_Birth")).toBe(true);
    expect(looksLikeOrdinaryDataDate("Date_Of_Death")).toBe(true);
    expect(looksLikeOrdinaryDataDate("Date_Signed")).toBe(false);
    expect(looksLikeOrdinaryDataDate("Signature_Date")).toBe(false);
  });
});

describe("listPdfFields", () => {
  it("returns has_fields=false for a fieldless PDF", async () => {
    const r = await listPdfFields({ pdf_path: empty.pdf });
    expect(r.has_fields).toBe(false);
    expect(r.field_count).toBe(0);
  });
  it("returns expected fields with correct types and human-only flags", async () => {
    const r = await listPdfFields({ pdf_path: fx.pdf });
    expect(r.has_fields).toBe(true);
    expect(r.field_count).toBeGreaterThanOrEqual(9);
    const byName = new Map((r.fields ?? []).map((f) => [f.name, f]));
    expect(byName.get("FirstName")?.type).toBe("text");
    expect(byName.get("AgreeToTerms")?.type).toBe("checkbox");
    expect(byName.get("ColorPick")?.type).toBe("radio");
    expect(byName.get("State")?.type).toBe("dropdown");
    expect(byName.get("ColorPick")?.options.length).toBe(3);
    expect(byName.get("State")?.options).toEqual(["CA", "NY", "TX"]);
    expect(byName.get("Signature_Line")?.is_human_only).toBe(true);
    expect(byName.get("Initials")?.is_human_only).toBe(true);
    expect(byName.get("Date_Signed")?.is_human_only).toBe(true);
    expect(byName.get("Date_Of_Birth")?.is_human_only).toBe(false);
    expect(byName.get("Policy_Certificate_Number")?.is_human_only).toBe(false);
  });
});

describe("validatePdfFill", () => {
  it("rejects unknown fields", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { Bogus: "x" },
    });
    expect(r.valid).toBe(false);
    expect(r.unknown_fields).toEqual(["Bogus"]);
  });
  it("flags signature, date, and changed-value as needs_review", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: {
        Signature_Line: "Jane Doe",
        Date_Of_Birth: "1990-01-01",
        FirstName: "John",
      },
    });
    const byName = new Map(r.review.map((x) => [x.field_name, x]));
    expect(byName.get("Signature_Line")?.needs_review).toBe(true);
    expect(byName.get("Date_Of_Birth")?.needs_review).toBe(true);
    expect(byName.get("FirstName")?.needs_review).toBe(true);
  });
  it("flags illegal dropdown values", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { State: "ZZ" },
    });
    expect(r.valid).toBe(false);
    expect(r.illegal_values.length).toBe(1);
    expect(r.illegal_values[0]?.legal_options).toEqual(["CA", "NY", "TX"]);
  });
});

describe("fillPdfFields", () => {
  it("dry_run returns diff without writing", async () => {
    const out = path.join(fx.dir, "out.pdf");
    const r = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Bob", State: "NY" },
      dry_run: true,
    });
    expect(r.dry_run).toBe(true);
    expect(existsSync(out)).toBe(false);
    expect(r.would_write?.length).toBe(2);
  });
  it("rejects human-only fields atomically", async () => {
    const out = path.join(fx.dir, "out_human.pdf");
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: out,
        field_values: { FirstName: "Bob", Signature_Line: "X" },
        dry_run: true,
      })
    ).rejects.toMatchObject({ code: "HUMAN_ONLY_FIELDS" });
    expect(existsSync(out)).toBe(false);
  });
  it("rejects unknown fields atomically", async () => {
    const out = path.join(fx.dir, "out_unknown.pdf");
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: out,
        field_values: { FirstName: "Bob", Nope: "X" },
        dry_run: true,
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_FIELDS" });
  });
  it("rejects identical input/output path", async () => {
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: fx.pdf,
        field_values: { FirstName: "Bob" },
        dry_run: true,
      })
    ).rejects.toMatchObject({ code: "OUTPUT_EQUALS_INPUT" });
  });
  it("skips null/undefined values without writing them", async () => {
    const out = path.join(fx.dir, "out_skip.pdf");
    const r = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: null, State: "TX" },
      dry_run: true,
    });
    expect(r.would_write?.length).toBe(1);
    expect(r.skipped.find((s) => s.field_name === "FirstName")).toBeTruthy();
  });
  it("actually writes a filled PDF and backs up existing output", async () => {
    const out = path.join(fx.dir, "out_real.pdf");
    const r1 = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Bob", State: "NY", AgreeToTerms: true },
      dry_run: false,
    });
    expect(r1.dry_run).toBe(false);
    expect(existsSync(out)).toBe(true);
    expect(r1.backup_path).toBeNull();

    const r2 = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Carol" },
      dry_run: false,
    });
    expect(r2.backup_path).toBeTruthy();
    expect(existsSync(r2.backup_path!)).toBe(true);

    const verifyDoc = await import("pdf-lib").then((m) =>
      m.PDFDocument.load(readFileSync(out))
    );
    const form = verifyDoc.getForm();
    expect(form.getTextField("FirstName").getText()).toBe("Carol");
  });
});

describe("path security", () => {
  it("rejects relative paths", async () => {
    await expect(
      listPdfFields({ pdf_path: "./relative.pdf" })
    ).rejects.toMatchObject({ code: "PATH_NOT_ABSOLUTE" });
  });
  it("rejects paths outside ALLOWED_DIRS", async () => {
    await expect(
      listPdfFields({ pdf_path: "/etc/passwd" })
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});
