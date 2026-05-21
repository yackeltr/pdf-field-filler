#!/usr/bin/env node
// Build the .mcpb distribution. Pins the version into both the bundled JS
// (via esbuild --define) AND the copied manifest.json — package.json is the
// single source of truth, so neither can drift.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));
const VERSION = pkg.version;

mkdirSync("dist-mcpb/server", { recursive: true });

// 1) Bundle with the version injected at build time. The dev tree still has
//    a runtime-read fallback in src/tools/export.ts; the inject closes the
//    bundle case where package.json is not shipped alongside.
const define = `--define:__BUILD_TIME_VERSION__='"${VERSION}"'`;
execSync(
  `esbuild src/index.ts --bundle --platform=node --format=esm ${define} --outfile=dist-mcpb/server/index.mjs`,
  { stdio: "inherit" }
);

// 2) Sync the manifest's version field with package.json. The hardcoded value
//    in manifest.json sits outside the runtime drift guarantee; this keeps it
//    aligned at build time.
if (manifest.version !== VERSION) {
  console.warn(
    `manifest.json version (${manifest.version}) did not match package.json (${VERSION}); updating manifest in the dist bundle.`
  );
}
manifest.version = VERSION;
writeFileSync("dist-mcpb/manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// 3) Pack.
execSync("mcpb pack dist-mcpb/ pdf-field-filler.mcpb", { stdio: "inherit" });
