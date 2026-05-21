import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PDFDocument,
  PDFCheckBox,
  PDFRadioGroup,
  PDFTextField,
  PDFDropdown,
  PDFName,
  PDFString,
  PDFNumber,
  PDFArray,
  PDFRef,
  PDFDict,
  PDFHexString,
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

function attachWidgetRefsToPage(doc: PDFDocument, refs: PDFRef[]): void {
  const ctx = doc.context;
  const page = doc.getPage(0);
  const annots = ctx.obj([]) as PDFArray;
  for (const r of refs) annots.push(r);
  page.node.set(PDFName.of("Annots"), annots);
}

export async function buildInheritancePdf(): Promise<FixturePaths> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const ctx = doc.context;

  // Parent has FT=Tx, V="parent". Child has T="Last", own V="child" (should override), no FT (should inherit).
  const childDict = ctx.obj({}) as PDFDict;
  childDict.set(PDFName.of("T"), PDFString.of("Last"));
  childDict.set(PDFName.of("V"), PDFString.of("child"));
  childDict.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  const childRectArr = ctx.obj([
    PDFNumber.of(50),
    PDFNumber.of(700),
    PDFNumber.of(250),
    PDFNumber.of(720),
  ]) as PDFArray;
  childDict.set(PDFName.of("Rect"), childRectArr);
  const childRef = ctx.register(childDict);

  const parentDict = ctx.obj({}) as PDFDict;
  parentDict.set(PDFName.of("T"), PDFString.of("Person"));
  parentDict.set(PDFName.of("FT"), PDFName.of("Tx"));
  parentDict.set(PDFName.of("V"), PDFString.of("parent"));
  parentDict.set(PDFName.of("MaxLen"), PDFNumber.of(99));
  const parentKids = ctx.obj([]) as PDFArray;
  parentKids.push(childRef);
  parentDict.set(PDFName.of("Kids"), parentKids);
  const parentRef = ctx.register(parentDict);

  childDict.set(PDFName.of("Parent"), parentRef);

  // Second case: child overrides Ff (read-only at parent, writable at child)
  const child2 = ctx.obj({}) as PDFDict;
  child2.set(PDFName.of("T"), PDFString.of("Writable"));
  child2.set(PDFName.of("Ff"), PDFNumber.of(0));
  child2.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  child2.set(
    PDFName.of("Rect"),
    ctx.obj([PDFNumber.of(50), PDFNumber.of(660), PDFNumber.of(250), PDFNumber.of(680)]) as PDFArray
  );
  const child2Ref = ctx.register(child2);

  const parent2 = ctx.obj({}) as PDFDict;
  parent2.set(PDFName.of("T"), PDFString.of("Flags"));
  parent2.set(PDFName.of("FT"), PDFName.of("Tx"));
  parent2.set(PDFName.of("Ff"), PDFNumber.of(1));
  const p2Kids = ctx.obj([]) as PDFArray;
  p2Kids.push(child2Ref);
  parent2.set(PDFName.of("Kids"), p2Kids);
  const parent2Ref = ctx.register(parent2);
  child2.set(PDFName.of("Parent"), parent2Ref);

  // Third case: choice field with /Opt at child overriding parent
  const child3 = ctx.obj({}) as PDFDict;
  child3.set(PDFName.of("T"), PDFString.of("Pick"));
  const child3Opts = ctx.obj([]) as PDFArray;
  child3Opts.push(PDFString.of("X"));
  child3Opts.push(PDFString.of("Y"));
  child3.set(PDFName.of("Opt"), child3Opts);
  child3.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  child3.set(
    PDFName.of("Rect"),
    ctx.obj([PDFNumber.of(50), PDFNumber.of(620), PDFNumber.of(250), PDFNumber.of(640)]) as PDFArray
  );
  const child3Ref = ctx.register(child3);

  const parent3 = ctx.obj({}) as PDFDict;
  parent3.set(PDFName.of("T"), PDFString.of("Choices"));
  parent3.set(PDFName.of("FT"), PDFName.of("Ch"));
  parent3.set(PDFName.of("Ff"), PDFNumber.of(1 << 17)); // Combo
  const parent3Opts = ctx.obj([]) as PDFArray;
  parent3Opts.push(PDFString.of("A"));
  parent3Opts.push(PDFString.of("B"));
  parent3.set(PDFName.of("Opt"), parent3Opts);
  const p3Kids = ctx.obj([]) as PDFArray;
  p3Kids.push(child3Ref);
  parent3.set(PDFName.of("Kids"), p3Kids);
  const parent3Ref = ctx.register(parent3);
  child3.set(PDFName.of("Parent"), parent3Ref);

  // AcroForm
  const acroForm = ctx.obj({}) as PDFDict;
  const fields = ctx.obj([]) as PDFArray;
  fields.push(parentRef);
  fields.push(parent2Ref);
  fields.push(parent3Ref);
  acroForm.set(PDFName.of("Fields"), fields);
  doc.catalog.set(PDFName.of("AcroForm"), acroForm);

  // Page annots reference the widgets (leaf children with Subtype=Widget)
  attachWidgetRefsToPage(doc, [childRef, child2Ref, child3Ref]);

  const bytes = await doc.save();
  const dir = mkdtempSync(path.join(tmpdir(), "pdffieldfiller-"));
  const pdf = path.join(dir, "inherit.pdf");
  writeFileSync(pdf, bytes);
  return { dir, pdf };
}

export async function buildCheckboxRadioPdf(): Promise<FixturePaths> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;

  // Checkbox with explicit export value "Yes" (not just /On)
  const cbWidget = ctx.obj({}) as PDFDict;
  cbWidget.set(PDFName.of("T"), PDFString.of("AgreeYes"));
  cbWidget.set(PDFName.of("FT"), PDFName.of("Btn"));
  cbWidget.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  cbWidget.set(
    PDFName.of("Rect"),
    ctx.obj([PDFNumber.of(50), PDFNumber.of(700), PDFNumber.of(70), PDFNumber.of(720)]) as PDFArray
  );
  cbWidget.set(PDFName.of("AS"), PDFName.of("Off"));
  const apDict = ctx.obj({}) as PDFDict;
  const nDict = ctx.obj({}) as PDFDict;
  // Provide content streams as plain dicts; pdf-lib will accept them as appearance state markers
  const onAp = ctx.obj({}) as PDFDict;
  const offAp = ctx.obj({}) as PDFDict;
  nDict.set(PDFName.of("Yes"), onAp);
  nDict.set(PDFName.of("Off"), offAp);
  apDict.set(PDFName.of("N"), nDict);
  cbWidget.set(PDFName.of("AP"), apDict);
  const cbRef = ctx.register(cbWidget);

  // Radio group with 2 widgets sharing parent, /AP/N keys "Spouse", "Child", "Other"
  const radioParent = ctx.obj({}) as PDFDict;
  radioParent.set(PDFName.of("T"), PDFString.of("Relationship"));
  radioParent.set(PDFName.of("FT"), PDFName.of("Btn"));
  radioParent.set(PDFName.of("Ff"), PDFNumber.of(1 << 15)); // Radio
  const radioRef = ctx.register(radioParent);

  function makeRadioKid(name: string): { ref: any } {
    const w = ctx.obj({}) as PDFDict;
    w.set(PDFName.of("Subtype"), PDFName.of("Widget"));
    w.set(PDFName.of("Parent"), radioRef);
    w.set(
      PDFName.of("Rect"),
      ctx.obj([PDFNumber.of(50), PDFNumber.of(660), PDFNumber.of(70), PDFNumber.of(680)]) as PDFArray
    );
    w.set(PDFName.of("AS"), PDFName.of("Off"));
    const ap = ctx.obj({}) as PDFDict;
    const n = ctx.obj({}) as PDFDict;
    n.set(PDFName.of(name), ctx.obj({}) as PDFDict);
    n.set(PDFName.of("Off"), ctx.obj({}) as PDFDict);
    ap.set(PDFName.of("N"), n);
    w.set(PDFName.of("AP"), ap);
    return { ref: ctx.register(w) };
  }
  const k1 = makeRadioKid("Spouse").ref;
  const k2 = makeRadioKid("Child").ref;
  const k3 = makeRadioKid("Other").ref;
  const kidsArr = ctx.obj([]) as PDFArray;
  kidsArr.push(k1);
  kidsArr.push(k2);
  kidsArr.push(k3);
  radioParent.set(PDFName.of("Kids"), kidsArr);
  // Select Child
  radioParent.set(PDFName.of("V"), PDFName.of("Child"));
  // Sync AS on chosen widget
  const k2Dict = ctx.lookup(k2) as PDFDict;
  k2Dict.set(PDFName.of("AS"), PDFName.of("Child"));

  // AcroForm
  const af = ctx.obj({}) as PDFDict;
  const fields = ctx.obj([]) as PDFArray;
  fields.push(cbRef);
  fields.push(radioRef);
  af.set(PDFName.of("Fields"), fields);
  doc.catalog.set(PDFName.of("AcroForm"), af);
  // Page annots
  const annots = ctx.obj([]) as PDFArray;
  annots.push(cbRef);
  annots.push(k1);
  annots.push(k2);
  annots.push(k3);
  page.node.set(PDFName.of("Annots"), annots);

  const bytes = await doc.save();
  const dir = mkdtempSync(path.join(tmpdir(), "pdffieldfiller-"));
  const pdf = path.join(dir, "btn.pdf");
  writeFileSync(pdf, bytes);
  return { dir, pdf };
}

export async function buildDropdownPairsPdf(): Promise<FixturePaths> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;

  // Dropdown with /Opt as [exportValue, displayValue] pairs
  const dd = ctx.obj({}) as PDFDict;
  dd.set(PDFName.of("T"), PDFString.of("Country"));
  dd.set(PDFName.of("FT"), PDFName.of("Ch"));
  dd.set(PDFName.of("Ff"), PDFNumber.of(1 << 17)); // Combo
  dd.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  dd.set(
    PDFName.of("Rect"),
    ctx.obj([PDFNumber.of(50), PDFNumber.of(700), PDFNumber.of(250), PDFNumber.of(720)]) as PDFArray
  );
  const opt = ctx.obj([]) as PDFArray;
  const pair1 = ctx.obj([PDFString.of("US"), PDFString.of("United States")]) as PDFArray;
  const pair2 = ctx.obj([PDFString.of("CA"), PDFString.of("Canada")]) as PDFArray;
  const pair3 = ctx.obj([PDFString.of("MX"), PDFString.of("Mexico")]) as PDFArray;
  opt.push(pair1);
  opt.push(pair2);
  opt.push(pair3);
  dd.set(PDFName.of("Opt"), opt);
  const ddRef = ctx.register(dd);

  const af = ctx.obj({}) as PDFDict;
  const fields = ctx.obj([]) as PDFArray;
  fields.push(ddRef);
  af.set(PDFName.of("Fields"), fields);
  doc.catalog.set(PDFName.of("AcroForm"), af);

  const annots = ctx.obj([]) as PDFArray;
  annots.push(ddRef);
  page.node.set(PDFName.of("Annots"), annots);

  const bytes = await doc.save();
  const dir = mkdtempSync(path.join(tmpdir(), "pdffieldfiller-"));
  const pdf = path.join(dir, "dd-pairs.pdf");
  writeFileSync(pdf, bytes);
  return { dir, pdf };
}

export async function buildXfaPdf(): Promise<FixturePaths> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const ctx = doc.context;

  const acroForm = ctx.obj({}) as PDFDict;
  acroForm.set(PDFName.of("Fields"), ctx.obj([]) as PDFArray);
  const xfaBytes = Buffer.from(
    "<?xml version='1.0'?><xfa xmlns='http://www.xfa.org/schema/xfa-template/3.3'/>",
    "utf-8"
  );
  const xfaStr = PDFHexString.fromText(xfaBytes.toString("utf-8"));
  acroForm.set(PDFName.of("XFA"), xfaStr);
  doc.catalog.set(PDFName.of("AcroForm"), acroForm);

  const bytes = await doc.save();
  const dir = mkdtempSync(path.join(tmpdir(), "pdffieldfiller-"));
  const pdf = path.join(dir, "xfa.pdf");
  writeFileSync(pdf, bytes);
  return { dir, pdf };
}
