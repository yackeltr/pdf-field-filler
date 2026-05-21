# Roadmap

Internal planning. Each item below traces to either an audit finding or
a deliberate scope boundary. GitHub issues track the actionable ones with
the `deferred` label; this file gives the structural view.

## Architecture boundaries (not bugs)

These define what the server intentionally does **not** do. They are
documented in [README.md](README.md#known-limitations) and
[SECURITY.md](SECURITY.md) and are unlikely to change.

- **No XFA mutation.** XFA streams are detected and reported but never
  parsed or written.
- **No flattening or signing.** Filled PDFs remain editable; the human
  signs.
- **No network.** Local files only.
- **Path-sandboxed.** All reads/writes are constrained to `ALLOWED_DIRS`.
- **Single-user / sequential.** Concurrent fills to the same output are
  not isolated; the use case is one operator at a time.
- **pdf-lib is the trust boundary** for parsing. A pdf-lib vulnerability
  affects this server; operators should track pdf-lib advisories.

## Near-term (next round)

### P1 — Highest divergence risk
- [ ] **Unify validation logic.** `checkValueAgainstField` (validate.ts)
  and `validateLegalValue` (fill.ts) duplicate per-field-type rules with
  subtly different return shapes. Extract to `src/validation.ts`;
  guarantee `validate.safe_to_fill: true` always implies `fill` accepts.
  → [#1](https://github.com/yackeltr/pdf-field-filler/issues/1)

## Medium-term (P2)

### Coverage gaps
- [ ] Unit tests for `src/paths.ts` → [#3](https://github.com/yackeltr/pdf-field-filler/issues/3)
- [ ] Corrupt + encrypted PDF fixtures → [#5](https://github.com/yackeltr/pdf-field-filler/issues/5)
- [ ] Test temp-dir cleanup → [#4](https://github.com/yackeltr/pdf-field-filler/issues/4)
- [ ] CI matrix: add Node 18 → [#6](https://github.com/yackeltr/pdf-field-filler/issues/6)

### Tooling
- [ ] ESLint + `@typescript-eslint` + CI gate → [#7](https://github.com/yackeltr/pdf-field-filler/issues/7)
- [ ] Auto-generate MCP tool JSON Schemas from Zod → [#8](https://github.com/yackeltr/pdf-field-filler/issues/8)
- [ ] `tsconfig.test.json` for tests type-checking → [#10](https://github.com/yackeltr/pdf-field-filler/issues/10)

### Robustness
- [ ] SIGTERM/SIGINT cleanup of in-flight temp files → [#9](https://github.com/yackeltr/pdf-field-filler/issues/9)
- [ ] `export_pdf_field_map` path privacy (opt-in) → [#2](https://github.com/yackeltr/pdf-field-filler/issues/2)

## Longer-term (P3 / documentation)

- [ ] CONTRIBUTING.md (clone, build, test, contribution flow, "no
  external test PDFs" rule).
- [ ] Move `pdf-field-filler-build-spec.md` to `docs/` and link it from
  CONTRIBUTING.md as architectural context.
- [ ] README "Platform notes" for Linux/Windows Claude Desktop config → [#12](https://github.com/yackeltr/pdf-field-filler/issues/12)
- [ ] Directory `fsync` after atomic rename → [#11](https://github.com/yackeltr/pdf-field-filler/issues/11)
- [ ] CHANGELOG-driven release workflow: `gh release create` + npm
  publish dry-run on every push to a release branch.

## Considered and rejected

- **In-process LRU cache for field maps keyed by (path, sha256).**
  Optimization, not a correctness fix. The single-buffer read is already
  cheap enough for the interactive workflow; caching adds invalidation
  surface for no measurable benefit.
- **Heterogeneous-checkbox support via a pdf-lib upstream PR.** Worth
  doing in principle but the maintainer's stance on per-widget exports
  is unclear; the direct `/V` write workaround is documented and pinned
  by tests, so this is low priority.
- **Replacing pdf-lib.** Examined `hummus-recipe`, `pdfkit`, `mupdf-js`;
  none have comparable AcroForm read/write surface. Re-evaluate annually.
