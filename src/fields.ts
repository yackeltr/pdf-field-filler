import { readFileSync } from "node:fs";
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFRef,
  PDFBool,
  PDFObject,
} from "pdf-lib";
import { PdfFillerError } from "./errors.js";

const READ_ONLY = 1 << 0;
const REQUIRED = 1 << 1;
const FF_PUSHBUTTON = 1 << 16;
const FF_RADIO = 1 << 15;
const FF_COMBO = 1 << 17;

export type FieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "option_list"
  | "button"
  | "signature"
  | "unknown";

export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetInfo {
  page_number: number | null;
  rect: FieldRect;
}

export interface FieldInfo {
  name: string;
  type: FieldType;
  current_value: string | boolean | string[] | null;
  options: string[];
  max_length: number | null;
  is_required: boolean;
  is_read_only: boolean;
  is_signature_field: boolean;
  is_human_only: boolean;
  page_number: number | null;
  rect: FieldRect;
  widgets: WidgetInfo[];
  notes: string[];
}

export interface FieldExtractionResult {
  has_fields: boolean;
  field_count: number;
  fields: FieldInfo[];
  has_xfa: boolean;
  xfa_supported: boolean;
  message?: string;
}

function tokenize(name: string): string[] {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const HUMAN_ONLY_TOKENS = new Set([
  "signature",
  "signatures",
  "sign",
  "signs",
  "signed",
  "signing",
  "initial",
  "initials",
  "attest",
  "attests",
  "attested",
  "attesting",
  "attestation",
  "attestations",
  "certify",
  "certified",
  "certifies",
  "certifying",
  "certification",
  "certifications",
  "executed",
  "execution",
]);

const SIGNING_DATE_PATTERNS = [
  /\bdate[_\s]*signed\b/i,
  /\bsigned[_\s]*date\b/i,
  /\bsignature[_\s]*date\b/i,
  /\bsigning[_\s]*date\b/i,
  /\bexecution[_\s]*date\b/i,
  /\bexecuted[_\s]*date\b/i,
  /\bsign[_\s]*date\b/i,
];

const SIGNING_TOKEN_PAIRS: Array<[string, string]> = [
  ["sign", "date"],
  ["signed", "date"],
  ["signing", "date"],
  ["signature", "date"],
  ["execution", "date"],
  ["executed", "date"],
];

export function looksLikeDateField(name: string): boolean {
  const tokens = tokenize(name);
  return tokens.includes("date") || tokens.includes("dob") || tokens.includes("dod");
}

function isSigningDateName(name: string): boolean {
  if (SIGNING_DATE_PATTERNS.some((re) => re.test(name))) return true;
  const tokens = tokenize(name);
  if (tokens.length < 2) return false;
  return SIGNING_TOKEN_PAIRS.some(([a, b]) => tokens.includes(a) && tokens.includes(b));
}

export function looksLikeOrdinaryDataDate(name: string): boolean {
  if (!looksLikeDateField(name)) return false;
  return !isSigningDateName(name);
}

export function isHumanOnlyName(name: string, type: FieldType): boolean {
  if (type === "signature") return true;
  const tokens = tokenize(name);
  if (tokens.some((t) => HUMAN_ONLY_TOKENS.has(t))) return true;
  if (isSigningDateName(name)) return true;
  return false;
}

// Path-based readers are intentionally NOT exported. The tools must obtain
// bytes via readPdfWithIdentity (single-fd snapshot) and pass them to
// loadPdfFromBytes, so identity, parse, and extract all share one buffer.
// Eliminating the path-based loader from the export surface makes the
// TOCTOU leak structurally unrepresentable in callers.
export async function loadPdfFromBytes(
  bytes: Uint8Array,
  ctx: { path?: string } = {}
): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PdfFillerError("PDF_PARSE_ERROR", `Failed to parse PDF: ${msg}`, {
      path: ctx.path,
    });
  }
  if (doc.isEncrypted) {
    throw new PdfFillerError("PDF_ENCRYPTED", "PDF is encrypted or password-protected.", {
      path: ctx.path,
    });
  }
  return doc;
}

function getCatalogDict(doc: PDFDocument): PDFDict {
  return doc.catalog;
}

function getAcroFormDict(doc: PDFDocument): PDFDict | null {
  const catalog = getCatalogDict(doc);
  const afRaw = catalog.get(PDFName.of("AcroForm"));
  if (!afRaw) return null;
  const af = catalog.lookup(PDFName.of("AcroForm"));
  if (!(af instanceof PDFDict)) return null;
  return af;
}

function asString(obj: PDFObject | undefined): string | undefined {
  if (!obj) return undefined;
  if (obj instanceof PDFString) return obj.decodeText();
  if (obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return undefined;
}

function asNumber(obj: PDFObject | undefined): number | undefined {
  if (obj instanceof PDFNumber) return obj.asNumber();
  return undefined;
}

interface InheritedAttrs {
  FT?: string;
  Ff?: number;
  V?: PDFObject;
  DV?: PDFObject;
  Opt?: PDFObject;
  MaxLen?: number;
  DA?: string;
}

function lookupInDict(dict: PDFDict, key: string): PDFObject | undefined {
  const v = dict.lookup(PDFName.of(key));
  return v ?? undefined;
}

function inheritedFor(fieldStack: PDFDict[]): InheritedAttrs {
  const out: InheritedAttrs = {};
  for (const d of fieldStack) {
    const ft = lookupInDict(d, "FT");
    if (ft instanceof PDFName) out.FT = ft.decodeText();
    const ff = lookupInDict(d, "Ff");
    if (ff instanceof PDFNumber) out.Ff = ff.asNumber();
    const v = lookupInDict(d, "V");
    if (v) out.V = v;
    const dv = lookupInDict(d, "DV");
    if (dv) out.DV = dv;
    const opt = lookupInDict(d, "Opt");
    if (opt) out.Opt = opt;
    const ml = lookupInDict(d, "MaxLen");
    if (ml instanceof PDFNumber) out.MaxLen = ml.asNumber();
    const da = lookupInDict(d, "DA");
    const dasStr = asString(da);
    if (dasStr !== undefined) out.DA = dasStr;
  }
  return out;
}

function determineType(ft: string | undefined, ff: number): FieldType {
  if (!ft) return "unknown";
  switch (ft) {
    case "Tx":
      return "text";
    case "Sig":
      return "signature";
    case "Btn": {
      if (ff & FF_PUSHBUTTON) return "button";
      if (ff & FF_RADIO) return "radio";
      return "checkbox";
    }
    case "Ch": {
      return ff & FF_COMBO ? "dropdown" : "option_list";
    }
    default:
      return "unknown";
  }
}

function buildQualifiedName(stack: PDFDict[]): string {
  const parts: string[] = [];
  for (const d of stack) {
    const t = asString(lookupInDict(d, "T"));
    if (t !== undefined && t.length > 0) parts.push(t);
  }
  return parts.join(".");
}

function isWidgetDict(d: PDFDict): boolean {
  const subtype = lookupInDict(d, "Subtype");
  return subtype instanceof PDFName && subtype.decodeText() === "Widget";
}

interface WidgetEntry {
  page_number: number;
  rect: FieldRect;
  dict: PDFDict;
}

interface PageIndex {
  widgetsByFieldName: Map<string, WidgetEntry[]>;
}

function buildQualifiedNameFromAnnot(annotDict: PDFDict): string {
  const parts: string[] = [];
  let cur: PDFDict | undefined = annotDict;
  let safety = 0;
  while (cur && safety < 32) {
    safety++;
    const t = cur.lookup(PDFName.of("T"));
    const s = asString(t);
    if (s !== undefined && s.length > 0) parts.unshift(s);
    const next: PDFObject | undefined = cur.lookup(PDFName.of("Parent"));
    cur = next instanceof PDFDict ? next : undefined;
  }
  return parts.join(".");
}

function buildPageIndex(doc: PDFDocument): PageIndex {
  const widgetsByFieldName = new Map<string, WidgetEntry[]>();
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const annotsObj = page.node.lookup(PDFName.of("Annots"));
    if (!(annotsObj instanceof PDFArray)) return;
    for (let j = 0; j < annotsObj.size(); j++) {
      const item = annotsObj.lookup(j);
      if (!(item instanceof PDFDict)) continue;
      const subtype = item.lookup(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Widget") continue;
      const name = buildQualifiedNameFromAnnot(item);
      if (!name) continue;
      const rect = readRect(item);
      const entry: WidgetEntry = { page_number: i + 1, rect, dict: item };
      const list = widgetsByFieldName.get(name);
      if (list) list.push(entry);
      else widgetsByFieldName.set(name, [entry]);
    }
  });
  return { widgetsByFieldName };
}

function readRect(widgetDict: PDFDict): FieldRect {
  const rectObj = widgetDict.lookup(PDFName.of("Rect"));
  if (rectObj instanceof PDFArray && rectObj.size() === 4) {
    const nums = [0, 1, 2, 3].map((i) => {
      const v = rectObj.get(i);
      return v instanceof PDFNumber ? v.asNumber() : 0;
    });
    const [x1, y1, x2, y2] = nums;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    return {
      x,
      y,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

function readApNStates(widgetDict: PDFDict): string[] {
  const ap = widgetDict.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return [];
  const n = ap.lookup(PDFName.of("N"));
  if (!(n instanceof PDFDict)) return [];
  const out: string[] = [];
  for (const k of n.keys()) {
    out.push(k.decodeText());
  }
  return out;
}

function readAsState(widgetDict: PDFDict): string | null {
  const as = widgetDict.get(PDFName.of("AS"));
  if (as instanceof PDFName) return as.decodeText();
  return null;
}

function parseOpt(opt: PDFObject | undefined): {
  options: string[];
  display: Map<string, string>;
  notes: string[];
} {
  const out = { options: [] as string[], display: new Map<string, string>(), notes: [] as string[] };
  if (!(opt instanceof PDFArray)) return out;
  for (let i = 0; i < opt.size(); i++) {
    const entry = opt.get(i);
    if (entry instanceof PDFString || entry instanceof PDFHexString) {
      out.options.push(entry.decodeText());
    } else if (entry instanceof PDFArray && entry.size() >= 2) {
      const exp = entry.get(0);
      const disp = entry.get(1);
      const expStr = asString(exp);
      const dispStr = asString(disp);
      if (expStr !== undefined) {
        out.options.push(expStr);
        if (dispStr !== undefined) out.display.set(expStr, dispStr);
      }
    } else {
      out.notes.push("Encountered unsupported /Opt entry shape.");
    }
  }
  return out;
}

function valueAsExportName(obj: PDFObject | undefined): string | null {
  if (!obj) return null;
  if (obj instanceof PDFName) return obj.decodeText();
  if (obj instanceof PDFString) return obj.decodeText();
  if (obj instanceof PDFHexString) return obj.decodeText();
  return null;
}

function valueAsText(obj: PDFObject | undefined): string | null {
  if (!obj) return null;
  if (obj instanceof PDFString) return obj.decodeText();
  if (obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  if (obj instanceof PDFNumber) return String(obj.asNumber());
  if (obj instanceof PDFBool) return String(obj.asBoolean());
  if (obj instanceof PDFArray) {
    const arr: string[] = [];
    for (let i = 0; i < obj.size(); i++) {
      const item = obj.get(i);
      const s = valueAsText(item);
      if (s !== null) arr.push(s);
    }
    return arr.join(", ");
  }
  return null;
}

function valueAsMulti(obj: PDFObject | undefined): string[] | null {
  if (obj instanceof PDFArray) {
    const arr: string[] = [];
    for (let i = 0; i < obj.size(); i++) {
      const item = obj.get(i);
      const s = valueAsText(item);
      if (s !== null) arr.push(s);
    }
    return arr;
  }
  return null;
}

interface FieldNode {
  dict: PDFDict;
  ref: PDFRef | null;
  stack: PDFDict[];
}

function collectKidsAsFieldsOrWidgets(
  dict: PDFDict
): { fieldKids: { dict: PDFDict; ref: PDFRef | null }[]; widgetKids: { dict: PDFDict; ref: PDFRef | null }[] } {
  const fieldKids: { dict: PDFDict; ref: PDFRef | null }[] = [];
  const widgetKids: { dict: PDFDict; ref: PDFRef | null }[] = [];
  const kids = dict.get(PDFName.of("Kids"));
  const kidsArr = kids ? dict.lookup(PDFName.of("Kids")) : undefined;
  if (!(kidsArr instanceof PDFArray)) return { fieldKids, widgetKids };
  for (let i = 0; i < kidsArr.size(); i++) {
    const rawItem = kidsArr.get(i);
    const ref = rawItem instanceof PDFRef ? rawItem : null;
    const item = kidsArr.lookup(i);
    if (!(item instanceof PDFDict)) continue;
    const hasT = !!item.get(PDFName.of("T"));
    if (isWidgetDict(item) && !hasT) {
      widgetKids.push({ dict: item, ref });
    } else if (hasT || item.has(PDFName.of("Kids"))) {
      fieldKids.push({ dict: item, ref });
    } else if (isWidgetDict(item)) {
      widgetKids.push({ dict: item, ref });
    } else {
      fieldKids.push({ dict: item, ref });
    }
  }
  return { fieldKids, widgetKids };
}

function buildFieldInfo(
  node: FieldNode,
  pageIndex: PageIndex
): FieldInfo {
  const notes: string[] = [];
  const stack = node.stack;
  const inh = inheritedFor(stack);
  const name = buildQualifiedName(stack);
  const ff = inh.Ff ?? 0;
  if (inh.Ff === undefined) notes.push("Field flags could not be read; defaulted to false.");
  const type = determineType(inh.FT, ff);
  const is_read_only = (ff & READ_ONLY) !== 0;
  const is_required = (ff & REQUIRED) !== 0;

  const widgetSources: { dict: PDFDict }[] = [];
  const indexed = pageIndex.widgetsByFieldName.get(name);
  if (indexed && indexed.length > 0) {
    for (const w of indexed) widgetSources.push({ dict: w.dict });
  } else {
    const { widgetKids } = collectKidsAsFieldsOrWidgets(node.dict);
    if (widgetKids.length > 0) {
      for (const w of widgetKids) widgetSources.push({ dict: w.dict });
    } else {
      widgetSources.push({ dict: node.dict });
    }
  }

  let widgets: WidgetInfo[];
  if (indexed && indexed.length > 0) {
    widgets = indexed.map((w) => ({ page_number: w.page_number, rect: w.rect }));
  } else {
    widgets = widgetSources.map((w) => ({
      page_number: null,
      rect: readRect(w.dict),
    }));
    notes.push("Page number could not be determined; field has no widget annotation on any page.");
  }
  if (widgets.length > 1) notes.push("Field has multiple widgets.");
  const top = widgets[0] ?? { page_number: null, rect: { x: 0, y: 0, width: 0, height: 0 } };

  let options: string[] = [];
  let current_value: FieldInfo["current_value"] = null;
  let max_length: number | null = null;

  if (type === "text") {
    max_length = inh.MaxLen ?? null;
    current_value = valueAsText(inh.V);
  } else if (type === "checkbox" || type === "radio") {
    const stateSet = new Set<string>();
    for (const w of widgetSources) {
      for (const s of readApNStates(w.dict)) {
        if (s !== "Off") stateSet.add(s);
      }
    }
    options = Array.from(stateSet);
    if (options.length === 0) notes.push("Checkbox/radio appearance states could not be read.");
    else notes.push("Checkbox/radio options inferred from appearance states.");

    const vName = valueAsExportName(inh.V);
    if (type === "checkbox") {
      if (vName && vName !== "Off") {
        current_value = vName;
      } else {
        const anyOn = widgetSources.some((w) => {
          const s = readAsState(w.dict);
          return s !== null && s !== "Off";
        });
        current_value = anyOn ? true : false;
      }
    } else {
      current_value = vName && vName !== "Off" ? vName : null;
    }
  } else if (type === "dropdown" || type === "option_list") {
    const parsed = parseOpt(inh.Opt);
    options = parsed.options;
    for (const n of parsed.notes) notes.push(n);
    if (type === "option_list") {
      current_value = valueAsMulti(inh.V) ?? valueAsText(inh.V);
    } else {
      current_value = valueAsText(inh.V);
    }
  } else if (type === "signature") {
    current_value = null;
  } else if (type === "button") {
    current_value = null;
  } else {
    current_value = valueAsText(inh.V);
  }

  const is_signature_field = type === "signature";
  const human_only_by_name = isHumanOnlyName(name, type);
  const is_human_only = is_signature_field || human_only_by_name;

  return {
    name,
    type,
    current_value,
    options,
    max_length,
    is_required,
    is_read_only,
    is_signature_field,
    is_human_only,
    page_number: top.page_number,
    rect: top.rect,
    widgets,
    notes,
  };
}

function walkFields(
  fieldRefs: PDFArray,
  parentDict: PDFDict,
  parentStack: PDFDict[],
  out: FieldInfo[],
  pageIndex: PageIndex
): void {
  for (let i = 0; i < fieldRefs.size(); i++) {
    const ref = fieldRefs.get(i);
    const child = fieldRefs.lookup(i);
    if (!(child instanceof PDFDict)) continue;
    const stack = [...parentStack, child];

    const hasOwnT = !!child.get(PDFName.of("T"));
    const hasKidsAsFields = (() => {
      const kids = child.lookup(PDFName.of("Kids"));
      if (!(kids instanceof PDFArray)) return false;
      for (let k = 0; k < kids.size(); k++) {
        const kd = kids.lookup(k);
        if (kd instanceof PDFDict) {
          const hasT = !!kd.get(PDFName.of("T"));
          if (hasT) return true;
        }
      }
      return false;
    })();

    if (hasKidsAsFields) {
      const kids = child.lookup(PDFName.of("Kids")) as PDFArray;
      walkFields(kids, child, stack, out, pageIndex);
      continue;
    }

    if (hasOwnT) {
      const node: FieldNode = {
        dict: child,
        ref: ref instanceof PDFRef ? ref : null,
        stack,
      };
      out.push(buildFieldInfo(node, pageIndex));
    }
  }
}

function detectXfa(af: PDFDict | null): boolean {
  if (!af) return false;
  const xfa = af.get(PDFName.of("XFA"));
  return xfa !== undefined && xfa !== null;
}

const XFA_NOTICE =
  "XFA was detected. This server supports AcroForm inspection/filling only and will not mutate XFA.";

export async function extractFieldsFromDoc(doc: PDFDocument): Promise<FieldExtractionResult> {
  const af = getAcroFormDict(doc);
  const has_xfa = detectXfa(af);
  if (!af) {
    return {
      has_fields: false,
      field_count: 0,
      fields: [],
      has_xfa: false,
      xfa_supported: false,
      message: "This PDF has zero AcroForm fields. It may be a flat scan or non-fillable PDF.",
    };
  }
  const fieldsArr = af.lookup(PDFName.of("Fields"));
  if (!(fieldsArr instanceof PDFArray) || fieldsArr.size() === 0) {
    return {
      has_fields: false,
      field_count: 0,
      fields: [],
      has_xfa,
      xfa_supported: false,
      message: has_xfa
        ? XFA_NOTICE
        : "This PDF has zero AcroForm fields. It may be a flat scan or non-fillable PDF.",
    };
  }
  const pageIndex = buildPageIndex(doc);
  const fields: FieldInfo[] = [];
  walkFields(fieldsArr, af, [], fields, pageIndex);
  return {
    has_fields: fields.length > 0,
    field_count: fields.length,
    fields,
    has_xfa,
    xfa_supported: false,
    message: has_xfa
      ? "XFA was detected alongside AcroForm fields. AcroForm fields may not represent the full form; XFA is not mutated by this server."
      : undefined,
  };
}

// Path-based extractFields is intentionally removed. Callers should use
// readPdfWithIdentity + loadPdfFromBytes + extractFieldsFromDoc.

export type { PDFDocument };
