import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";

export interface WorkspaceImage {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
  data: string;
}

function jpegDimensions(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return {};
}

function identifyImage(buffer: Buffer): Pick<WorkspaceImage, "mimeType" | "width" | "height"> {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { mimeType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", ...jpegDimensions(buffer) };
  }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    if (buffer.subarray(12, 16).toString("ascii") === "VP8X" && buffer.length >= 30) {
      return {
        mimeType: "image/webp",
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
    return { mimeType: "image/webp" };
  }
  throw new CodexProError("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
}

export async function viewWorkspaceImage(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  maxBytes?: number
): Promise<WorkspaceImage> {
  const resolved = guard.resolve(workspace, filePath);
  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) throw new CodexProError(`Not a file: ${resolved.relPath}`);
  const limit = Math.min(2_000_000, maxBytes ?? Math.max(config.maxReadBytes, 1_000_000));
  if (stat.size > limit) {
    throw new CodexProError(`Image is too large (${stat.size} bytes). Limit: ${limit} bytes.`);
  }
  const buffer = await fsp.readFile(resolved.absPath);
  const identified = identifyImage(buffer);
  return {
    path: resolved.relPath,
    ...identified,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    data: buffer.toString("base64")
  };
}
