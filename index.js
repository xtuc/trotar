function assertUsTar(u8buffer) {
  if (!isTarSector(u8buffer)) {
    throw new Error("not type tar");
  }
}

function isTarSector(buffer) {
  const offset = 257;
  return (
    buffer[offset] === 117 &&
    buffer[offset + 1] === 115 &&
    buffer[offset + 2] === 116 &&
    buffer[offset + 3] === 97 &&
    buffer[offset + 4] === 114
  );
}

function roundNextSector(x) {
  return Math.ceil(x / 512) * 512;
}

function str(buffer) {
  return [...removeTrailingZero(buffer)]
    .map(x => String.fromCharCode(x))
    .join("");
}

function removeTrailingZero(buff) {
  const end = buff.indexOf(0);
  if (end >= 0) {
    return buff.slice(0, end);
  } else {
    return buff;
  }
}

const utf8 = new TextDecoder();

// POSIX pax extended header records: "<length> <key>=<value>\n", where
// <length> is the decimal byte length of the whole record. Values are UTF-8.
function parsePax(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.byteLength) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) break;
    const length = parseInt(str(buffer.subarray(offset, space)), 10);
    if (!(length > 0)) break;
    const record = buffer.subarray(space + 1, offset + length - 1);
    const eq = record.indexOf(61);
    if (eq >= 0) {
      records[utf8.decode(record.subarray(0, eq))] = utf8.decode(record.subarray(eq + 1));
    }
    offset += length;
  }
  return records;
}

// https://wiki.osdev.org/USTAR
class USTarParser {
  constructor() {
    this._hooks = {
      file: async () => {},
    };
    // Full path from a pax `path` record or a GNU long-name entry. It applies
    // to the next entry only, which may arrive in a later parse() call.
    this._longName = null;
  }

  async parse(data) {
    if (!(data instanceof Uint8Array)) {
      throw new Error("data must be an Uint8Array")
    }

    let offset = 0;

    // How many bytes have been consumed
    let readBytes = 0;

    function eat(n) {
      const b = data.slice(offset, offset + n);
      offset += n;
      return b;
    }

    function eatByte() {
      const b = eat(1);
      return b[0];
    }

    while (isTarSector(data)) {
      if (data.byteLength < 512) {
        return { readBytes, needBytes: 512 - data.byteLength };
      }

      const name = eat(100);
      const mode = eat(8);
      const uid = eat(8);
      const gid = eat(8);
      let size = eat(12);
      size = parseInt(str(size), 8);

      if (data.byteLength < roundNextSector(512 + size)) {
        // Ensure that we have enough bytes for the header and the content
        // of the file. If not, indicate how many bytes we  are missing.
        return { readBytes, needBytes: roundNextSector(512 + size) - data.byteLength };
      }

      const mtime = eat(12);
      const chksum = eat(8);
      const typeflag = eatByte();
      const linkname = eat(100);
      const magic = eat(6);
      const version = eat(2);
      const uname = eat(32);
      const gname = eat(32);
      const devmajor = eat(8);
      const devminor = eat(8);
      const prefix = eat(155);

      // Skip any padding after the header
      offset = 512;

      // `size` is the exact file length; the 512-byte record padding after
      // the content is handled by roundNextSector below.
      const content = eat(size);

      if (typeflag === 120) {
        // "x": pax extended header for the next entry
        const pax = parsePax(content);
        // An empty value deletes the override (POSIX pax), so fall back to
        // the header name.
        if (pax.path !== undefined) {
          this._longName = pax.path || null;
        }
      } else if (typeflag === 76) {
        // "L": GNU long name for the next entry, NUL-terminated
        this._longName = utf8.decode(removeTrailingZero(content)) || null;
      } else if (typeflag !== 103 && typeflag !== 75) {
        // Skip "g" (pax global header) and "K" (GNU long link name)
        if (typeflag === 0 || typeflag === 48) {
          let path = str(name);
          if (this._longName !== null) {
            path = this._longName;
          } else if (magic[5] === 0 && prefix[0] !== 0) {
            // POSIX ustar ("ustar\0") splits long paths into prefix and name.
            // GNU headers ("ustar ") use these bytes for other fields.
            path = str(prefix) + "/" + path;
          }
          // notify that we have a file
          await this._hooks["file"](path, content);
        }
        this._longName = null;
      }

      // Skip any padding
      offset = roundNextSector(offset);

      readBytes += offset;
      data = data.slice(offset)

      // since we truncated the data, we reset the offset to 0.
      offset = 0;
    }

    return { readBytes };
  }

  on(type, f) {
    this._hooks[type] = f;
  }
}

const BLOCK = 512;

// Bounds the pax and GNU long-name content buffered for one entry. Tarballs
// are often untrusted, and this metadata is buffered whatever `filter` says.
const MAX_META_BYTES = 1024 * 1024;

const TYPE_FILE = 48; // "0"
const TYPE_FILE_OLD = 0; // NUL, pre-POSIX regular file
const TYPE_PAX = 120; // "x"
const TYPE_GNU_LONG_NAME = 76; // "L"
const TYPE_PAX_GLOBAL = 103; // "g"
const TYPE_GNU_LONG_LINK = 75; // "K"

const SKIP = { kind: "skip" };

// Reads a tar stream one chunk at a time. Entry content is copied straight
// into a buffer of the entry's size, so at most one entry is buffered at a
// time, and entries rejected by `filter` are skipped without being buffered.
// Paths are resolved the same way as USTarParser: ustar prefix, pax `path`
// and GNU long name.
class StreamingUSTarParser {
  // options.filter(path): called with each regular file's full path before
  // its content is read. Return false to skip the content without buffering
  // it. Defaults to keeping every file.
  constructor(options = {}) {
    this._hooks = {
      file: async () => {},
    };
    this._filter = options.filter || (() => true);

    this._header = new Uint8Array(BLOCK);
    this._headerFill = 0;
    this._entry = SKIP;
    // Bytes of the current entry's content still to read, then of its padding.
    this._contentLeft = 0;
    this._contentFill = 0;
    this._paddingLeft = 0;
    this._longName = null;
    this._ended = false;

    // Largest single entry buffered so far (file or metadata content).
    this.peakBufferedBytes = 0;
  }

  on(type, f) {
    this._hooks[type] = f;
  }

  // Resolves once every entry completed by `chunk` has been reported and its
  // `file` hook has resolved. Callers must wait for it before the next write.
  async write(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("chunk must be an Uint8Array")
    }

    let offset = 0;
    while (offset < chunk.byteLength && !this._ended) {
      if (this._contentLeft > 0) {
        const n = Math.min(this._contentLeft, chunk.byteLength - offset);
        if (this._entry.kind !== "skip") {
          this._entry.content.set(chunk.subarray(offset, offset + n), this._contentFill);
        }
        this._contentFill += n;
        this._contentLeft -= n;
        offset += n;
        if (this._contentLeft === 0) await this._finishEntry();
      } else if (this._paddingLeft > 0) {
        const n = Math.min(this._paddingLeft, chunk.byteLength - offset);
        this._paddingLeft -= n;
        offset += n;
      } else {
        const n = Math.min(BLOCK - this._headerFill, chunk.byteLength - offset);
        this._header.set(chunk.subarray(offset, offset + n), this._headerFill);
        this._headerFill += n;
        offset += n;
        if (this._headerFill === BLOCK) {
          this._headerFill = 0;
          await this._startEntry();
        }
      }
    }
  }

  // Call once the stream has ended. Throws if it ended inside an entry or a
  // header. A stream without end-of-archive blocks is accepted.
  close() {
    if (this._ended) return;
    if (this._contentLeft > 0 || this._paddingLeft > 0 || this._headerFill > 0) {
      throw new Error("tar stream ended in the middle of an entry");
    }
  }

  async _startEntry() {
    const header = this._header;
    if (!isTarSector(header)) {
      // The zero blocks that end the archive; anything after is ignored.
      this._ended = true;
      return;
    }
    const sizeField = str(header.subarray(124, 136)).trim();
    const size = /^[0-7]+$/.test(sizeField) ? parseInt(sizeField, 8) : NaN;
    if (!Number.isSafeInteger(size)) {
      throw new Error("invalid size field " + JSON.stringify(sizeField));
    }
    const typeflag = header[156];

    if (typeflag === TYPE_PAX || typeflag === TYPE_GNU_LONG_NAME) {
      if (size > MAX_META_BYTES) {
        throw new Error(
          (typeflag === TYPE_PAX ? "pax header" : "GNU long name") +
          " of " + size + " bytes exceeds " + MAX_META_BYTES
        );
      }
      this._entry = { kind: "meta", typeflag, content: this._allocate(size) };
    } else if (typeflag === TYPE_FILE || typeflag === TYPE_FILE_OLD) {
      let path = str(header.subarray(0, 100));
      if (this._longName !== null) {
        path = this._longName;
      } else if (header[262] === 0 && header[345] !== 0) {
        // POSIX ustar ("ustar\0") splits long paths into prefix and name.
        // GNU headers ("ustar ") use these bytes for other fields.
        path = str(header.subarray(345, 500)) + "/" + path;
      }
      this._longName = null;
      this._entry = this._filter(path)
        ? { kind: "file", path, content: this._allocate(size) }
        : SKIP;
    } else {
      // "g" (pax global header) and "K" (GNU long link name) keep a pending
      // long name; every other entry consumes it.
      if (typeflag !== TYPE_PAX_GLOBAL && typeflag !== TYPE_GNU_LONG_LINK) {
        this._longName = null;
      }
      this._entry = SKIP;
    }

    this._contentLeft = size;
    this._contentFill = 0;
    this._paddingLeft = roundNextSector(size) - size;
    if (size === 0) await this._finishEntry();
  }

  async _finishEntry() {
    const entry = this._entry;
    this._entry = SKIP;
    if (entry.kind === "file") {
      await this._hooks["file"](entry.path, entry.content);
    } else if (entry.kind === "meta" && entry.typeflag === TYPE_PAX) {
      // An empty value deletes the override (POSIX pax), so fall back to the
      // header name.
      const pax = parsePax(entry.content);
      if (pax.path !== undefined) {
        this._longName = pax.path || null;
      }
    } else if (entry.kind === "meta") {
      this._longName = utf8.decode(removeTrailingZero(entry.content)) || null;
    }
  }

  _allocate(size) {
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, size);
    return new Uint8Array(size);
  }
}

module.exports = {
  assertUsTar,
  isTarSector,
  roundNextSector,
  str,
  MAX_META_BYTES,

  USTarParser,
  StreamingUSTarParser
};
