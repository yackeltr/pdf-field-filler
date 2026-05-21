# pdf-field-filler

A local MCP server that lets Claude Desktop safely inspect and fill fillable AcroForm PDFs.

## Safety model

**The model proposes. Deterministic code decides. The human signs.**

- The LLM proposes structured field values in chat.
- This server validates exact AcroForm field names and legal options.
- The server fills only validated, non-human-only fields.
- Signature, initials, attestation/certification, and signing/execution-date fields are never filled.
- The PDF is never flattened. No signatures are ever applied.
- No network calls. No telemetry. Local files only.

## Install

```bash
git clone <this repo>
cd pdf_field_filler
npm install
npm run build
```

This produces `dist/index.js`, the MCP server entrypoint.

## Add to Claude Desktop

The config lives at:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add an entry (use the absolute path to the built `dist/index.js` and an absolute `node` binary):

```json
{
  "mcpServers": {
    "pdf-field-filler": {
      "command": "/Users/YOU/.nvm/versions/node/v24.13.1/bin/node",
      "args": ["/Users/YOU/Documents/GitHub/pdf_field_filler/dist/index.js"],
      "env": {
        "ALLOWED_DIRS": "/Users/YOU/Downloads,/Users/YOU/Documents"
      }
    }
  }
}
```

Then **fully quit and reopen Claude Desktop** (closing the window is not enough — use ⌘Q or right-click the dock icon → Quit).

## Configuration

- `ALLOWED_DIRS` — comma-separated absolute paths the server may read from and write to. Defaults to `~/Downloads` and `~/Documents` if unset. Paths outside these directories are refused with a structured error.

## Tools

### `list_pdf_fields`

Returns every AcroForm field with exact internal name, type, current value, legal options, widget rect, page number, and flags (`is_required`, `is_read_only`, `is_signature_field`, `is_human_only`).

### `validate_pdf_fill`

Validates a `{ field_name → proposed_value }` map against the real field map. Returns a review table; never modifies the PDF. Flags signature, human-only, date, and changed-value fields as `needs_review: true`.

### `fill_pdf_fields`

Fills validated, non-human-only fields and saves to `output_path`.
- `output_path` must differ from `pdf_path`.
- If `output_path` already exists, it is renamed to `<output_path>.backup.<YYYYMMDD-HHMMSS>` before writing.
- `dry_run: true` returns a diff table and writes no file.
- Any unknown field, illegal value, or human-only field rejects the whole operation atomically.
- The PDF is not flattened.

## CLI (for smoke testing outside Claude Desktop)

```bash
npm run build
node dist/cli.js inspect /absolute/path/to/form.pdf
node dist/cli.js validate /absolute/path/to/form.pdf /absolute/path/to/values.json
node dist/cli.js dry-run /absolute/path/to/form.pdf /absolute/path/to/out.pdf /absolute/path/to/values.json
node dist/cli.js fill    /absolute/path/to/form.pdf /absolute/path/to/out.pdf /absolute/path/to/values.json
```

`values.json` is a flat JSON object: `{ "FieldName": "value", ... }`.

## Tests

```bash
npm test
```

Vitest runs against synthetic in-memory fixture PDFs — no external files are required.

## Troubleshooting (Claude Desktop)

1. **Server not appearing in Claude Desktop.** Confirm the config path is exactly `~/Library/Application Support/Claude/claude_desktop_config.json`. Validate JSON syntax.
2. **`spawn ENOENT` or `command not found`.** Use absolute paths for `command` and `args`. Confirm with `which node`.
3. **Server appears but tools error immediately.** Re-run `npm run build`. Confirm `dist/index.js` exists and is current.
4. **Restart, fully.** Closing the window does not reload MCP config — Quit (⌘Q) and relaunch.
5. **Inspect Claude Desktop logs.** Logs are in `~/Library/Logs/Claude/`. Look for `mcp.log` and `mcp-server-pdf-field-filler.log`.
6. **`PATH_NOT_ALLOWED` errors.** Add the relevant directory to `ALLOWED_DIRS` in the MCP config block (not a shell env), then restart Claude Desktop.
7. **Encrypted PDF.** The server returns `PDF_ENCRYPTED` and refuses to proceed. Decrypt manually in another tool first.

## Error codes

All tool failures return a structured payload:

```json
{ "ok": false, "error_code": "…", "message": "…", "details": {} }
```

Codes: `PATH_NOT_ABSOLUTE`, `PATH_NOT_ALLOWED`, `PDF_NOT_FOUND`, `PDF_PARSE_ERROR`, `PDF_ENCRYPTED`, `NO_ACROFORM_FIELDS`, `UNKNOWN_FIELDS`, `ILLEGAL_VALUES`, `HUMAN_ONLY_FIELDS`, `OUTPUT_EQUALS_INPUT`, `OUTPUT_BACKUP_FAILED`, `WRITE_FAILED`, `INVALID_INPUT`.
