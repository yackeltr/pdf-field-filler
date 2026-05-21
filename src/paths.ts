import { realpathSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PdfFillerError } from "./errors.js";

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function getAllowedDirs(): string[] {
  const raw = process.env.ALLOWED_DIRS;
  const list =
    raw && raw.trim().length > 0
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [path.join(homedir(), "Downloads"), path.join(homedir(), "Documents")];
  return list.map((d) => safeRealpath(expandTilde(d)));
}

export interface PathCheckOptions {
  mustExist?: boolean;
}

export function assertAllowedPath(p: string, opts: PathCheckOptions = {}): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new PdfFillerError("INVALID_INPUT", "Path must be a non-empty string.");
  }
  if (!path.isAbsolute(p)) {
    throw new PdfFillerError("PATH_NOT_ABSOLUTE", `Path is not absolute: ${p}`, { path: p });
  }
  if (opts.mustExist && !existsSync(p)) {
    throw new PdfFillerError("PDF_NOT_FOUND", `File not found: ${p}`, { path: p });
  }

  const resolved = safeRealpath(p);
  const allowed = getAllowedDirs();
  const ok = allowed.some((dir) => {
    const rel = path.relative(dir, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!ok) {
    throw new PdfFillerError(
      "PATH_NOT_ALLOWED",
      `Path is outside allowed directories.`,
      { path: p, resolved, allowed_dirs: allowed }
    );
  }

  if (opts.mustExist) {
    const st = statSync(resolved);
    if (!st.isFile()) {
      throw new PdfFillerError("PDF_NOT_FOUND", `Path is not a regular file: ${p}`, { path: p });
    }
  }

  return resolved;
}

function isInside(target: string, allowed: string[]): boolean {
  return allowed.some((dir) => {
    const rel = path.relative(dir, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

export function ensureOutputAllowed(outputPath: string, inputResolved: string): string {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new PdfFillerError("INVALID_INPUT", "Output path must be a non-empty string.");
  }
  if (!path.isAbsolute(outputPath)) {
    throw new PdfFillerError("PATH_NOT_ABSOLUTE", `Output path is not absolute: ${outputPath}`, {
      path: outputPath,
    });
  }
  const resolvedParent = safeRealpath(path.dirname(outputPath));
  const candidate = path.join(resolvedParent, path.basename(outputPath));
  const allowed = getAllowedDirs();
  if (!isInside(resolvedParent, allowed)) {
    throw new PdfFillerError(
      "PATH_NOT_ALLOWED",
      `Output directory is outside allowed directories.`,
      { output_path: outputPath, resolved_dir: resolvedParent, allowed_dirs: allowed }
    );
  }

  // If output_path already exists, resolve it (a symlink target may escape
  // ALLOWED_DIRS or collide with the input). Both must be re-checked.
  let finalTarget = candidate;
  if (existsSync(candidate)) {
    finalTarget = safeRealpath(candidate);
    if (!isInside(finalTarget, allowed)) {
      throw new PdfFillerError(
        "PATH_NOT_ALLOWED",
        `Output path resolves to a location outside allowed directories.`,
        { output_path: outputPath, resolved_target: finalTarget, allowed_dirs: allowed }
      );
    }
  }

  if (finalTarget === inputResolved || candidate === inputResolved) {
    throw new PdfFillerError(
      "OUTPUT_EQUALS_INPUT",
      "Output path must differ from input path.",
      { input_path: inputResolved, output_path: candidate, resolved_target: finalTarget }
    );
  }

  return candidate;
}
