// Reads a zip made of stored (uncompressed) entries, as app/js/xlsx.js
// writes them, checking every CRC. Returns Map(name -> string).
import { crc32 } from '../../app/js/xlsx.js';

export function unzip(bytes) {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (method !== 0) throw new Error(`${name} is compressed`);
    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    files.set(name, data.toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
