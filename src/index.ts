#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listPdfFields, ListPdfFieldsInput } from "./tools/list.js";
import { validatePdfFill, ValidatePdfFillInput } from "./tools/validate.js";
import { fillPdfFields, FillPdfFieldsInput } from "./tools/fill.js";
import { exportPdfFieldMap, ExportPdfFieldMapInput, SERVER_VERSION } from "./tools/export.js";
import { toErrorPayload } from "./errors.js";

const TOOL_LIST = [
  {
    name: "list_pdf_fields",
    description:
      "List every AcroForm field in a fillable PDF with exact internal names, types, current values, legal options, and widget locations. Read-only. Returns PDF identity (sha256, size, mtime) and an XFA detection flag.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: {
          type: "string",
          description: "Absolute local path to the PDF, inside ALLOWED_DIRS.",
        },
      },
      required: ["pdf_path"],
      additionalProperties: false,
    },
    annotations: {
      title: "List PDF fields",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "validate_pdf_fill",
    description:
      "Validate proposed field values against the actual AcroForm field map. Returns a review table without modifying the PDF. Flags signature, human-only, date, attestation/certification, and changed-value fields as needs_review. Includes PDF identity.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: {
          type: "string",
          description: "Absolute local path to the PDF, inside ALLOWED_DIRS.",
        },
        field_values: {
          type: "object",
          description: "Map of exact field name → proposed value.",
          additionalProperties: true,
        },
      },
      required: ["pdf_path", "field_values"],
      additionalProperties: false,
    },
    annotations: {
      title: "Validate PDF fill",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fill_pdf_fields",
    description:
      "Fill validated, non-human-only fields into a fillable PDF. Refuses to overwrite the input. Backs up any existing output file with a timestamped suffix. Never fills signature/initials/attestation/certification/signing-date fields. Does not flatten the PDF. Optionally enforces expected_pdf_sha256 to detect input drift.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Absolute local path to the input PDF." },
        output_path: { type: "string", description: "Absolute local path for the filled output. Must differ from pdf_path." },
        field_values: {
          type: "object",
          description: "Map of exact field name → proposed value.",
          additionalProperties: true,
        },
        dry_run: {
          type: "boolean",
          description: "If true, returns a diff table and writes no file.",
        },
        expected_pdf_sha256: {
          type: "string",
          description: "Optional 64-char hex SHA-256 of the input PDF. If provided and the actual input hash differs, the fill is rejected with PDF_IDENTITY_MISMATCH.",
        },
      },
      required: ["pdf_path", "output_path", "field_values", "dry_run"],
      additionalProperties: false,
    },
    annotations: {
      title: "Fill PDF fields",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "export_pdf_field_map",
    description:
      "Write the full field map of a PDF to a local JSON file. Does not modify the PDF. Refuses to overwrite an existing output unless overwrite is true. Includes PDF identity and server version in the exported JSON.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Absolute local path to the input PDF." },
        output_json_path: {
          type: "string",
          description: "Absolute local path to write the JSON field map, inside ALLOWED_DIRS.",
        },
        overwrite: {
          type: "boolean",
          description: "If true, overwrite an existing output_json_path. Defaults to false.",
          default: false,
        },
      },
      required: ["pdf_path", "output_json_path"],
      additionalProperties: false,
    },
    annotations: {
      title: "Export PDF field map",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function jsonError(value: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function main() {
  const server = new Server(
    {
      name: "pdf-field-filler",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_LIST,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
        case "list_pdf_fields": {
          const parsed = ListPdfFieldsInput.parse(args);
          const result = await listPdfFields(parsed);
          return jsonResult(result);
        }
        case "validate_pdf_fill": {
          const parsed = ValidatePdfFillInput.parse(args);
          const result = await validatePdfFill(parsed);
          return jsonResult(result);
        }
        case "fill_pdf_fields": {
          const parsed = FillPdfFieldsInput.parse(args);
          const result = await fillPdfFields(parsed);
          return jsonResult(result);
        }
        case "export_pdf_field_map": {
          const parsed = ExportPdfFieldMapInput.parse(args);
          const result = await exportPdfFieldMap(parsed);
          return jsonResult(result);
        }
        default:
          return jsonError({
            ok: false,
            error_code: "INVALID_INPUT",
            message: `Unknown tool: ${name}`,
          });
      }
    } catch (err) {
      return jsonError(toErrorPayload(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
