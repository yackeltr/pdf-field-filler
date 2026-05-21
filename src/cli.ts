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
  pdf-field-filler dry-run <pdf_path> <output_path> <values.json> [--expected-sha256 <hex>]
  pdf-field-filler fill <pdf_path> <output_path> <values.json> [--expected-sha256 <hex>]
  pdf-field-filler export-map <pdf_path> <output_json_path> [--overwrite]
`
  );
  process.exit(2);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function rejectExtras(args: string[]): void {
  if (args.length === 0) return;
  process.stderr.write(`Unexpected argument(s): ${args.join(" ")}\n`);
  usage();
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
      const argsCopy = [...rest];
      const expected = takeFlag(argsCopy, "--expected-sha256");
      const [p, op, vp, ...extras] = argsCopy;
      if (!p || !op || !vp) usage();
      rejectExtras(extras);
      const field_values = JSON.parse(readFileSync(vp, "utf8")) as Record<string, unknown>;
      const r = await fillPdfFields({
        pdf_path: p,
        output_path: op,
        field_values,
        dry_run: cmd === "dry-run",
        expected_pdf_sha256: expected,
      });
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    if (cmd === "export-map") {
      const argsCopy = [...rest];
      const overwrite = takeBoolFlag(argsCopy, "--overwrite");
      const [p, op, ...extras] = argsCopy;
      if (!p || !op) usage();
      rejectExtras(extras);
      const r = await exportPdfFieldMap({
        pdf_path: p,
        output_json_path: op,
        overwrite,
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
