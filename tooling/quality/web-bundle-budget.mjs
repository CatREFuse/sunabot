import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const dist = path.resolve("apps/admin-web/dist");
const manifestPath = path.join(dist, ".vite/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = Object.values(manifest).filter((chunk) => chunk.isEntry);
if (entries.length !== 1) throw new Error(`Expected one admin entry chunk, found ${entries.length}.`);

const initialFiles = new Set();
collectInitial(entries[0], initialFiles);
const initialGzipBytes = [...initialFiles].reduce((total, file) => total + gzipSize(file), 0);
if (initialGzipBytes > 180 * 1024) {
  throw new Error(`Admin initial JavaScript is ${initialGzipBytes} bytes gzip; budget is 184320 bytes.`);
}

for (const chunk of Object.values(manifest)) {
  if (!chunk.file?.endsWith(".js") || initialFiles.has(chunk.file)) continue;
  const bytes = fs.statSync(path.join(dist, chunk.file)).size;
  if (bytes > 700 * 1024) {
    throw new Error(`Admin async chunk ${chunk.file} is ${bytes} bytes; budget is 716800 bytes.`);
  }
}

console.log(JSON.stringify({ ok: true, initialGzipBytes, initialFiles: [...initialFiles] }));

function collectInitial(chunk, files) {
  if (!chunk?.file?.endsWith(".js") || files.has(chunk.file)) return;
  files.add(chunk.file);
  for (const imported of chunk.imports ?? []) collectInitial(manifest[imported], files);
}

function gzipSize(file) {
  return gzipSync(fs.readFileSync(path.join(dist, file)), { level: 9 }).byteLength;
}
