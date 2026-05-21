import { describe, expect, it, beforeAll, vi } from "vitest";
import {
  buildKitchenSinkPdf,
  buildEmptyPdf,
  buildInheritancePdf,
  buildXfaPdf,
  buildCheckboxRadioPdf,
  buildDropdownPairsPdf,
  buildReadOnlyPdf,
  buildMixedXfaPdf,
  buildHeterogeneousCheckboxPdf,
  buildCircularKidsPdf,
  buildMaxLenPdf,
  buildUnknownTypePdf,
  FixturePaths,
} from "./helpers/buildFixture.js";
import { listPdfFields } from "../src/tools/list.js";
import { validatePdfFill } from "../src/tools/validate.js";
import { fillPdfFields } from "../src/tools/fill.js";
import { exportPdfFieldMap } from "../src/tools/export.js";
import { createHash } from "node:crypto";
import {
  isHumanOnlyName,
  looksLikeDateField,
  looksLikeOrdinaryDataDate,
} from "../src/fields.js";
import path from "node:path";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

let fx: FixturePaths;
let empty: FixturePaths;
let inherit: FixturePaths;
let xfa: FixturePaths;
let btn: FixturePaths;
let ddPairs: FixturePaths;
let ro: FixturePaths;
let mixedXfa: FixturePaths;
let heteroCb: FixturePaths;
let cyclic: FixturePaths;
let maxLen: FixturePaths;
let unknownType: FixturePaths;

beforeAll(async () => {
  fx = await buildKitchenSinkPdf();
  empty = await buildEmptyPdf();
  inherit = await buildInheritancePdf();
  xfa = await buildXfaPdf();
  btn = await buildCheckboxRadioPdf();
  ddPairs = await buildDropdownPairsPdf();
  ro = await buildReadOnlyPdf();
  mixedXfa = await buildMixedXfaPdf();
  heteroCb = await buildHeterogeneousCheckboxPdf();
  cyclic = await buildCircularKidsPdf();
  maxLen = await buildMaxLenPdf();
  unknownType = await buildUnknownTypePdf();
  process.env.ALLOWED_DIRS = [
    fx.dir,
    empty.dir,
    inherit.dir,
    xfa.dir,
    btn.dir,
    ddPairs.dir,
    ro.dir,
    mixedXfa.dir,
    heteroCb.dir,
    cyclic.dir,
    maxLen.dir,
    unknownType.dir,
  ].join(",");
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

describe("AcroForm inheritance (leaf overrides parent)", () => {
  it("child inherits FT from parent", async () => {
    const r = await listPdfFields({ pdf_path: inherit.pdf });
    expect(r.has_fields).toBe(true);
    const f = r.fields?.find((x) => x.name === "Person.Last");
    expect(f).toBeTruthy();
    expect(f?.type).toBe("text");
  });
  it("child V overrides parent V", async () => {
    const r = await listPdfFields({ pdf_path: inherit.pdf });
    const f = r.fields?.find((x) => x.name === "Person.Last");
    expect(f?.current_value).toBe("child");
  });
  it("child Ff overrides parent Ff (read-only at parent → writable at child)", async () => {
    const r = await listPdfFields({ pdf_path: inherit.pdf });
    const f = r.fields?.find((x) => x.name === "Flags.Writable");
    expect(f).toBeTruthy();
    expect(f?.is_read_only).toBe(false);
  });
  it("child Opt overrides parent Opt", async () => {
    const r = await listPdfFields({ pdf_path: inherit.pdf });
    const f = r.fields?.find((x) => x.name === "Choices.Pick");
    expect(f).toBeTruthy();
    expect(f?.type).toBe("dropdown");
    expect(f?.options.sort()).toEqual(["X", "Y"]);
  });
});

describe("XFA detection", () => {
  it("flags has_xfa and returns no fields", async () => {
    const r = await listPdfFields({ pdf_path: xfa.pdf });
    expect(r.has_xfa).toBe(true);
    expect(r.xfa_supported).toBe(false);
    expect(r.has_fields).toBe(false);
    expect(typeof r.message).toBe("string");
  });
});

describe("checkbox/radio behavior", () => {
  it("checkbox with non-standard export value lists 'Yes' as option", async () => {
    const r = await listPdfFields({ pdf_path: btn.pdf });
    const f = r.fields?.find((x) => x.name === "AgreeYes");
    expect(f?.type).toBe("checkbox");
    expect(f?.options).toEqual(["Yes"]);
  });
  it("unchecked checkbox current_value is false", async () => {
    const r = await listPdfFields({ pdf_path: btn.pdf });
    const f = r.fields?.find((x) => x.name === "AgreeYes");
    expect(f?.current_value).toBe(false);
  });
  it("radio group exposes all 3 export values and reports selected current_value", async () => {
    const r = await listPdfFields({ pdf_path: btn.pdf });
    const f = r.fields?.find((x) => x.name === "Relationship");
    expect(f?.type).toBe("radio");
    expect(f?.options.sort()).toEqual(["Child", "Other", "Spouse"]);
    expect(f?.current_value).toBe("Child");
    expect(f?.widgets.length).toBe(3);
  });
  it("validate rejects an illegal radio option", async () => {
    const r = await validatePdfFill({
      pdf_path: btn.pdf,
      field_values: { Relationship: "Sibling" },
    });
    expect(r.valid).toBe(false);
    expect(r.illegal_values.length).toBe(1);
    expect(r.illegal_values[0]?.legal_options.sort()).toEqual(["Child", "Other", "Spouse"]);
  });
});

describe("dropdown /Opt pairs", () => {
  it("lists export values from [export, display] pairs", async () => {
    const r = await listPdfFields({ pdf_path: ddPairs.pdf });
    const f = r.fields?.find((x) => x.name === "Country");
    expect(f?.type).toBe("dropdown");
    expect(f?.options).toEqual(["US", "CA", "MX"]);
  });
  it("validate accepts an export value", async () => {
    const r = await validatePdfFill({
      pdf_path: ddPairs.pdf,
      field_values: { Country: "CA" },
    });
    expect(r.valid).toBe(true);
  });
  it("validate rejects a display value", async () => {
    const r = await validatePdfFill({
      pdf_path: ddPairs.pdf,
      field_values: { Country: "Canada" },
    });
    expect(r.valid).toBe(false);
    expect(r.illegal_values[0]?.legal_options).toEqual(["US", "CA", "MX"]);
  });
});

describe("PDF identity metadata", () => {
  it("list response includes sha256/size/mtime", async () => {
    const r = await listPdfFields({ pdf_path: fx.pdf });
    expect(r.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.pdf_size_bytes).toBeGreaterThan(0);
    expect(typeof r.pdf_mtime).toBe("string");
  });
  it("validate response includes identity", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { FirstName: "Tom" },
    });
    expect(r.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("fill dry-run includes identity", async () => {
    const out = path.join(fx.dir, "id-out.pdf");
    const r = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Tom" },
      dry_run: true,
    });
    expect(r.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("fill rejects on PDF_IDENTITY_MISMATCH", async () => {
    const out = path.join(fx.dir, "mm-out.pdf");
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: out,
        field_values: { FirstName: "Tom" },
        dry_run: true,
        expected_pdf_sha256: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "PDF_IDENTITY_MISMATCH" });
  });
  it("fill proceeds when expected_pdf_sha256 matches", async () => {
    const bytes = readFileSync(fx.pdf);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const out = path.join(fx.dir, "mm-ok.pdf");
    const r = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Tom" },
      dry_run: true,
      expected_pdf_sha256: sha,
    });
    expect(r.dry_run).toBe(true);
  });
});

describe("export_pdf_field_map", () => {
  it("writes a JSON map with identity and field list", async () => {
    const out = path.join(fx.dir, "map.json");
    const r = await exportPdfFieldMap({
      pdf_path: fx.pdf,
      output_json_path: out,
      overwrite: false,
    });
    expect(existsSync(out)).toBe(true);
    expect(r.field_count).toBeGreaterThan(0);
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    expect(parsed.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.server_version).toBeTruthy();
    expect(Array.isArray(parsed.fields)).toBe(true);
  });
  it("refuses to overwrite without overwrite=true", async () => {
    const out = path.join(fx.dir, "map2.json");
    await exportPdfFieldMap({ pdf_path: fx.pdf, output_json_path: out, overwrite: false });
    await expect(
      exportPdfFieldMap({ pdf_path: fx.pdf, output_json_path: out, overwrite: false })
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  });
  it("overwrites when overwrite=true", async () => {
    const out = path.join(fx.dir, "map3.json");
    await exportPdfFieldMap({ pdf_path: fx.pdf, output_json_path: out, overwrite: false });
    const r = await exportPdfFieldMap({ pdf_path: fx.pdf, output_json_path: out, overwrite: true });
    expect(r.output_json_path.endsWith("map3.json")).toBe(true);
    expect(existsSync(r.output_json_path)).toBe(true);
  });
  it("rejects output outside ALLOWED_DIRS", async () => {
    await expect(
      exportPdfFieldMap({
        pdf_path: fx.pdf,
        output_json_path: "/etc/pdf-field-filler.json",
        overwrite: true,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});

describe("atomic fill", () => {
  it("input PDF is never modified by fill", async () => {
    const before = createHash("sha256").update(readFileSync(fx.pdf)).digest("hex");
    const out = path.join(fx.dir, "atomic-out.pdf");
    await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Atomic" },
      dry_run: false,
    });
    const after = createHash("sha256").update(readFileSync(fx.pdf)).digest("hex");
    expect(after).toBe(before);
  });
  it("no temp file remains after a successful fill", async () => {
    const out = path.join(fx.dir, "atomic-clean.pdf");
    await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Clean" },
      dry_run: false,
    });
    const fs = await import("node:fs");
    const dirEntries = fs.readdirSync(fx.dir);
    expect(dirEntries.some((n) => n.includes(".tmp."))).toBe(false);
  });
});

describe("encryption (deterministic)", () => {
  it("does not throw PDF_ENCRYPTED on a normal unencrypted PDF", async () => {
    const r = await listPdfFields({ pdf_path: fx.pdf });
    expect(r.has_fields).toBe(true);
  });
});

describe("checkbox export-value fidelity (#2)", () => {
  it("writes the exact /AP/N export name when a string is supplied", async () => {
    const out = path.join(btn.dir, "cbfid.pdf");
    await fillPdfFields({
      pdf_path: btn.pdf,
      output_path: out,
      field_values: { AgreeYes: "Yes" },
      dry_run: false,
    });
    // Re-read and confirm the round-trip preserved "Yes"
    const r = await listPdfFields({ pdf_path: out });
    const f = r.fields?.find((x) => x.name === "AgreeYes");
    expect(f?.current_value).toBe("Yes");
  });
  it("writes the exact /AP/N export name when boolean true is supplied", async () => {
    const out = path.join(btn.dir, "cbfid2.pdf");
    await fillPdfFields({
      pdf_path: btn.pdf,
      output_path: out,
      field_values: { AgreeYes: true },
      dry_run: false,
    });
    const r = await listPdfFields({ pdf_path: out });
    const f = r.fields?.find((x) => x.name === "AgreeYes");
    expect(f?.current_value).toBe("Yes");
  });
  it("radio selection writes the exact export name from /AP/N", async () => {
    const out = path.join(btn.dir, "radfid.pdf");
    await fillPdfFields({
      pdf_path: btn.pdf,
      output_path: out,
      field_values: { Relationship: "Spouse" },
      dry_run: false,
    });
    const r = await listPdfFields({ pdf_path: out });
    const f = r.fields?.find((x) => x.name === "Relationship");
    expect(f?.current_value).toBe("Spouse");
  });
});

describe("identity invariants (#4)", () => {
  // Note: the "single-buffer" property of fill — that identity, extract, and
  // load all derive from one in-memory read — is a structural invariant of
  // fill.ts and cannot be observed from a black-box test. The fill function
  // reads the path at call time; there is no cross-call cache to race against.
  // The invariant is enforced by code review (no path-based read after the
  // initial readPdfWithIdentity call). The runtime tests below cover the
  // observable behaviors that downstream callers actually rely on.

  it("stale expected_pdf_sha256 against an on-disk-mutated file rejects with PDF_IDENTITY_MISMATCH", async () => {
    // This pins the explicit-hash *rejection* path, not the single-buffer
    // refactor. It documents that callers passing a stale hash get rejected
    // cleanly rather than silently filling against changed bytes.
    const fs = await import("node:fs");
    const dir = mkdtempSyncWrap();
    process.env.ALLOWED_DIRS = `${process.env.ALLOWED_DIRS ?? ""},${dir}`;
    const inputPath = path.join(dir, "swap.pdf");
    fs.copyFileSync(fx.pdf, inputPath);
    const originalSha = createHash("sha256")
      .update(fs.readFileSync(inputPath))
      .digest("hex");
    fs.copyFileSync(empty.pdf, inputPath);
    const out = path.join(dir, "swap-out.pdf");
    await expect(
      fillPdfFields({
        pdf_path: inputPath,
        output_path: out,
        field_values: { FirstName: "X" },
        dry_run: false,
        expected_pdf_sha256: originalSha,
      })
    ).rejects.toMatchObject({ code: "PDF_IDENTITY_MISMATCH" });
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("radio re-selection clears stale /AS (#2 follow-up)", () => {
  it("after switching the radio from Child to Spouse, only the Spouse widget shows non-Off /AS", async () => {
    const fs = await import("node:fs");
    const out1 = path.join(btn.dir, "radio-step1.pdf");
    await fillPdfFields({
      pdf_path: btn.pdf,
      output_path: out1,
      field_values: { Relationship: "Child" },
      dry_run: false,
    });
    const out2 = path.join(btn.dir, "radio-step2.pdf");
    await fillPdfFields({
      pdf_path: out1,
      output_path: out2,
      field_values: { Relationship: "Spouse" },
      dry_run: false,
    });

    // Inspect /AS on every widget under the Relationship field directly.
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(out2));
    const af = doc.catalog.lookup(PDFName.of("AcroForm")) as InstanceType<typeof PDFDict>;
    const fields = af.lookup(PDFName.of("Fields")) as InstanceType<typeof PDFArray>;
    let field: InstanceType<typeof PDFDict> | null = null;
    for (let i = 0; i < fields.size(); i++) {
      const d = fields.lookup(i) as InstanceType<typeof PDFDict>;
      const t = d.lookup(PDFName.of("T")) as any;
      if (t && t.decodeText && t.decodeText() === "Relationship") {
        field = d;
        break;
      }
    }
    expect(field).toBeTruthy();
    const kids = field!.lookup(PDFName.of("Kids")) as InstanceType<typeof PDFArray>;
    const asStates: string[] = [];
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.lookup(i) as InstanceType<typeof PDFDict>;
      const as = k.get(PDFName.of("AS")) as any;
      asStates.push(as?.decodeText ? as.decodeText() : String(as));
    }
    // Exactly one widget should be on, with name "Spouse"; the rest "Off".
    const nonOff = asStates.filter((s) => s !== "Off");
    expect(nonOff).toEqual(["Spouse"]);
    expect(asStates.filter((s) => s === "Off").length).toBe(2);
    // And the field's /V should agree.
    const v = field!.get(PDFName.of("V")) as any;
    expect(v?.decodeText ? v.decodeText() : String(v)).toBe("Spouse");
  });
});

describe("backup-ordering (#8)", () => {
  it("a pre-existing output stays in place if temp write fails", async () => {
    const fs = await import("node:fs");
    const out = path.join(fx.dir, "preexisting.pdf");
    fs.writeFileSync(out, "ORIGINAL");
    // Force the temp write to fail by making the output directory read-only.
    // We can't easily simulate this cross-platform without root, so instead
    // we trigger a failure path: pass an invalid pdf and assert original
    // pre-existing output is still readable afterward (it should be — we
    // never even get to the rename step).
    const beforeBytes = fs.readFileSync(out);
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: out,
        field_values: { Nope: "x" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_FIELDS" });
    const afterBytes = fs.readFileSync(out);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });
  it("after successful fill, original output is preserved as backup", async () => {
    const fs = await import("node:fs");
    const out = path.join(fx.dir, "rotate.pdf");
    fs.writeFileSync(out, "ORIGINAL");
    const r = await fillPdfFields({
      pdf_path: fx.pdf,
      output_path: out,
      field_values: { FirstName: "Rotated" },
      dry_run: false,
    });
    expect(r.backup_path).toBeTruthy();
    expect(fs.readFileSync(r.backup_path!).toString()).toBe("ORIGINAL");
  });
});

describe("symlink containment (#5/#6)", () => {
  it("rejects output_path that exists as a symlink pointing outside ALLOWED_DIRS", async () => {
    const fs = await import("node:fs");
    const outsideDir = mkdtempSyncWrap();
    const outsideTarget = path.join(outsideDir, "outside.pdf");
    fs.writeFileSync(outsideTarget, "EXTERNAL");
    const linkPath = path.join(fx.dir, "escape.pdf");
    try {
      fs.symlinkSync(outsideTarget, linkPath);
    } catch {
      // skip if symlinks unavailable in env
      return;
    }
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: linkPath,
        field_values: { FirstName: "X" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    // External target untouched
    expect(fs.readFileSync(outsideTarget).toString()).toBe("EXTERNAL");
  });
  it("rejects output_path that is a symlink to the input", async () => {
    const fs = await import("node:fs");
    const linkPath = path.join(fx.dir, "loopback.pdf");
    try {
      fs.symlinkSync(fx.pdf, linkPath);
    } catch {
      return;
    }
    await expect(
      fillPdfFields({
        pdf_path: fx.pdf,
        output_path: linkPath,
        field_values: { FirstName: "X" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "OUTPUT_EQUALS_INPUT" });
  });
});

// ESM-clean replacement for an earlier require()-based helper. Used by tests
// that need a directory OUTSIDE the fixture's ALLOWED_DIRS (e.g. the symlink
// containment test that resolves through to an external target).
function mkdtempSyncWrap(): string {
  return mkdtempSync(path.join(tmpdir(), "pdffieldfiller-outside-"));
}

describe("date subclassification (#3)", () => {
  it("ordinary data date gets a 'data date' review reason", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { Date_Of_Birth: "1990-01-01" },
    });
    const row = r.review.find((x) => x.field_name === "Date_Of_Birth");
    expect(row?.needs_review).toBe(true);
    expect(row?.review_reason).toMatch(/data date/);
  });
});

describe("looksLikeDateField false-positive (#13)", () => {
  it("does not flag fields like 'Last_Updated'", async () => {
    const { looksLikeDateField } = await import("../src/fields.js");
    expect(looksLikeDateField("Last_Updated")).toBe(false);
    expect(looksLikeDateField("Updated")).toBe(false);
    expect(looksLikeDateField("UpdateDate")).toBe(true);
  });
});

describe("read-only blocking (#2)", () => {
  it("list_pdf_fields marks read-only field correctly", async () => {
    const r = await listPdfFields({ pdf_path: ro.pdf });
    const f = r.fields?.find((x) => x.name === "Locked");
    expect(f?.is_read_only).toBe(true);
  });
  it("fill_pdf_fields rejects atomically when any read-only field is supplied", async () => {
    const out = path.join(ro.dir, "ro-blocked.pdf");
    await expect(
      fillPdfFields({
        pdf_path: ro.pdf,
        output_path: out,
        field_values: { Editable: "ok", Locked: "nope" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "READ_ONLY_FIELDS" });
    const fs = await import("node:fs");
    expect(fs.existsSync(out)).toBe(false);
  });
  it("dry_run also rejects read-only fields", async () => {
    const out = path.join(ro.dir, "ro-dry.pdf");
    await expect(
      fillPdfFields({
        pdf_path: ro.pdf,
        output_path: out,
        field_values: { Locked: "x" },
        dry_run: true,
      })
    ).rejects.toMatchObject({ code: "READ_ONLY_FIELDS" });
  });
  it("validate_pdf_fill marks read-only with needs_review and is_read_only", async () => {
    const r = await validatePdfFill({
      pdf_path: ro.pdf,
      field_values: { Locked: "x" },
    });
    const row = r.review.find((x) => x.field_name === "Locked");
    expect(row?.is_read_only).toBe(true);
    expect(row?.needs_review).toBe(true);
    expect(row?.review_reason).toMatch(/read-only/);
  });
});

describe("safe_to_fill (#3)", () => {
  it("ordinary data date: valid=true, safe_to_fill=true, needs_review=true", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { Date_Of_Birth: "1990-01-01" },
    });
    expect(r.valid).toBe(true);
    expect(r.safe_to_fill).toBe(true);
    expect(r.review[0]?.needs_review).toBe(true);
  });
  it("signature field: safe_to_fill=false", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { Signature_Line: "Jane" },
    });
    expect(r.safe_to_fill).toBe(false);
  });
  it("read-only field: safe_to_fill=false", async () => {
    const r = await validatePdfFill({
      pdf_path: ro.pdf,
      field_values: { Locked: "x" },
    });
    expect(r.safe_to_fill).toBe(false);
  });
  it("signing date: safe_to_fill=false", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { Date_Signed: "2026-01-01" },
    });
    expect(r.safe_to_fill).toBe(false);
  });
  it("unknown field: valid=false, safe_to_fill=false", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { Bogus: "x" },
    });
    expect(r.valid).toBe(false);
    expect(r.safe_to_fill).toBe(false);
  });
  it("illegal radio option: valid=false, safe_to_fill=false", async () => {
    const r = await validatePdfFill({
      pdf_path: btn.pdf,
      field_values: { Relationship: "Sibling" },
    });
    expect(r.valid).toBe(false);
    expect(r.safe_to_fill).toBe(false);
  });
  it("mix of fillable and blocked: safe_to_fill=false", async () => {
    const r = await validatePdfFill({
      pdf_path: fx.pdf,
      field_values: { FirstName: "Ok", Signature_Line: "X" },
    });
    expect(r.valid).toBe(true);
    expect(r.safe_to_fill).toBe(false);
  });
});

describe("explicit per-widget /AS (#1)", () => {
  it("checkbox: only the matching widget has AS=export, all others (none in this fixture) implicitly Off", async () => {
    const out = path.join(btn.dir, "as-cb.pdf");
    await fillPdfFields({
      pdf_path: btn.pdf,
      output_path: out,
      field_values: { AgreeYes: true },
      dry_run: false,
    });
    const fs = await import("node:fs");
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(out));
    const af = doc.catalog.lookup(PDFName.of("AcroForm")) as InstanceType<typeof PDFDict>;
    const fields = af.lookup(PDFName.of("Fields")) as InstanceType<typeof PDFArray>;
    let cb: InstanceType<typeof PDFDict> | null = null;
    for (let i = 0; i < fields.size(); i++) {
      const d = fields.lookup(i) as InstanceType<typeof PDFDict>;
      const t = d.lookup(PDFName.of("T")) as any;
      if (t?.decodeText && t.decodeText() === "AgreeYes") {
        cb = d;
        break;
      }
    }
    expect(cb).toBeTruthy();
    const as = cb!.get(PDFName.of("AS")) as any;
    expect(as?.decodeText?.()).toBe("Yes");
  });
  it("radio after re-selection: exactly one widget AS=selected, others AS=Off (regression pin)", async () => {
    const out1 = path.join(btn.dir, "as-r1.pdf");
    await fillPdfFields({
      pdf_path: btn.pdf,
      output_path: out1,
      field_values: { Relationship: "Other" },
      dry_run: false,
    });
    const out2 = path.join(btn.dir, "as-r2.pdf");
    await fillPdfFields({
      pdf_path: out1,
      output_path: out2,
      field_values: { Relationship: "Child" },
      dry_run: false,
    });
    const fs = await import("node:fs");
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(out2));
    const af = doc.catalog.lookup(PDFName.of("AcroForm")) as InstanceType<typeof PDFDict>;
    const fields = af.lookup(PDFName.of("Fields")) as InstanceType<typeof PDFArray>;
    let rg: InstanceType<typeof PDFDict> | null = null;
    for (let i = 0; i < fields.size(); i++) {
      const d = fields.lookup(i) as InstanceType<typeof PDFDict>;
      const t = d.lookup(PDFName.of("T")) as any;
      if (t?.decodeText && t.decodeText() === "Relationship") {
        rg = d;
        break;
      }
    }
    expect(rg).toBeTruthy();
    const kids = rg!.lookup(PDFName.of("Kids")) as InstanceType<typeof PDFArray>;
    const asStates: string[] = [];
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.lookup(i) as InstanceType<typeof PDFDict>;
      const as = k.get(PDFName.of("AS")) as any;
      asStates.push(as?.decodeText ? as.decodeText() : String(as));
    }
    expect(asStates.filter((s) => s !== "Off")).toEqual(["Child"]);
    expect(asStates.filter((s) => s === "Off").length).toBe(2);
    const v = rg!.get(PDFName.of("V")) as any;
    expect(v?.decodeText?.()).toBe("Child");
  });
});

describe("heterogeneous checkbox widgets per-widget AS (#1 follow-up)", () => {
  async function widgetAsStates(pdfPath: string, fieldName: string): Promise<string[]> {
    const fs = await import("node:fs");
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
    const af = doc.catalog.lookup(PDFName.of("AcroForm")) as InstanceType<typeof PDFDict>;
    const fields = af.lookup(PDFName.of("Fields")) as InstanceType<typeof PDFArray>;
    let field: InstanceType<typeof PDFDict> | null = null;
    for (let i = 0; i < fields.size(); i++) {
      const d = fields.lookup(i) as InstanceType<typeof PDFDict>;
      const t = d.lookup(PDFName.of("T")) as any;
      if (t?.decodeText && t.decodeText() === fieldName) {
        field = d;
        break;
      }
    }
    if (!field) throw new Error(`field ${fieldName} not found`);
    const kids = field.lookup(PDFName.of("Kids")) as InstanceType<typeof PDFArray>;
    const out: string[] = [];
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.lookup(i) as InstanceType<typeof PDFDict>;
      const as = k.get(PDFName.of("AS")) as any;
      out.push(as?.decodeText ? as.decodeText() : String(as));
    }
    return out;
  }
  it("lists both export names from the heterogeneous widgets", async () => {
    const r = await listPdfFields({ pdf_path: heteroCb.pdf });
    const f = r.fields?.find((x) => x.name === "MultiCheck");
    expect(f).toBeTruthy();
    expect(f?.options.sort()).toEqual(["OptionA", "OptionB"]);
  });
  it("selecting OptionA sets only widget-A's AS=OptionA, widget-B's AS=Off", async () => {
    const out = path.join(heteroCb.dir, "hetA.pdf");
    await fillPdfFields({
      pdf_path: heteroCb.pdf,
      output_path: out,
      field_values: { MultiCheck: "OptionA" },
      dry_run: false,
    });
    const states = await widgetAsStates(out, "MultiCheck");
    expect(states.sort()).toEqual(["Off", "OptionA"]);
  });
  it("selecting OptionB sets only widget-B's AS=OptionB, widget-A's AS=Off", async () => {
    const out = path.join(heteroCb.dir, "hetB.pdf");
    await fillPdfFields({
      pdf_path: heteroCb.pdf,
      output_path: out,
      field_values: { MultiCheck: "OptionB" },
      dry_run: false,
    });
    const states = await widgetAsStates(out, "MultiCheck");
    expect(states.sort()).toEqual(["Off", "OptionB"]);
  });
  it("uncheck sets every widget's AS=Off regardless of its own export", async () => {
    const out = path.join(heteroCb.dir, "hetOff.pdf");
    await fillPdfFields({
      pdf_path: heteroCb.pdf,
      output_path: out,
      field_values: { MultiCheck: false },
      dry_run: false,
    });
    const states = await widgetAsStates(out, "MultiCheck");
    expect(states).toEqual(["Off", "Off"]);
  });
});

describe("heterogeneous checkbox per-widget appearance (rendering guarantee)", () => {
  // The data-vs-rendering split: /V on the field tells callers what is
  // logically selected, but a spec-honoring viewer renders, for each widget,
  // /AP/N/<that widget's own /AS>. So the guarantee we need to pin is per
  // widget: the selected widget's /AS must be a key present in *that same
  // widget's* /AP/N. The previous tests asserted "some widget has AS=X and
  // some /AP/N somewhere contains X" via array sorts, which would still pass
  // if the bookkeeping was crossed. This pairs them directly.
  async function widgetPairs(pdfPath: string, fieldName: string): Promise<
    Array<{ as: string; apN_keys: string[]; ap_n_target_present: boolean; ap_n_target_nonnull: boolean }>
  > {
    const fs = await import("node:fs");
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
    const af = doc.catalog.lookup(PDFName.of("AcroForm")) as InstanceType<typeof PDFDict>;
    const fields = af.lookup(PDFName.of("Fields")) as InstanceType<typeof PDFArray>;
    let field: InstanceType<typeof PDFDict> | null = null;
    for (let i = 0; i < fields.size(); i++) {
      const d = fields.lookup(i) as InstanceType<typeof PDFDict>;
      const t = d.lookup(PDFName.of("T")) as any;
      if (t?.decodeText && t.decodeText() === fieldName) {
        field = d;
        break;
      }
    }
    if (!field) throw new Error(`field ${fieldName} not found`);
    const kids = field.lookup(PDFName.of("Kids")) as InstanceType<typeof PDFArray>;
    const out: Array<{
      as: string;
      apN_keys: string[];
      ap_n_target_present: boolean;
      ap_n_target_nonnull: boolean;
    }> = [];
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.lookup(i) as InstanceType<typeof PDFDict>;
      const asObj = k.get(PDFName.of("AS")) as any;
      const asName = asObj?.decodeText ? asObj.decodeText() : String(asObj);
      const ap = k.lookup(PDFName.of("AP")) as InstanceType<typeof PDFDict> | null;
      const n =
        ap instanceof PDFDict
          ? (ap.lookup(PDFName.of("N")) as InstanceType<typeof PDFDict> | null)
          : null;
      const keys: string[] = [];
      let target_present = false;
      let target_nonnull = false;
      if (n instanceof PDFDict) {
        for (const key of n.keys()) {
          keys.push(key.decodeText());
        }
        target_present = keys.includes(asName);
        if (target_present) {
          const entry = n.lookup(PDFName.of(asName));
          target_nonnull = entry !== undefined && entry !== null;
        }
      }
      out.push({
        as: asName,
        apN_keys: keys,
        ap_n_target_present: target_present,
        ap_n_target_nonnull: target_nonnull,
      });
    }
    return out;
  }

  async function fieldV(pdfPath: string, fieldName: string): Promise<string | null> {
    const fs = await import("node:fs");
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
    const af = doc.catalog.lookup(PDFName.of("AcroForm")) as InstanceType<typeof PDFDict>;
    const fields = af.lookup(PDFName.of("Fields")) as InstanceType<typeof PDFArray>;
    for (let i = 0; i < fields.size(); i++) {
      const d = fields.lookup(i) as InstanceType<typeof PDFDict>;
      const t = d.lookup(PDFName.of("T")) as any;
      if (t?.decodeText && t.decodeText() === fieldName) {
        const v = d.get(PDFName.of("V")) as any;
        return v?.decodeText ? v.decodeText() : null;
      }
    }
    return null;
  }

  it("filling MultiCheck = OptionB: the OptionB-bearing widget renders OptionB; the OptionA widget renders Off", async () => {
    const out = path.join(heteroCb.dir, "hetB-render.pdf");
    await fillPdfFields({
      pdf_path: heteroCb.pdf,
      output_path: out,
      field_values: { MultiCheck: "OptionB" },
      dry_run: false,
    });
    const pairs = await widgetPairs(out, "MultiCheck");
    expect(pairs.length).toBe(2);

    // Identify each widget by its OWN /AP/N on-key, never by its /AS.
    // The OptionB widget is *defined* as the widget whose /AP/N contains the
    // "OptionB" appearance stream — that identification holds regardless of
    // what /AS is, so the subsequent /AS assertion is real, not tautological.
    // A bug that set the wrong widget's /AS would leave widget-B identified
    // here but widget-B.as still "Off" — the assertion would fail.
    const widgetB = pairs.find((p) => p.apN_keys.includes("OptionB"))!;
    const widgetA = pairs.find((p) => p.apN_keys.includes("OptionA"))!;
    // Load-bearing: did applyBtnExport set the right widget's /AS?
    expect(widgetB.as).toBe("OptionB");
    expect(widgetA.as).toBe("Off");
    // Rendering contract: each widget's /AS must resolve to a real entry in
    // *its own* /AP/N. Without this, viewers see a dangling appearance.
    expect(widgetB.ap_n_target_present).toBe(true);
    expect(widgetB.ap_n_target_nonnull).toBe(true);
    expect(widgetA.ap_n_target_present).toBe(true);
    expect(widgetA.ap_n_target_nonnull).toBe(true);
    // P0 verification: the field-level /V we wrote directly (bypassing
    // PDFAcroCheckBox.setValue) must survive doc.save({ updateFieldAppearances: true }).
    // pdf-lib's appearance-regen pass could plausibly normalize a checkbox /V
    // to its own notion of the "on" state and clobber our direct write. If it
    // did, this assertion would fail and viewers would see /V === "Yes" (or
    // similar) instead of the per-widget export we asked for.
    expect(await fieldV(out, "MultiCheck")).toBe("OptionB");
  });

  it("filling MultiCheck = OptionA: symmetric — OptionA widget renders OptionA, OptionB widget renders Off", async () => {
    const out = path.join(heteroCb.dir, "hetA-render.pdf");
    await fillPdfFields({
      pdf_path: heteroCb.pdf,
      output_path: out,
      field_values: { MultiCheck: "OptionA" },
      dry_run: false,
    });
    const pairs = await widgetPairs(out, "MultiCheck");
    const widgetA = pairs.find((p) => p.apN_keys.includes("OptionA"))!;
    const widgetB = pairs.find((p) => p.apN_keys.includes("OptionB"))!;
    expect(widgetA.as).toBe("OptionA");
    expect(widgetB.as).toBe("Off");
    expect(widgetA.ap_n_target_present).toBe(true);
    expect(widgetA.ap_n_target_nonnull).toBe(true);
    expect(widgetB.ap_n_target_present).toBe(true);
    expect(widgetB.ap_n_target_nonnull).toBe(true);
  });

  it("uncheck: both widgets render Off, and Off is in each widget's own /AP/N", async () => {
    const out = path.join(heteroCb.dir, "hetOff-render.pdf");
    await fillPdfFields({
      pdf_path: heteroCb.pdf,
      output_path: out,
      field_values: { MultiCheck: false },
      dry_run: false,
    });
    const pairs = await widgetPairs(out, "MultiCheck");
    for (const p of pairs) {
      expect(p.as).toBe("Off");
      expect(p.apN_keys).toContain("Off");
      expect(p.ap_n_target_present).toBe(true);
      expect(p.ap_n_target_nonnull).toBe(true);
    }
  });
});

describe("mixed XFA + AcroForm (#6)", () => {
  it("lists AcroForm fields and flags has_xfa with a warning", async () => {
    const r = await listPdfFields({ pdf_path: mixedXfa.pdf });
    expect(r.has_xfa).toBe(true);
    expect(r.xfa_supported).toBe(false);
    expect(r.has_fields).toBe(true);
    expect(r.fields?.some((f) => f.name === "Name")).toBe(true);
    expect(typeof r.message).toBe("string");
  });
});

describe("walkFields cycle guard (P0-1)", () => {
  it("does not stack-overflow on a circular Kids tree", async () => {
    // Fixture: A.Kids = [B], B.Kids = [A]. Without a guard, walkFields would
    // recurse until the JS stack is exhausted (RangeError). The point of
    // this test is that the call *returns* — not that any particular field
    // is emitted (the cycle structure happens to have no leaf to emit).
    const r = await listPdfFields({ pdf_path: cyclic.pdf });
    expect(typeof r.field_count).toBe("number");
    expect(r.field_count).toBeLessThanOrEqual(2);
  });
});

describe("file-size guard (P0-2)", () => {
  it("rejects a file larger than PDF_FIELD_FILLER_MAX_BYTES with PDF_TOO_LARGE", async () => {
    const prev = process.env.PDF_FIELD_FILLER_MAX_BYTES;
    process.env.PDF_FIELD_FILLER_MAX_BYTES = "100"; // 100 bytes — every fixture exceeds this
    try {
      await expect(listPdfFields({ pdf_path: fx.pdf })).rejects.toMatchObject({
        code: "PDF_TOO_LARGE",
      });
    } finally {
      if (prev === undefined) delete process.env.PDF_FIELD_FILLER_MAX_BYTES;
      else process.env.PDF_FIELD_FILLER_MAX_BYTES = prev;
    }
  });
});

describe("MaxLen enforcement (P1-2)", () => {
  it("validate flags an over-MaxLen text value as illegal (not safe_to_fill)", async () => {
    const r = await validatePdfFill({
      pdf_path: maxLen.pdf,
      field_values: { Short: "ABCDEFGH" },
    });
    expect(r.valid).toBe(false);
    expect(r.safe_to_fill).toBe(false);
    expect(r.illegal_values[0]?.reason).toMatch(/MaxLen/);
  });
  it("fill rejects ILLEGAL_VALUES when a text value exceeds MaxLen", async () => {
    const out = path.join(maxLen.dir, "ml-out.pdf");
    await expect(
      fillPdfFields({
        pdf_path: maxLen.pdf,
        output_path: out,
        field_values: { Short: "ABCDEFGH" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "ILLEGAL_VALUES" });
    const fs = await import("node:fs");
    expect(fs.existsSync(out)).toBe(false);
  });
  it("fill accepts a value at exactly MaxLen", async () => {
    const out = path.join(maxLen.dir, "ml-ok.pdf");
    const r = await fillPdfFields({
      pdf_path: maxLen.pdf,
      output_path: out,
      field_values: { Short: "ABCDE" },
      dry_run: false,
    });
    expect(r.dry_run).toBe(false);
  });
});

describe("toErrorPayload: ZodError → INVALID_INPUT (P1-1)", () => {
  it("classifies a ZodError as INVALID_INPUT, not PDF_PARSE_ERROR", async () => {
    const { toErrorPayload } = await import("../src/errors.js");
    const { z } = await import("zod");
    let zerr: unknown;
    try {
      z.object({ pdf_path: z.string() }).parse({ pdf_path: 42 });
    } catch (e) {
      zerr = e;
    }
    const payload = toErrorPayload(zerr);
    expect(payload.error_code).toBe("INVALID_INPUT");
  });
});

describe("auto-rollback on publish-rename failure (P2 follow-up)", () => {
  // The earlier backup-ordering test fires UNKNOWN_FIELDS before any write
  // touches the filesystem, so it doesn't actually exercise the rollback
  // code. These tests inject a renameSync that fails at the *publish* phase
  // (call #2: temp -> output) AFTER the backup-rename has already moved the
  // pre-existing output to backup_path. Under a working rollback, the
  // backup is renamed back and the WRITE_FAILED payload reports
  // rollback_attempted / rollback_succeeded. The fill.ts module exposes
  // __setRenameImplForTests precisely so this branch can be exercised —
  // vi.spyOn on ESM exports of node:fs is not configurable.
  let __setRenameImplForTests: (fn: ((from: any, to: any) => void) | null) => void;
  beforeAll(async () => {
    ({ __setRenameImplForTests } = await import("../src/tools/fill.js"));
  });

  it("restores the pre-existing output if the publish rename fails", async () => {
    const fs = await import("node:fs");
    const out = path.join(fx.dir, "rollback-target.pdf");
    fs.writeFileSync(out, "ORIGINAL");
    const beforeBytes = fs.readFileSync(out);

    let calls = 0;
    const real = fs.renameSync.bind(fs);
    __setRenameImplForTests((from: any, to: any) => {
      calls++;
      if (calls === 2) {
        throw Object.assign(new Error("simulated publish-rename failure"), { code: "EIO" });
      }
      return real(from, to);
    });

    try {
      await expect(
        fillPdfFields({
          pdf_path: fx.pdf,
          output_path: out,
          field_values: { FirstName: "Rolled" },
          dry_run: false,
        })
      ).rejects.toMatchObject({
        code: "WRITE_FAILED",
        details: expect.objectContaining({
          rollback_attempted: true,
          rollback_succeeded: true,
        }),
      });
    } finally {
      __setRenameImplForTests(null);
    }

    const afterBytes = fs.readFileSync(out);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    const entries = fs.readdirSync(fx.dir);
    expect(entries.some((n) => n.includes(".tmp."))).toBe(false);
    // Three rename phases observed: backup (1), publish-fail (2), rollback (3).
    expect(calls).toBe(3);
  });

  it("reports rollback_succeeded=false if the rollback itself fails", async () => {
    const fs = await import("node:fs");
    const out = path.join(fx.dir, "rollback-fail.pdf");
    fs.writeFileSync(out, "ORIGINAL");

    let calls = 0;
    const real = fs.renameSync.bind(fs);
    __setRenameImplForTests((from: any, to: any) => {
      calls++;
      if (calls === 2 || calls === 3) {
        throw Object.assign(new Error(`simulated failure ${calls}`), { code: "EIO" });
      }
      return real(from, to);
    });

    try {
      await expect(
        fillPdfFields({
          pdf_path: fx.pdf,
          output_path: out,
          field_values: { FirstName: "X" },
          dry_run: false,
        })
      ).rejects.toMatchObject({
        code: "WRITE_FAILED",
        details: expect.objectContaining({
          rollback_attempted: true,
          rollback_succeeded: false,
          rollback_error: expect.any(String),
        }),
      });
    } finally {
      __setRenameImplForTests(null);
    }
  });
});

describe("unknown-type field: validate and fill must agree (review finding #2)", () => {
  it("validate flags it as illegal (valid=false, safe_to_fill=false)", async () => {
    const r = await validatePdfFill({
      pdf_path: unknownType.pdf,
      field_values: { Mysterious: "x" },
    });
    expect(r.valid).toBe(false);
    expect(r.safe_to_fill).toBe(false);
    expect(r.illegal_values.length).toBe(1);
    expect(r.illegal_values[0]?.reason).toMatch(/not fillable/);
  });
  it("fill rejects with ILLEGAL_VALUES and writes no output", async () => {
    const out = path.join(unknownType.dir, "unk-out.pdf");
    await expect(
      fillPdfFields({
        pdf_path: unknownType.pdf,
        output_path: out,
        field_values: { Mysterious: "x" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "ILLEGAL_VALUES" });
    const fs = await import("node:fs");
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("fill on a PDF with /XFA refuses (review finding #3)", () => {
  it("fill_pdf_fields rejects mixed AcroForm+XFA with XFA_PRESENT", async () => {
    const out = path.join(mixedXfa.dir, "xfa-fill-out.pdf");
    await expect(
      fillPdfFields({
        pdf_path: mixedXfa.pdf,
        output_path: out,
        field_values: { Name: "ShouldNotWrite" },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "XFA_PRESENT" });
    const fs = await import("node:fs");
    expect(fs.existsSync(out)).toBe(false);
    // The input must be byte-identical post-failure — fill never opened it
    // for writing, never serialized, never touched /XFA. Re-parse and
    // confirm the AcroForm dict still has /XFA as a key (substring matching
    // on the raw bytes is fragile across pdf-lib's encodings).
    const { PDFDocument, PDFName, PDFDict } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(mixedXfa.pdf));
    const af = doc.catalog.lookup(PDFName.of("AcroForm"));
    expect(af).toBeInstanceOf(PDFDict);
    const xfaKey = [...(af as InstanceType<typeof PDFDict>).keys()].map((k) =>
      k.decodeText()
    );
    expect(xfaKey).toContain("XFA");
  });
  it("list_pdf_fields and validate_pdf_fill remain allowed on XFA PDFs (read-only)", async () => {
    const lr = await listPdfFields({ pdf_path: mixedXfa.pdf });
    expect(lr.has_xfa).toBe(true);
    expect(lr.has_fields).toBe(true);
    const vr = await validatePdfFill({
      pdf_path: mixedXfa.pdf,
      field_values: { Name: "Tom" },
    });
    expect(vr.pdf_sha256).toBeTruthy();
  });
});

describe("degenerate checkbox without readable /AP/N states (review finding 4a)", () => {
  // Synthetic checkbox-typed field with no /AP appearance dict at all,
  // so options is empty. We build this inline rather than as a fixture
  // helper since it's the only test that needs it.
  it("validate marks `true` as illegal when options is empty", async () => {
    const { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFNumber } =
      await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ctx = doc.context;
    const cb = ctx.obj({}) as InstanceType<typeof PDFDict>;
    cb.set(PDFName.of("T"), PDFString.of("Naked"));
    cb.set(PDFName.of("FT"), PDFName.of("Btn"));
    cb.set(PDFName.of("Subtype"), PDFName.of("Widget"));
    cb.set(
      PDFName.of("Rect"),
      ctx.obj([
        PDFNumber.of(50),
        PDFNumber.of(700),
        PDFNumber.of(70),
        PDFNumber.of(720),
      ]) as InstanceType<typeof PDFArray>
    );
    // intentionally no /AP
    const ref = ctx.register(cb);
    const af = ctx.obj({}) as InstanceType<typeof PDFDict>;
    const fields = ctx.obj([]) as InstanceType<typeof PDFArray>;
    fields.push(ref);
    af.set(PDFName.of("Fields"), fields);
    doc.catalog.set(PDFName.of("AcroForm"), af);
    const annots = ctx.obj([]) as InstanceType<typeof PDFArray>;
    annots.push(ref);
    page.node.set(PDFName.of("Annots"), annots);
    const bytes = await doc.save();
    const fs = await import("node:fs");
    const dir = await import("node:os").then((m) =>
      fs.mkdtempSync(path.join(m.tmpdir(), "pdffieldfiller-naked-"))
    );
    process.env.ALLOWED_DIRS = `${process.env.ALLOWED_DIRS},${dir}`;
    const pdf = path.join(dir, "naked.pdf");
    fs.writeFileSync(pdf, bytes);

    const r = await validatePdfFill({
      pdf_path: pdf,
      field_values: { Naked: true },
    });
    expect(r.valid).toBe(false);
    expect(r.safe_to_fill).toBe(false);
    expect(r.illegal_values[0]?.reason).toMatch(/readable.*\/AP\/N|export states/);

    const out = path.join(dir, "naked-out.pdf");
    await expect(
      fillPdfFields({
        pdf_path: pdf,
        output_path: out,
        field_values: { Naked: true },
        dry_run: false,
      })
    ).rejects.toMatchObject({ code: "ILLEGAL_VALUES" });
  });
});

describe("toErrorPayload non-domain throw is INTERNAL_ERROR (review finding 4b)", () => {
  it("classifies a plain TypeError as INTERNAL_ERROR rather than PDF_PARSE_ERROR", async () => {
    const { toErrorPayload } = await import("../src/errors.js");
    const payload = toErrorPayload(new TypeError("internal bug"));
    expect(payload.error_code).toBe("INTERNAL_ERROR");
  });
});

describe("__setRenameImplForTests is gated to test env (review finding 4d)", () => {
  it("throws if called outside a test/VITEST env", async () => {
    const { __setRenameImplForTests } = await import("../src/tools/fill.js");
    const prevVitest = process.env.VITEST;
    const prevNode = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      expect(() => __setRenameImplForTests(null)).toThrow(/test-only/);
    } finally {
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
      else delete process.env.NODE_ENV;
    }
  });
});

describe("safe_to_fill ⇒ fill accepts (invariant pin for #1)", () => {
  // The two functions (validate's checkValueAgainstField, fill's
  // validateLegalValue) are hand-kept in sync. This test does not unify
  // them — that's tracked as issue #1 — but it pins the contract: any
  // request validate says is safe_to_fill MUST also pass a dry-run fill
  // without illegal_values / blocked_human_only_fields / blocked_read_only.
  // If the two diverge in a future edit, this test fires.

  type Case = { name: string; pdf: () => string; values: Record<string, unknown> };
  const buildCases = (): Case[] => [
    {
      name: "kitchen-sink: ordinary text",
      pdf: () => fx.pdf,
      values: { FirstName: "Tom" },
    },
    {
      name: "kitchen-sink: dropdown by export",
      pdf: () => fx.pdf,
      values: { State: "NY" },
    },
    {
      name: "kitchen-sink: data date (review-required but safe)",
      pdf: () => fx.pdf,
      values: { Date_Of_Birth: "1990-01-01" },
    },
    {
      name: "heterogeneous-checkbox by per-widget export",
      pdf: () => heteroCb.pdf,
      values: { MultiCheck: "OptionB" },
    },
    {
      name: "radio by export",
      pdf: () => btn.pdf,
      values: { Relationship: "Spouse" },
    },
    {
      name: "dropdown pairs: accept export value",
      pdf: () => ddPairs.pdf,
      values: { Country: "CA" },
    },
    {
      name: "text at exactly MaxLen",
      pdf: () => maxLen.pdf,
      values: { Short: "ABCDE" },
    },
  ];

  for (const c of buildCases()) {
    it(`${c.name}: safe_to_fill true ⇒ dry-run accepts`, async () => {
      const v = await validatePdfFill({ pdf_path: c.pdf(), field_values: c.values });
      // Sanity: each case should actually be safe; if not, the test data is
      // wrong, which is also worth catching.
      expect(v.valid).toBe(true);
      expect(v.safe_to_fill).toBe(true);
      // The invariant: dry-run fill must accept the same input.
      const out = path.join(path.dirname(c.pdf()), `inv-${Math.random().toString(36).slice(2)}.pdf`);
      const r = await fillPdfFields({
        pdf_path: c.pdf(),
        output_path: out,
        field_values: c.values,
        dry_run: true,
      });
      expect(r.unknown_fields).toEqual([]);
      expect(r.illegal_values).toEqual([]);
      expect(r.blocked_human_only_fields).toEqual([]);
      expect(r.would_write?.length).toBeGreaterThan(0);
    });
  }
});

describe("SERVER_VERSION matches package.json (P1-6)", () => {
  it("matches the version field in package.json at module load time", async () => {
    const { SERVER_VERSION } = await import("../src/tools/export.js");
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    expect(SERVER_VERSION).toBe(pkg.version);
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
