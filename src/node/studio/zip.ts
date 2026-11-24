import { crc32 } from 'node:zlib';

/** ZIP store format, UTF-8 names; no runtime dependency or ZIP64 archives. */
export function zipFiles(files: { path: string; data: Buffer }[]): Buffer {
  if (files.length > 65535) throw new Error('Too many files for ZIP');
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    if (file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..')) throw new Error('Invalid ZIP path');
    const name = Buffer.from(file.path.replaceAll('\\', '/'), 'utf8'), crc = crc32(file.data) >>> 0;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14); head.writeUInt32LE(file.data.length, 18); head.writeUInt32LE(file.data.length, 22); head.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt32LE(crc, 16); index.writeUInt32LE(file.data.length, 20); index.writeUInt32LE(file.data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(head, name, file.data); central.push(index, name); offset += head.length + name.length + file.data.length;
    if (offset > 256 * 1024 * 1024) throw new Error('ZIP exceeds 256 MB');
  }
  const c = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, c, end]);
}
