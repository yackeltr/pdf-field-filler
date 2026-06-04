# Recommendations for Flat-Scan PDF Support in `pdf-field-filler`

## Executive Summary

The existing `pdf-field-filler` project should remain focused on safe, deterministic AcroForm completion:

```text
AcroForm PDF → exact field map → validation → dry-run diff → deterministic fill → human signs
```

Flat scanned PDFs should be handled as a separate workflow. A flat scan does not contain internal PDF form fields, so the server should not pretend that it can “fill fields by name.” Instead, it should detect candidate write zones, require human review, and then apply deterministic overlays.

Recommended flat-scan workflow:

```text
Flat scan → OCR/searchable PDF → candidate zone detection → visual review → deterministic text overlay → human signs
```

The safest near-term goal is not automatic flat-form filling. The highest-value addition is:

```text
detect_flat_form_zones + render_flat_form_zones
```

This would let Claude propose a mapping while the user visually verifies every coordinate before anything is written.

---

## Recommended Architecture

### Keep Two Modes Separate

Do not merge flat-scan logic into the existing AcroForm field tools. Use separate tools and separate data structures.

### AcroForm Mode

Existing workflow:

```text
list_pdf_fields
validate_pdf_fill
fill_pdf_fields
export_pdf_field_map
```

These tools operate on exact internal field names and should remain strict.

### Flat PDF Mode

New workflow:

```text
ocr_pdf_to_searchable_pdf
detect_flat_form_zones
export_flat_zone_map
render_flat_form_zones
overlay_text_on_pdf
```

Flat-scan mode should be explicit. If `list_pdf_fields` finds zero AcroForm fields, it can recommend flat-scan tools but should not silently switch modes.

---

## Recommended Open-Source Building Blocks

### 1. OCRmyPDF

Use for local OCR preprocessing.

Best use:

```text
ocr_pdf_to_searchable_pdf(input_pdf, output_pdf, language="eng", deskew=true, rotate=true)
```

Why it is useful:

- Mature local OCR pipeline
- Handles rotation and deskewing
- Creates searchable PDFs
- Can produce OCR sidecar text
- Avoids building OCR preprocessing from scratch

Recommendation:

Use OCRmyPDF as an optional local dependency invoked as a subprocess. Do not make network calls.

---

### 2. LayoutParser

Use as a reference or optional dependency for document layout objects.

Why it is useful:

- Strong bounding-box model
- Useful abstractions for OCR text blocks and document regions
- Good fit for zone review workflows
- Helpful for future visualization/annotation pipelines

Recommendation:

Do not require LayoutParser in v1 if it complicates installation. Start with simpler OCR text boxes and OpenCV heuristics, then consider LayoutParser if zone detection quality is inadequate.

---

### 3. OpenCV

Use for simple visual heuristics.

Likely uses:

- Detect horizontal blank lines
- Detect rectangular boxes
- Detect checkbox candidates
- Identify underlined write zones
- Support page deskew or validation if OCRmyPDF is not used

Recommendation:

Use OpenCV for candidate detection, not final filling decisions. All detected zones should be review-required.

---

### 4. PDF Rendering Tool

Needed to convert PDF pages into images for OCR and visual zone detection.

Options:

- `pdfjs-dist`
- Poppler command-line tools, such as `pdftoppm`
- PyMuPDF if a Python helper is acceptable

Recommendation:

If staying TypeScript-only, start with `pdfjs-dist`. If reliability matters more than staying pure TypeScript, PyMuPDF is often simpler for page rendering and coordinate extraction.

---

### 5. pdf-lib

Continue using `pdf-lib` for deterministic final PDF output.

Recommended use in flat mode:

- Load original PDF
- Draw reviewed text overlays at explicit coordinates
- Draw checkmarks only at reviewed checkbox coordinates
- Never apply signatures
- Never flatten by default unless explicitly requested in a future version

---

## Proposed New MCP Tools

### 1. `ocr_pdf_to_searchable_pdf`

Purpose:

Convert a scanned PDF into a searchable OCR PDF.

Input:

```json
{
  "input_pdf_path": "/absolute/path/input.pdf",
  "output_pdf_path": "/absolute/path/output_ocr.pdf",
  "language": "eng",
  "deskew": true,
  "rotate": true,
  "force_ocr": false
}
```

Behavior:

- Requires absolute paths.
- Enforces `ALLOWED_DIRS`.
- Refuses to overwrite unless `overwrite=true`.
- Runs locally only.
- Uses OCRmyPDF if installed.
- Returns structured error if OCRmyPDF is missing.
- Does not modify the input PDF.

Output:

```json
{
  "ok": true,
  "input_pdf_path": "/absolute/path/input.pdf",
  "output_pdf_path": "/absolute/path/output_ocr.pdf",
  "page_count": 4,
  "ocr_engine": "ocrmypdf",
  "warnings": []
}
```

Safety notes:

- OCR output may contain recognition errors.
- OCR should support detection and review, not final autonomous filling.

---

### 2. `detect_flat_form_zones`

Purpose:

Detect candidate write zones, labels, checkboxes, and likely signature areas in a flat PDF.

Input:

```json
{
  "pdf_path": "/absolute/path/form_ocr.pdf",
  "max_pages": 20
}
```

Output:

```json
{
  "has_acroform_fields": false,
  "pages": [
    {
      "page_number": 1,
      "text_labels": [
        {
          "text": "Date of Birth",
          "bbox": { "x": 72, "y": 410, "width": 90, "height": 12 },
          "confidence": 0.92
        }
      ],
      "candidate_write_zones": [
        {
          "zone_id": "page1_zone_003",
          "bbox": { "x": 170, "y": 407, "width": 130, "height": 16 },
          "nearby_label": "Date of Birth",
          "field_type_guess": "date",
          "confidence": 0.74,
          "needs_review": true,
          "review_reason": "Flat-scan candidate zone inferred from OCR label and nearby underline."
        }
      ],
      "checkbox_candidates": [
        {
          "zone_id": "page1_checkbox_002",
          "bbox": { "x": 90, "y": 532, "width": 10, "height": 10 },
          "nearby_label": "Yes",
          "checked_state": "unknown",
          "confidence": 0.68,
          "needs_review": true
        }
      ],
      "human_only_candidates": [
        {
          "zone_id": "page1_signature_001",
          "bbox": { "x": 110, "y": 690, "width": 220, "height": 24 },
          "nearby_label": "Signature",
          "reason": "Signature-related label detected."
        }
      ]
    }
  ]
}
```

Rules:

- All candidate zones require review.
- Never classify a detected zone as safe to fill without review.
- Signature, initials, attestation, certification, and signing-date zones must be blocked.
- Ordinary data dates may be fillable, but review-required.
- Return coordinates in PDF coordinate space, not image pixel space, or clearly include the coordinate system.

---

### 3. `render_flat_form_zones`

Purpose:

Create a visual review PDF with boxes and labels over candidate zones.

Input:

```json
{
  "pdf_path": "/absolute/path/form.pdf",
  "zones_json_path": "/absolute/path/zones.json",
  "output_pdf_path": "/absolute/path/zones_review.pdf"
}
```

Behavior:

- Draws bounding boxes and zone IDs over the original pages.
- Labels human-only zones distinctly.
- Does not alter the original PDF.
- Does not fill any values.

Output:

```json
{
  "ok": true,
  "output_pdf_path": "/absolute/path/zones_review.pdf",
  "zone_count": 42,
  "human_only_count": 3
}
```

Why this matters:

For flat scans, text-only review is insufficient. A visual overlay is necessary before deterministic filling.

---

### 4. `export_flat_zone_map`

Purpose:

Write the detected flat-form zone map to JSON so Claude and the user can review or edit it.

Input:

```json
{
  "pdf_path": "/absolute/path/form.pdf",
  "output_json_path": "/absolute/path/flat_zone_map.json",
  "overwrite": false
}
```

Output should include:

```json
{
  "server_version": "0.x.x",
  "pdf_sha256": "...",
  "pdf_size_bytes": 123456,
  "pdf_mtime": "...",
  "coordinate_system": "pdf_points",
  "pages": []
}
```

Rules:

- Refuse overwrite unless `overwrite=true`.
- Include PDF identity metadata.
- Do not modify the PDF.

---

### 5. `overlay_text_on_pdf`

Purpose:

Apply deterministic text/checkmark overlays to a flat PDF after human review.

Input:

```json
{
  "pdf_path": "/absolute/path/form.pdf",
  "output_pdf_path": "/absolute/path/filled_overlay.pdf",
  "expected_pdf_sha256": "...",
  "overlays": [
    {
      "zone_id": "page1_zone_003",
      "page_number": 1,
      "x": 170,
      "y": 407,
      "width": 130,
      "height": 16,
      "text": "01/15/1950",
      "font_size": 10,
      "align": "left",
      "max_width": 130
    }
  ],
  "dry_run": true
}
```

Behavior:

- Requires explicit coordinates.
- Requires `expected_pdf_sha256` if the values were proposed from a prior zone map.
- Rejects human-only zones.
- Rejects unknown `zone_id` if a zone map is supplied.
- Supports `dry_run`.
- Never overwrites input.
- Backs up existing output.
- Writes atomically.
- Does not apply signatures.
- Does not fill initials, certifications, attestations, or signing dates.

Dry-run output:

```json
{
  "dry_run": true,
  "would_overlay": [
    {
      "zone_id": "page1_zone_003",
      "page_number": 1,
      "text": "01/15/1950",
      "bbox": { "x": 170, "y": 407, "width": 130, "height": 16 }
    }
  ],
  "blocked_human_only_zones": []
}
```

---

## Safety Model for Flat Scans

Flat-scan support should be more conservative than AcroForm support.

### Required Rules

1. Candidate zones are never exact fields.
2. All detected zones are review-required.
3. Human-only zones are blocked from overlay.
4. Signature, initials, attestation, certification, and signing-date zones are never filled.
5. Ordinary data dates may be filled only after review.
6. Every overlay must be coordinate-explicit.
7. The tool must produce a dry-run diff before writing.
8. The final write must be deterministic and local.
9. The input PDF must never be overwritten.
10. Output writes must be atomic.
11. PDF identity metadata must be included in all zone maps and fill requests.
12. No network calls.
13. No cloud OCR or external LLM APIs.
14. No automatic submission or signing.

---

## Recommended Implementation Phases

### Phase 1 — Detection and Review Only

Add:

```text
ocr_pdf_to_searchable_pdf
detect_flat_form_zones
render_flat_form_zones
export_flat_zone_map
```

Do not add overlay filling yet.

Goal:

Produce a reviewable zone map and visual overlay PDF.

Success criteria:

- Can detect labels and likely blank zones on simple scanned forms.
- Can detect likely checkboxes.
- Can flag signature/attestation areas.
- Can export JSON.
- Can render a visual review artifact.

---

### Phase 2 — Deterministic Overlay Dry Run

Add:

```text
overlay_text_on_pdf(dry_run=true)
```

Goal:

Allow Claude to propose overlays, but only return what would be written.

Success criteria:

- Rejects unknown zone IDs.
- Rejects human-only zones.
- Preserves PDF identity checks.
- Produces a clear diff table.
- Writes nothing in dry-run mode.

---

### Phase 3 — Deterministic Overlay Write

Enable:

```text
overlay_text_on_pdf(dry_run=false)
```

Goal:

Write reviewed overlays to a new PDF.

Success criteria:

- Input PDF is never overwritten.
- Existing output is backed up.
- Output is written atomically.
- Human-only zones remain blocked.
- Text overlays are visually aligned.
- No signatures are applied.

---

### Phase 4 — Optional Enhancements

Only after the core workflow is safe:

```text
highlight confidence scores
interactive zone correction
checkbox mark rendering
multi-page template reuse
redacted fixture tests
layout model integration
```

Avoid adding:

```text
automatic signing
automatic attestation
cloud OCR
cloud layout parsing
URL ingestion
profile reuse without PDF hash checks
bulk flat-scan filling
```

---

## Suggested Data Model

### Flat Zone

```ts
type FlatZone = {
  zone_id: string;
  page_number: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  nearby_label: string | null;
  field_type_guess:
    | "text"
    | "date"
    | "number"
    | "checkbox"
    | "radio"
    | "signature"
    | "initials"
    | "attestation"
    | "unknown";
  confidence: number;
  needs_review: true;
  is_human_only: boolean;
  human_only_reason?: string;
  notes: string[];
};
```

### Overlay

```ts
type Overlay = {
  zone_id?: string;
  page_number: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text: string;
  font_size?: number;
  align?: "left" | "center" | "right";
  max_width?: number;
};
```

### Flat Zone Map

```ts
type FlatZoneMap = {
  server_version: string;
  pdf_sha256: string;
  pdf_size_bytes: number;
  pdf_mtime: string;
  coordinate_system: "pdf_points";
  pages: Array<{
    page_number: number;
    width: number;
    height: number;
    zones: FlatZone[];
  }>;
};
```

---

## Test Plan

### Unit Tests

Add synthetic flat PDFs/images with:

- blank underline field
- boxed text field
- checkbox group
- radio-like checkbox group
- signature line
- signing date line
- ordinary data date line
- skewed scan
- rotated page
- multi-page form

### Integration Tests

Use a small scanned test fixture with no AcroForm fields.

Expected behavior:

```text
list_pdf_fields → field_count = 0
detect_flat_form_zones → candidate zones found
render_flat_form_zones → review PDF created
overlay_text_on_pdf dry_run=true → diff returned, no file written
overlay_text_on_pdf dry_run=false → new PDF written, input unchanged
```

### Safety Tests

Confirm rejection for:

- relative paths
- paths outside `ALLOWED_DIRS`
- unknown zone IDs
- human-only zones
- stale `expected_pdf_sha256`
- overwrite without backup
- signature overlays
- attestation/certification overlays
- signing-date overlays

---

## Recommended Claude Code Prompt

```text
Extend the existing pdf-field-filler project with a separate flat-scan mode.

Do not weaken or alter the existing AcroForm tools:
- list_pdf_fields
- validate_pdf_fill
- fill_pdf_fields
- export_pdf_field_map

Add flat-scan tools as a separate workflow:
1. ocr_pdf_to_searchable_pdf
2. detect_flat_form_zones
3. export_flat_zone_map
4. render_flat_form_zones
5. overlay_text_on_pdf

Hard constraints:
- local only
- no network calls
- no external LLM APIs
- no cloud OCR
- no signatures
- no initials
- no attestation/certification checks
- no signing/execution dates
- never overwrite the input PDF
- all output writes must be atomic
- all paths must be absolute and inside ALLOWED_DIRS
- every response must include PDF identity metadata where relevant
- every detected flat-scan zone must be needs_review=true
- all overlays must be explicit coordinate overlays

Implementation guidance:
- Use OCRmyPDF as an optional local subprocess for OCR preprocessing.
- Return a structured error if OCRmyPDF is not installed.
- Use pdfjs-dist or another local renderer to render pages if needed.
- Use simple deterministic heuristics first for detecting blank lines, boxes, OCR labels, and checkboxes.
- Do not attempt fully automatic flat-form filling in v1.
- First deliver detection, JSON export, and visual review PDFs.
- Add deterministic overlay writing only after dry-run review is working.

Required tests:
- flat PDF with zero AcroForm fields
- OCR preprocessing missing dependency error
- candidate zone detection
- visual zone rendering
- zone map export
- dry-run overlay
- stale PDF hash rejection
- human-only zone rejection
- atomic output write
- input PDF unchanged
```

---

## Bottom Line

Flat-scan support is feasible, but it should not be treated like AcroForm filling.

The right safety distinction is:

```text
AcroForm fields: exact internal field names can be filled after validation.
Flat scans: only reviewed coordinates can be overlaid.
```

The next useful feature is not “fill scanned PDFs automatically.” It is:

```text
detect candidate zones → render a visual review map → export JSON
```

Once that is reliable, deterministic overlay writing can be added safely.
