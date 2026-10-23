// Read-only LevelDB reader, enough to read another Chromium app's IndexedDB from disk (Notion
// Calendar's events). LevelDB proper can't open those (their keys sort with Chromium's own
// "idb_cmp1" comparator), but every live record is in the files: the write-ahead .log and the
// sorted .ldb tables. read(dir) -> Map(key hex -> value Buffer), newest write per key, deletes applied.
// Format: https://github.com/google/leveldb/blob/main/doc/{log_format,table_format}.md
const fs = require('fs');
const path = require('path');

function varint(buf, at) {
  let n = 0;
  let shift = 0;
  for (;;) {
    const b = buf[at++];
    if (b === undefined) throw new Error('varint past end');
    n += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [n, at];
    shift += 7;
  }
}

// Snappy block decompression (tables store their blocks with it).
function unsnappy(src) {
  let [len, i] = varint(src, 0);
  const out = Buffer.alloc(len);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const bytes = n - 59; n = src.readUIntLE(i, bytes); i += bytes; }
      n += 1;
      src.copy(out, o, i, i + n);
      i += n;
      o += n;
      continue;
    }
    let n;
    let off;
    if (kind === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[i++]; }
    else if (kind === 2) { n = (tag >> 2) + 1; off = src.readUInt16LE(i); i += 2; }
    else { n = (tag >> 2) + 1; off = src.readUInt32LE(i); i += 4; }
    for (let k = 0; k < n; k++, o++) out[o] = out[o - off]; // may overlap: byte by byte
  }
  return out;
}

// Write-ahead log: 32KB blocks of records (FULL / FIRST..MIDDLE..LAST) that join into write batches.
function* logBatches(buf) {
  let parts = [];
  for (let block = 0; block < buf.length; block += 32768) {
    let i = block;
    const end = Math.min(block + 32768, buf.length);
    while (i + 7 <= end) {
      const len = buf.readUInt16LE(i + 4);
      const type = buf[i + 6];
      if (type === 0 && len === 0) break; // zero padding at a block's end
      const data = buf.subarray(i + 7, i + 7 + len);
      i += 7 + len;
      if (i > end) return; // a record still being written
      if (type === 1) yield data;
      else if (type === 2) parts = [data];
      else if (type === 3) parts.push(data);
      else if (type === 4) { parts.push(data); yield Buffer.concat(parts); parts = []; }
    }
  }
}

// One table block's entries (prefix-compressed keys), in order.
function* blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - restarts * 4;
  let i = 0;
  let key = Buffer.alloc(0);
  while (i < limit) {
    let shared; let unshared; let vlen;
    [shared, i] = varint(block, i);
    [unshared, i] = varint(block, i);
    [vlen, i] = varint(block, i);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(i, i + unshared)]);
    i += unshared;
    yield [key, block.subarray(i, i + vlen)];
    i += vlen;
  }
}

// handle (at `at`): a block's offset and size in file.
function readBlock(file, handle, at = 0) {
  const [offset, i] = varint(handle, at);
  const [size] = varint(handle, i);
  const raw = file.subarray(offset, offset + size);
  return file[offset + size] === 1 ? unsnappy(raw) : raw; // trailer: compression type, then a checksum
}

// Sorted table: the footer's index block points at every data block.
function* tableEntries(buf) {
  const footer = buf.length - 48;
  let [, i] = varint(buf, footer); // metaindex handle
  [, i] = varint(buf, i);
  for (const [, handle] of blockEntries(readBlock(buf, buf, i))) {
    for (const [ikey, value] of blockEntries(readBlock(buf, handle))) {
      const tag = ikey.readBigUInt64LE(ikey.length - 8);
      yield { key: ikey.subarray(0, ikey.length - 8), seq: tag >> 8n, put: (tag & 0xffn) === 1n, value };
    }
  }
}

function read(dir) {
  const latest = new Map(); // key hex -> { seq, put, value }
  const keep = (key, seq, put, value) => {
    const k = key.toString('hex');
    const cur = latest.get(k);
    if (!cur || cur.seq < seq) latest.set(k, { seq, put, value });
  };
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.endsWith('.ldb') || name.endsWith('.sst')) {
      for (const e of tableEntries(fs.readFileSync(file))) keep(e.key, e.seq, e.put, e.value);
    } else if (name.endsWith('.log') && /^\d+\.log$/.test(name)) {
      for (const batch of logBatches(fs.readFileSync(file))) {
        let seq = batch.readBigUInt64LE(0);
        const count = batch.readUInt32LE(8);
        let i = 12;
        for (let n = 0; n < count && i < batch.length; n++, seq++) {
          const put = batch[i++] === 1;
          let klen; let vlen = 0;
          [klen, i] = varint(batch, i);
          const key = batch.subarray(i, i + klen);
          i += klen;
          let value = null;
          if (put) { [vlen, i] = varint(batch, i); value = batch.subarray(i, i + vlen); i += vlen; }
          keep(key, seq, put, value);
        }
      }
    }
  }
  const out = new Map();
  for (const [k, e] of latest) if (e.put) out.set(k, e.value);
  return out;
}

module.exports = { read, unsnappy, varint };
