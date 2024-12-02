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

// https://wiki.osdev.org/USTAR
class USTarParser {
  constructor() {
    this._hooks = {
      file: async () => {},
    };
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

      // The last byte is a NUL byte, we ignore it from the content.
      const content = eat(size - 1);
      offset += 1;

      if (typeflag === 0 || typeflag === 48) {
        // notify that we have a file
        await this._hooks["file"](str(name), content);
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

class StreamingUSTarParser {
  constructor() {
    this._hooks = {
      file: async () => {},
    };

    this._buffer = new Uint8Array(1 * 1024 * 1024); // preallocate a 1Mib buffer
    this._bufferLength = 0;

    this._parser = new USTarParser;

    this._needBytes = 0;
  }

  on(type, f) {
    this._parser.on(type, f);
  }

  reallocBuffer(n) {
    const newBuffer = new Uint8Array(this._buffer.byteLength + n)
    newBuffer.set(this._buffer, 0) // copy old buffer

    this._buffer = newBuffer;
  }

  async write(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("chunk must be an Uint8Array")
    }

    if (this._bufferLength + chunk.byteLength > this._buffer.byteLength) {
      // The chunk is exceeding our buffer capacity, reallocate a buffer one.
      this.reallocBuffer(chunk.byteLength);
    }

    this._buffer.set(chunk, this._bufferLength);
    this._bufferLength += chunk.byteLength;

    let readBytes = 0;

    do {
      const state = await this._parser.parse(this._buffer.slice(0, this._bufferLength));
      readBytes = state.readBytes;

      this._buffer = this._buffer.slice(state.readBytes);
      this._bufferLength -= state.readBytes;

      this._needBytes = state.needBytes || 0;

      if (this._needBytes > this._buffer.byteLength)  {
        // The parser is asking for more bytes than our buffer can hold.
        // Go ahead and re-allocate it for chunks that will come in.
        this.reallocBuffer(this._needBytes);
      }

    } while(readBytes > 0 && this._bufferLength > 0)

    // TODO: if memory consumption becomes a concern, we can reduce the buffer
    // capacity, when no more bytes are needed, to something more reasonable.
  }
}

module.exports = {
  assertUsTar,
  isTarSector,
  roundNextSector,
  str,

  USTarParser,
  StreamingUSTarParser
};
