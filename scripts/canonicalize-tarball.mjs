import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const archivePath = process.argv[2];
if (!archivePath) throw new Error("Usage: node scripts/canonicalize-tarball.mjs <archive.tgz>");

const tar = gunzipSync(await readFile(archivePath));

function readString(offset, length) {
  const end = tar.indexOf(0, offset);
  const boundedEnd = end >= offset && end < offset + length ? end : offset + length;
  return tar.subarray(offset, boundedEnd).toString("utf8");
}

function readOctal(offset, length) {
  const value = readString(offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function writeModeAndChecksum(offset, mode) {
  const modeText = mode.toString(8).padStart(6, "0");
  tar.fill(0, offset + 100, offset + 108);
  tar.write(modeText, offset + 100, "ascii");
  tar[offset + 106] = 0x20;

  tar.fill(0x20, offset + 148, offset + 156);
  let checksum = 0;
  for (let index = offset; index < offset + 512; index += 1) checksum += tar[index];
  const checksumText = checksum.toString(8).padStart(6, "0");
  tar.write(checksumText, offset + 148, "ascii");
  tar[offset + 154] = 0x20;
  tar[offset + 155] = 0;
}

let cliFound = false;
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const name = readString(offset, 100);
  const prefix = readString(offset + 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  if (path === "package/dist/cli.mjs") {
    writeModeAndChecksum(offset, 0o755);
    cliFound = true;
  }
  const size = readOctal(offset + 124, 12);
  offset += 512 + Math.ceil(size / 512) * 512;
}

if (!cliFound) throw new Error("package/dist/cli.mjs was not found in the tarball");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function canonicalGzip(bytes) {
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff])];
  for (let offset = 0; offset < bytes.length;) {
    const length = Math.min(0xffff, bytes.length - offset);
    const final = offset + length === bytes.length;
    const blockHeader = Buffer.alloc(5);
    blockHeader[0] = final ? 1 : 0;
    blockHeader.writeUInt16LE(length, 1);
    blockHeader.writeUInt16LE((~length) & 0xffff, 3);
    chunks.push(blockHeader, bytes.subarray(offset, offset + length));
    offset += length;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

await writeFile(archivePath, canonicalGzip(tar));
