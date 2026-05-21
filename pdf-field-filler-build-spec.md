> **Historical document.** This is the original build specification used to
> bootstrap the project. The implementation has evolved since: the live API,
> error codes, response shapes, and safety guarantees are documented in
> [README.md](README.md) and [SECURITY.md](SECURITY.md). Use those for
> current behavior; treat this file as archaeology. Notable departures from
> the spec below: `safe_to_fill` boolean on `validate_pdf_fill`,
> `READ_ONLY_FIELDS` error code, `expected_pdf_sha256` on `fill_pdf_fields`,
> the `export_pdf_field_map` tool, PDF identity metadata on every response,
> XFA detection, `MaxLen` enforcement, and a 100 MB file-size cap.

# Build Spec: `pdf-field-filler` MCP Server

Build a local MCP server in **TypeScript** using `@modelcontextprotocol/sdk` called **`pdf-field-filler`**.

## Purpose

This server lets Claude Desktop safely inspect and fill fillable AcroForm PDFs. It is **deterministic local plumbing only**. The LLM proposes values in chat; the server validates exact field names and legal options, then fills. The human signs manually.

## Core Architecture

```
PDF → extract exact AcroForm field map → Claude proposes structured JSON values →
server validates exact field names and legal options → deterministic fill →
human signs manually
```

The model proposes. Deterministic code decides. The human signs.

## Hard Constraints

- **No network.** No external APIs, telemetry, OpenAI/Anthropic calls, or cloud services. Read/write local files only.
- All paths must be absolute local paths inside allowed directories.
- Never fill signature, initials, attestation, certification, or signing/execution-date fields.
- Never flatten the PDF by default. Never apply signatures. Never check attestation/certification boxes.

## Stack

- TypeScript, Node.js
- `@modelcontextprotocol/sdk`, stdio transport
- `pdf-lib` as the primary PDF library, with low-level object inspection for widget annotations, field flags, page numbers, rectangles, and checkbox/radio appearance states
- `zod` for tool input validation
- `vitest` or `node:test` for tests
- Built JS entrypoint at `dist/index.js` (not ts-node)

---

## Tool 1: `list_pdf_fields`

**Input:** `{ "pdf_path": string }`

**Behavior:**
- `pdf_path` must be an absolute local path inside allowed directories; refuse otherwise.
- Load the PDF and return every AcroForm field with exact internal names. Never guess names.
- If the PDF has no AcroForm fields, return:
  ```json
  {
    "has_fields": false,
    "field_count": 0,
    "message": "This PDF has zero AcroForm fields. It may be a flat scan or non-fillable PDF."
  }
  ```

**For each field, return:**
```json
{
  "name": "string",
  "type": "text | checkbox | radio | dropdown | option_list | button | signature | unknown",
  "current_value": "string | boolean | string[] | null",
  "options": ["string"],
  "max_length": "number | null",
  "is_required": "boolean",
  "is_read_only": "boolean",
  "is_signature_field": "boolean",
  "is_human_only": "boolean",
  "page_number": "number | null",
  "rect": { "x": 0, "y": 0, "width": 0, "height": 0 },
  "widgets": [
    { "page_number": "number | null", "rect": { "x": 0, "y": 0, "width": 0, "height": 0 } }
  ]
}
```

**Implementation details:**
- Determine type from the AcroForm field class and underlying PDF field type.
- Extract `page_number` and `rect` by traversing field widget annotations. If a field has multiple widgets, include all widgets and set top-level `page_number`/`rect` to the first widget.

**Required / read-only flags:**
- Do not rely only on pdf-lib high-level APIs. Read the `/Ff` flag integer from the raw AcroForm field dictionary when available:
  - ReadOnly = bit position 1
  - Required = bit position 2
- If `/Ff` cannot be read, return `false` for that flag and include a note: `"Field flags could not be read; defaulted to false."`

**Checkbox and radio current values:**
- `current_value` must be the selected export value, not a raw pdf-lib object.
- The selected state is the `/AP /N` appearance-state name that is not `"Off"`.
- Exclude `"Off"` from user-selectable `options` unless explicitly clearing a field.
- For radio groups, return the selected export value for the group.
- For unchecked checkboxes, return `false` or `null` consistently.

**Human-only detection — mark a field human-only if:**
- type is signature, OR
- name contains: `sign`, `signature`, `initial`, `initials`, `attest`, `attestation`, `certif`, `certification`, OR
- name indicates a signing/execution date: `signed`, `date_signed`, `signature_date`, `executed`, `execution_date`, OR
- the field appears to be part of a signature, initials, attestation, certification, or execution section, OR
- the field appears to be an attestation/certification checkbox.

**Do NOT mark ordinary data dates as human-only** solely because the name contains "date". Ordinary data dates (date of birth, birth date, date of death, service date, claim date, coverage date, employment date, incident date, diagnosis date, treatment date) are fillable but must be `needs_review: true`.

---

## Tool 2: `validate_pdf_fill`

**Input:** `{ "pdf_path": string, "field_values": Record<string, unknown> }`

**Behavior:**
- Validate `pdf_path`. Load the actual field map from the PDF.
- Reject unknown field names. Do not fuzzy-match. Do not silently drop.
- Validate values against field type:
  - text: string or number accepted, converted to string for review
  - checkbox: boolean or a legal option string
  - radio: legal option string only
  - dropdown / option_list: legal option string only unless options are empty
  - signature / human-only: never fill; always `needs_review: true`
- Return a review table, not a modified PDF.

**Return:**
```json
{
  "valid": "boolean",
  "unknown_fields": ["string"],
  "illegal_values": [
    { "field_name": "string", "proposed_value": "unknown", "reason": "string", "legal_options": ["string"] }
  ],
  "review": [
    {
      "field_name": "string",
      "proposed_value": "unknown",
      "field_type": "string",
      "current_value": "unknown",
      "legal_options": ["string"],
      "is_signature_field": "boolean",
      "is_human_only": "boolean",
      "is_required": "boolean",
      "needs_review": "boolean",
      "review_reason": "string"
    }
  ]
}
```

**`needs_review` must be true if:**
- field is signature-related
- field is human-only
- field is empty
- field is any date field, including ordinary data dates
- field is an attestation/certification checkbox
- proposed value differs from a non-empty current value
- value has an illegal option/type

---

## Tool 3: `fill_pdf_fields`

**Input:** `{ "pdf_path": string, "output_path": string, "field_values": Record<string, unknown>, "dry_run": boolean }`

**Behavior:**
- `pdf_path` and `output_path` must be absolute local paths inside allowed directories.
- `output_path` must differ from `pdf_path`. Never overwrite the input PDF.
- If `output_path` already exists, create a timestamped backup before writing.
- Load the actual field map. Validate all keys exactly; if any unknown key exists, reject the whole operation.
- Validate legal values for checkbox/radio/dropdown fields.
- **Never fill human-only fields** (signature, initials, attestation, certification, signing/execution dates, or any name containing `sign`, `signature`, `initial`, `initials`, `attest`, `attestation`, `certif`, `certification`, `signed`, `date_signed`, `signature_date`, `executed`, `execution_date`). If `field_values` contains any human-only field, reject the whole operation and return them as `blocked_human_only_fields`.
- If `dry_run` is true, return a diff table and write no file.
- If `dry_run` is false, fill only validated, non-human-only fields and save to `output_path`.
- Do not flatten by default. Do not apply signatures. Do not check attestation/certification boxes.

**Return (dry_run):**
```json
{
  "dry_run": true,
  "would_write": [ { "field_name": "string", "field_type": "string", "from": "unknown", "to": "unknown" } ],
  "blocked_human_only_fields": ["string"],
  "unknown_fields": ["string"],
  "illegal_values": []
}
```

**Return (actual fill):**
```json
{
  "dry_run": false,
  "output_path": "string",
  "backup_path": "string | null",
  "written": [ { "field_name": "string", "field_type": "string", "from": "unknown", "to": "unknown" } ],
  "blocked_human_only_fields": [],
  "unknown_fields": [],
  "illegal_values": []
}
```

---

## Path Security

- Read `ALLOWED_DIRS` from `process.env.ALLOWED_DIRS` as a comma-separated list.
- If missing or empty, default to `~/Downloads` and `~/Documents`.
- Expand `~` to the user home directory.
- Resolve symlinks with `fs.realpath` where possible.
- Refuse any path outside allowed dirs. Refuse relative paths. Return clear errors.

---

## README

Write a README that includes: install steps, build steps, how to run locally, how to add to Claude Desktop via `claude_desktop_config.json` (using the built `dist/index.js` entrypoint, not ts-node), how to set `ALLOWED_DIRS`, the need to restart Claude Desktop, and the safety model (model proposes, server validates, human signs).

---

## Testing

**Unit tests** must use synthetic AcroForm fixture PDFs built in-memory (text, checkbox, radio group with multiple widgets, dropdown, signature-named field, ordinary data date, signing-date). No external file dependencies.

**Integration test (optional):** point the CLI's `inspect` command at a real fillable PDF and confirm:
- field count is plausible (and report whether multi-widget radio/checkbox groups were collapsed or signature widgets counted separately if the count differs from expectation)
- human-only fields are correctly flagged
- `validate_pdf_fill` returns `valid: true` for safe text fields and marks `needs_review: true` when proposed values differ from non-empty current values
- `fill_pdf_fields` with `dry_run: true` returns a clean diff and writes no file

Never write a filled PDF during automated testing. Never sign anything. Never check attestation/certification boxes.
