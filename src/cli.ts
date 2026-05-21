#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { listPdfFields } from "./tools/list.js";
import { validatePdfFill } from "./tools/validate.js";
import { fillPdfFields } from "./tools/fill.js";
import { exportPdfFieldMap } from "./tools/export.js";
import { toErrorPayload } from "./errors.js";

function usage(): never {
  process.stderr.write(
    `Usage:
  pdf-field-filler inspect <pdf_path>
  pdf-field-filler validate <pdf_path> <values.json>
  pdf-field-filler dry-run <pdf_path> <output_path> <values.json>
  pdf-field-filler fill <pdf_path> <output_path> <values.json>
  pdf-field-filler export-map <pdf_path> <output_json_path> [--overwrite]
`
  );
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  try {
    if (cmd === "inspect") {
      const [p] = rest;
      if (!p) usage();
      const r = await listPdfFields({ pdf_path: p });
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    if (cmd === "validate") {
      const [p, vp] = rest;
      if (!p || !vp) usage();
      const field_values = JSON.parse(readFileSync(vp, "utf8")) as Record<string, unknown>;
      const r = await validatePdfFill({ pdf_path: p, field_values });
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    if (cmd === "dry-run" || cmd === "fill") {
      const [p, op, vp] = rest;
      if (!p || !op || !vp) usage();
      const field_values = JSON.parse(readFileSync(vp, "utf8")) as Record<string, unknown>;
      const r = await fillPdfFields({
        pdf_path: p,
        output_path: op,
        field_values,
        dry_run: cmd === "dry-run",
      });
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    if (cmd === "export-map") {
      const [p, op, flag] = rest;
      if (!p || !op) usage();
      const r = await exportPdfFieldMap({
        pdf_path: p,
        output_json_path: op,
        overwrite: flag === "--overwrite",
      });
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    usage();
  } catch (err) {
    const payload = toErrorPayload(err);
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(1);
  }
}

main();
