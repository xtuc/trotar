function assertUsTar(u8buffer) {
  if (!isTarSector(u8buffer)) {
    throw new Error("not type tar");
  }
}

function isTarSector(buffer, base = 0) {
  const offset = base + 257;
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

class UsTarParser {
  constructor() {
    this._offset = 0;
    this._chunk = null;
    this._hooks = {
      file: async () => {},
    };
  }

  write(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("chunk must be an Uint8Array")
    }

    this._offset = 0;
    this._chunk = chunk;
  }

  isEnd() {
    return isTarSector(this._chunk, this._offset) === false;
  }

  async next() {
    while (!this.isEnd()) {
      const name = this.eat(100);
      const mode = this.eat(8);
      const uid = this.eat(8);
      const gid = this.eat(8);
      let size = this.eat(12);
      size = parseInt(str(size), 8);
      const mtime = this.eat(12);
      const chksum = this.eat(8);
      const typeflag = this.eatByte();
      const linkname = this.eat(100);
      const magic = this.eat(6);
      const version = this.eat(2);
      const uname = this.eat(32);
      const gname = this.eat(32);
      const devmajor = this.eat(8);
      const devminor = this.eat(8);
      const prefix = this.eat(155);

      this._offset = roundNextSector(this._offset);

      const content = this._chunk.slice(this._offset, this._offset + size);
      this._offset += size;

      if (typeflag === 0 || typeflag === 48) {
        // notify that we have a file
        await this._hooks["file"](str(name), content);
      }

      this._offset = roundNextSector(this._offset);
    }
  }

  eat(n) {
    const b = this._chunk.slice(this._offset, this._offset + n);
    this._offset += n;
    return b;
  }

  eatByte() {
    const b = this.eat(1);
    return b[0];
  }

  on(type, f) {
    this._hooks[type] = f;
  }
}

module.exports = {
  assertUsTar,
  isTarSector,
  roundNextSector,
  str,

  UsTarParser
};
