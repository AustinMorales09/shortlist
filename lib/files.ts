import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { filesDir } from "./db";

export const MAX_RESUME = 5 * 1024 * 1024;

/** Resume type from the file's own bytes: PDF or plain text only. */
export function sniffResume(name: string, b: Buffer): string | null {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (/\.(txt|md)$/i.test(name) && !b.subarray(0, 4000).includes(0)) return "text/plain";
  return null;
}

export function storeFile(bytes: Buffer): string {
  const storedAs = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(filesDir, storedAs), bytes);
  return storedAs;
}
