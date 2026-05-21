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
import { toErrorPayload } from "./errors.js";

const TOOL_LIST = [
  {
    name: "list_pdf_fields",
    description:
      "List every AcroForm field in a fillable PDF with exact internal names, types, current values, legal options, and widget locations. Read-only.",
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
  },
  {
    name: "validate_pdf_fill",
    description:
      "Validate proposed field values against the actual AcroForm field map. Returns a review table without modifying the PDF. Flags signature, human-only, and date fields as needs_review.",
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
  },
  {
    name: "fill_pdf_fields",
    description:
      "Fill validated, non-human-only fields into a fillable PDF. Refuses to overwrite the input. Backs up any existing output file. Never fills signature/initials/attestation/certification/signing-date fields. Does not flatten the PDF.",
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
      },
      required: ["pdf_path", "output_path", "field_values", "dry_run"],
      additionalProperties: false,
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
      version: "0.1.0",
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
