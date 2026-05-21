# Security model

`pdf-field-filler` is local plumbing for an LLM-driven form-filling workflow. Its safety guarantees rest on a deliberate split of responsibilities:

> **The model proposes. Deterministic code decides. The human signs.**

## Guarantees

- **No network.** The server makes no outbound HTTP calls and has no telemetry. It reads and writes local files only.
- **Sandboxed filesystem.** All file paths must be absolute and resolve inside `ALLOWED_DIRS` (defaults to `~/Downloads` and `~/Documents`). Symlinks are resolved before the check. Relative paths and paths outside the allow-list are refused with `PATH_NOT_ALLOWED`.
- **Never overwrites input.** `output_path` must differ from `pdf_path`, and a symlink at `output_path` is realpath-checked so it cannot resolve back to the input or outside `ALLOWED_DIRS`.
- **Crash-safe writes.** Order of operations: serialize → write temp + `fsync` → rename existing output to `<output_path>.backup.<YYYYMMDD-HHMMSS>` → atomic rename temp → output. The temp file is durable on disk before the original is moved aside, so a crash between backup-rename and publish-rename leaves the data preserved at `backup_path` rather than nowhere. If the publish-rename itself fails, the server auto-rolls-back by renaming the backup back to `output_path` and reports `rollback_attempted` / `rollback_succeeded` / `original_error` / `rollback_error` on the failure payload.
- **Never fills human-only fields.** Signature, initials, attestation, certification, and signing/execution-date fields are detected by both PDF field type and token-level name matching, and are rejected from `fill_pdf_fields` with `HUMAN_ONLY_FIELDS`. They appear in `validate_pdf_fill` reviews so a human can confirm the form is otherwise complete, but the server will not write them.
- **Never flattens.** `fill_pdf_fields` saves without flattening. Fields remain editable post-fill so a human can still review and sign.
- **Atomic rejection.** If any field name is unknown, any value is illegal, or any field is human-only, the entire fill operation is rejected before any write. Partial fills are impossible.
- **Encrypted PDFs are refused** with a structured `PDF_ENCRYPTED` error. The server does not attempt to decrypt or crack passwords.

## Threat model

The server assumes the LLM may propose:
- field names that don't exist
- values that violate field type or option constraints
- values for fields the human should review (signatures, dates, attestations)

It does **not** assume the LLM is adversarial about file paths. The user supplies `ALLOWED_DIRS` and is expected to scope it to directories whose contents they consent to expose. If you let an untrusted process choose `pdf_path`, the server protects you from path traversal but not from the consequences of the user having put sensitive PDFs inside `ALLOWED_DIRS`.

## Reporting

If you find a way to bypass any of the above, please open a private GitHub security advisory rather than a public issue.
