# Changelog

All notable changes to `pdf-field-filler` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

External audit (v0.3.1) + follow-up reviews. The third review found a
distribution-breaking bug and three behavioral divergences from the
documented safety model; all fixed.

### Fixed (third-review findings — distribution-critical)
- **`.mcpb` bundle no longer crashes at install-time startup.** The previous
  build read `package.json` via `import.meta.url + ../../` at module load,
  which works in the dev tree but resolves outside the extracted bundle to
  a path that doesn't exist. Verified by extracting to `/tmp` and confirming
  the bundle threw `ENOENT: no such file or directory, open '/tmp/package.json'`.
  Fix: `scripts/build-mcpb.mjs` now injects the version into the bundled
  artifact via `esbuild --define:__BUILD_TIME_VERSION__='"<version>"'`, and
  rewrites `manifest.json` in the dist folder to match `package.json` at
  build time. Dev tree retains the runtime read with a try/catch fallback.
- **`safe_to_fill ⇒ fill accepts` violated for unknown-type fields.** A
  field with `/T` but no resolvable `/FT` extracted as `type: "unknown"`,
  and `validate.checkValueAgainstField`'s default branch returned
  `{ normalized: proposed }` (no `illegal`), so `safe_to_fill: true`.
  Meanwhile `fill.validateLegalValue`'s default branch correctly rejected
  with `ILLEGAL_VALUES`. The invariant pin didn't catch this because no
  fixture built an FT-less field. Fix: validate's default branch now
  returns the same `illegal` shape fill does. New fixture
  `buildUnknownTypePdf` + tests for both sides.
- **`fill_pdf_fields` did not honor the "never mutates XFA" guarantee.**
  SECURITY.md and README claim the server never writes XFA streams, but
  fill's prior path went straight to `doc.getForm()` and `doc.save()` on a
  mixed AcroForm+XFA PDF — and pdf-lib's save path can drop or rewrite
  `/XFA` when AcroForm fields are touched. New `XFA_PRESENT` error code;
  fill now refuses any PDF with `has_xfa: true`. Read-side tools (list,
  validate, export) remain available because they never serialize.

### Fixed (third-review findings — lower-severity)
- **Degenerate checkbox.** `fill` with `boolean true` on a checkbox whose
  `/AP/N` couldn't be read previously wrote `/V = "Yes"` while every widget
  ended up with `/AS = Off` — a logically-checked, visually-unchecked
  field. Both validate and fill now reject this case with a clear reason.
- **`toErrorPayload` no longer mislabels non-domain throws as
  `PDF_PARSE_ERROR`.** A `TypeError` anywhere previously surfaced to the
  caller as a parse problem, pointing them at the file instead of the
  code. New `INTERNAL_ERROR` code for unexpected catch-all throws;
  `ZodError` continues to map to `INVALID_INPUT`, domain errors continue
  to map to their specific codes.
- **`__setRenameImplForTests` now refuses production calls.** Throws unless
  `process.env.VITEST` is set or `NODE_ENV === "test"`. The hook is still
  exported (vitest discovers it via ESM import), but the mutable-rebind
  seam is no longer reachable from a production runtime.
- **`manifest.json` version drift closed.** `scripts/build-mcpb.mjs` now
  rewrites the manifest's `version` from `package.json` at build time.

### Added (review-round follow-ups)
- **P0 verification pinned.** Heterogeneous-checkbox field-level `/V`
  survives `doc.save({ updateFieldAppearances: true })` — the direct-write
  bypass of `PDFAcroCheckBox.setValue` is not clobbered by appearance regen.
  Asserted on top of the existing per-widget `/AS` render test.
- **`safe_to_fill ⇒ fill accepts` invariant pin** (7 representative cases
  across text, dropdown, dropdown-pairs, radio, heterogeneous checkbox,
  data date, MaxLen boundary). Catches future divergence between
  `validate.checkValueAgainstField` and `fill.validateLegalValue` at
  runtime, until the unification in issue #1 lands.
- **Rollback path now exercised.** `fill.ts` exposes a module-private
  `__setRenameImplForTests` so tests can inject a `renameSync` that
  succeeds on backup-rename, fails on publish-rename, and either
  succeeds or fails on rollback. Pinned both branches:
  `rollback_succeeded: true` (backup restored, original bytes intact, no
  stray temp file) and `rollback_succeeded: false` (rollback_error
  surfaced).
- **`mkdtempSyncWrap`** now uses ESM `import { mkdtempSync }` instead of
  the previous `require()` interop.
- **Encoding intent documented** between `buildXfaPdf` (PDFHexString) and
  `buildMixedXfaPdf` (PDFString) — divergence is deliberate, covers both
  textual encodings of `/XFA`.

### Changed (review-round follow-ups)
- `SECURITY.md` write-ordering description corrected: serialize → temp +
  fsync → backup-rename → publish-rename, with auto-rollback on
  publish-rename failure. The previous text incorrectly described
  backups as happening "before a write."
- `pdf-field-filler-build-spec.md` now opens with a banner noting it is
  historical context, not current API documentation; lists known
  departures (`safe_to_fill`, `READ_ONLY_FIELDS`, `expected_pdf_sha256`,
  `export_pdf_field_map`, identity metadata, XFA detection, `MaxLen`,
  100 MB cap).

### Removed (review-round follow-ups)
- Dead helper `asNumber` in `src/fields.ts` (defined, never called).

### Added
- **Cycle / depth guard** in `walkFields` — a circular AcroForm tree
  (`A.Kids = [B]`, `B.Kids = [A]`) no longer overflows the stack. Caps:
  `MAX_FIELD_TREE_DEPTH = 64`, `MAX_FIELD_NODES = 100_000`. (P0-1)
- **File-size cap** in `readPdfWithIdentity` (`PDF_TOO_LARGE` error code,
  default 100 MB, overridable via `PDF_FIELD_FILLER_MAX_BYTES`). Prevents
  OOM on adversarial or accidentally-huge input. (P0-2)
- **MaxLen enforcement** in both `validate_pdf_fill` and `fill_pdf_fields`.
  Text values exceeding `field.max_length` now reject as `ILLEGAL_VALUES`
  and clear `safe_to_fill`. (P1-2)
- Shared `timestamp()` helper in `src/utils.ts` (P1-5).
- `SERVER_VERSION` derived from `package.json` at module load — release-time
  version drift between manifest and code is no longer possible (P1-6).
- `rejectExtras` enforced on `dry-run` and `fill` CLI commands; typos in
  trailing args fail with usage rather than disappearing (P1-7).
- New tests: cycle PDF, oversize file, MaxLen boundaries, ZodError → INVALID_INPUT,
  SERVER_VERSION matches package.json. Total: 74 → 81.

### Changed
- `toErrorPayload` now classifies a `ZodError` as `INVALID_INPUT` instead of the
  misleading `PDF_PARSE_ERROR` (P1-1).
- `tsconfig.compilerOptions.types` restricted to `["node"]` to avoid TS2688
  on version-suffixed `@types/*` directories introduced by transitive deps.

### Removed
- `NO_ACROFORM_FIELDS` error code (never thrown — a PDF with zero fields is
  a documented success response with `has_fields: false`). Removed from
  `ErrorCode` and README error list (P1-4).

### Deferred (tracked in GitHub Issues)
- **P1-3** unify validate / fill validation logic → [#1](https://github.com/yackeltr/pdf-field-filler/issues/1)
- **P2-1** `export_pdf_field_map` path privacy → [#2](https://github.com/yackeltr/pdf-field-filler/issues/2)
- **P2-2** unit tests for `src/paths.ts` → [#3](https://github.com/yackeltr/pdf-field-filler/issues/3)
- **P2-4** test temp directory cleanup → [#4](https://github.com/yackeltr/pdf-field-filler/issues/4)
- **P2-5/6** corrupt + encrypted PDF fixtures → [#5](https://github.com/yackeltr/pdf-field-filler/issues/5)
- **P2-7** Node 18 in CI matrix → [#6](https://github.com/yackeltr/pdf-field-filler/issues/6)
- **P2-8** ESLint + Prettier → [#7](https://github.com/yackeltr/pdf-field-filler/issues/7)
- **P2-9** auto-generate MCP tool schemas from Zod → [#8](https://github.com/yackeltr/pdf-field-filler/issues/8)
- **P2-10** SIGTERM/SIGINT temp cleanup → [#9](https://github.com/yackeltr/pdf-field-filler/issues/9)
- **P3-2** tsconfig.test.json → [#10](https://github.com/yackeltr/pdf-field-filler/issues/10)
- **P3-4** dir fsync after rename → [#11](https://github.com/yackeltr/pdf-field-filler/issues/11)
- **P3-8** Linux/Windows Claude Desktop docs → [#12](https://github.com/yackeltr/pdf-field-filler/issues/12)

## [0.3.1] — 2026-05-21

Version bump labeling the build with the v0.3.0 follow-ups (single-read across
all tools, removal of path-based loaders, heterogeneous-checkbox direct `/V`
write, per-widget `/AS` pin). Behavior unchanged from the prior commit; this
release exists to give the bundle a coherent version.

## [0.3.0] — 2026-05-21

### Added
- `safe_to_fill` flag on `validate_pdf_fill`, distinct from `valid`. Signature,
  human-only, read-only, attestation/certification, and signing-date fields
  now clear `safe_to_fill` even when the request is structurally valid.
- `READ_ONLY_FIELDS` error code — `fill_pdf_fields` now rejects atomically if
  any supplied field is read-only, instead of silently skipping.
- Auto-rollback on `fill_pdf_fields` final-rename failure: the backup is
  renamed back to `output_path`. Response reports `rollback_attempted`,
  `rollback_succeeded`, `original_error`, and `rollback_error`.
- Heterogeneous-checkbox support: each widget's `/AS` is paired with its own
  `/AP/N` keys via `applyBtnExport`. `/V` is written directly to the field
  dict to bypass pdf-lib's single-on-state validation, which rejects spec-
  valid heterogeneous selections.
- `--overwrite` accepted in any position on the `export-map` CLI; unknown
  trailing positional args rejected.
- 16 new tests covering: per-widget `/AS` for radio and heterogeneous
  checkbox, read-only blocking, `safe_to_fill` across all blocking-field
  categories, mixed XFA + AcroForm, identity in all responses,
  `expected_pdf_sha256` match/mismatch, atomic fill (input untouched, no
  temp leftovers), explicit fd-snapshot identity.

### Changed
- `list_pdf_fields`, `validate_pdf_fill`, and `export_pdf_field_map` now use
  the same single-read pattern as `fill_pdf_fields`:
  `readPdfWithIdentity` → `loadPdfFromBytes` → `extractFieldsFromDoc`.
  Closes the two-read TOCTOU shape uniformly across all tools.
- Path-based loaders (`extractFields(path)`, `loadPdf(path)`, `readPdfFile`,
  `pdfIdentity(path)`) removed from the export surface entirely; a
  path-based re-read is now unrepresentable in the tools' import scope.
- `applyBtnExport` documents the per-widget `/AS` contract for both
  homogeneous and heterogeneous cases.

### Fixed
- Heterogeneous-checkbox write bug: `PDFAcroCheckBox.setValue` rejected
  spec-valid per-widget export names. Now bypassed via direct `/V` write.

## [0.2.0] — 2026-05-21

### Added
- **XFA detection.** Responses include `has_xfa` and `xfa_supported`. The
  server never mutates XFA streams; mixed AcroForm+XFA PDFs are listed
  with a warning.
- **PDF identity metadata** (`pdf_sha256`, `pdf_size_bytes`, `pdf_mtime`)
  in every tool response, computed from a single fd-snapshot read so
  identity, parse, and fill all derive from the same bytes.
- **`expected_pdf_sha256`** optional input on `fill_pdf_fields`. A
  mismatch rejects with `PDF_IDENTITY_MISMATCH` before any read of the
  document body.
- **`export_pdf_field_map`** MCP tool + `export-map` CLI command. Writes
  the full field map JSON to disk with identity + `server_version`.
  Refuses to overwrite unless `overwrite: true`.
- **MCP tool annotations** (`readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint`) on all tools.
- **AcroForm attribute inheritance** with correct leaf-overrides-parent
  semantics for `/FT`, `/Ff`, `/V`, `/DV`, `/Opt`, `/MaxLen`, `/DA`.
- **Atomic output writes** via temp file + `fsync` + `rename`. Existing
  output preserved as `<output_path>.backup.<YYYYMMDD-HHMMSS>`.
- **Symlink containment** on `output_path` — a symlink pointing outside
  `ALLOWED_DIRS` or back to the input is rejected before any write.

### Changed
- `PDF_ENCRYPTED` detection is now deterministic: load with
  `ignoreEncryption: true`, then check `doc.isEncrypted` explicitly.
- `looksLikeDateField` simplified to token-only matching; `Last_Updated`
  is no longer flagged as a date.

## [0.1.0] — 2026-05-21

Initial release. Three MCP tools (`list_pdf_fields`, `validate_pdf_fill`,
`fill_pdf_fields`), `ALLOWED_DIRS` sandbox, structured error codes,
human-only field detection (signature/initials/attestation/certification/
signing-date), no flattening, no signatures, no network.
