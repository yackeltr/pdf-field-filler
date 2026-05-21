import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PDFDocument,
  PDFCheckBox,
  PDFRadioGroup,
  PDFTextField,
  PDFDropdown,
} from "pdf-lib";

export interface FixturePaths {
  dir: string;
  pdf: string;
}

export async function buildKitchenSinkPdf(): Promise<FixturePaths> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();

  const t = form.createTextField("FirstName");
  t.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  t.setText("Jane");

  const c = form.createCheckBox("AgreeToTerms");
  c.addToPage(page, { x: 50, y: 660, width: 14, height: 14 });

  const r = form.createRadioGroup("ColorPick");
  r.addOptionToPage("Red", page, { x: 50, y: 620, width: 14, height: 14 });
  r.addOptionToPage("Blue", page, { x: 80, y: 620, width: 14, height: 14 });
  r.addOptionToPage("Green", page, { x: 110, y: 620, width: 14, height: 14 });

  const d = form.createDropdown("State");
  d.addOptions(["CA", "NY", "TX"]);
  d.addToPage(page, { x: 50, y: 580, width: 100, height: 20 });

  const sig = form.createTextField("Signature_Line");
  sig.addToPage(page, { x: 50, y: 540, width: 300, height: 30 });

  const dob = form.createTextField("Date_Of_Birth");
  dob.addToPage(page, { x: 50, y: 500, width: 200, height: 20 });

  const signed = form.createTextField("Date_Signed");
  signed.addToPage(page, { x: 50, y: 460, width: 200, height: 20 });

  const initials = form.createTextField("Initials");
  initials.addToPage(page, { x: 50, y: 420, width: 200, height: 20 });

  const policyNum = form.createTextField("Policy_Certificate_Number");
  policyNum.addToPage(page, { x: 50, y: 380, width: 200, height: 20 });

  const bytes = await doc.save();
  const dir = mkdtempSync(path.join(tmpdir(), "pdffieldfiller-"));
  const pdf = path.join(dir, "fixture.pdf");
  writeFileSync(pdf, bytes);
  return { dir, pdf };
}

export async function buildEmptyPdf(): Promise<FixturePaths> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const bytes = await doc.save();
  const dir = mkdtempSync(path.join(tmpdir(), "pdffieldfiller-"));
  const pdf = path.join(dir, "empty.pdf");
  writeFileSync(pdf, bytes);
  return { dir, pdf };
}
