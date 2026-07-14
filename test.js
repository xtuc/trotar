const { StreamingUSTarParser, USTarParser, str, assertUsTar, roundNextSector, isTarSector } = require("./index.js");
const { join } = require("path");
const { createHash } = require("crypto");
const { assert } = require("chai");
const { readFileSync, writeFileSync, existsSync } = require("fs");

describe("lib", () => {
  it("round next sector", function() {
    assert.equal(roundNextSector(1), 512);
    assert.equal(roundNextSector(511), 512);
    assert.equal(roundNextSector(513), 1024);
  });

  it("is sector", function() {
    const b = [...new Array(257), 117, 115, 116, 97, 114];
    assert.isTrue(isTarSector(b));

    const b2 = [...new Array(257), 0, 0, 0, 97, 114];
    assert.isFalse(isTarSector(b2));
  });

  it("assert ustar", function() {
    const b = [...new Array(257), 117, 115, 116, 97, 114];
    assert.doesNotThrow(() => assertUsTar(b));

    const b1 = [1, 2, 3];
    assert.throws(() => assertUsTar(b1));
  });

  it("str", function() {
    const b = [97, 98, 99];
    assert.equal(str(b), "abc");

    const b1 = [97, 98, 99, 0, 0, 0];
    assert.equal(str(b1), "abc");
  });
});

describe('fixtures', () => {
  function t(name) {
    it("dump " + name, async () => {
      const parser = new USTarParser;
      let dump = "";
      parser.on("file", (name, content) => {
        dump += JSON.stringify(name) + "\n";

        const textContent = [...content].map(x => String.fromCharCode(x)).join("");
        dump += JSON.stringify(textContent) + "\n\n";
      });

      const fixture = join("fixtures", name);
      const tar = readFileSync(fixture, null);

      await parser.parse(tar);

      const expected = fixture + ".expected";
      if (existsSync(expected)) {
        assert.equal(
          dump,
          readFileSync(expected, "utf8")
        )
      } else {
        console.error("create", expected);
        writeFileSync(expected, dump);
      }
    });
  }

  t("hi-sven-1.0.0.tar");
  t("random.tar");
});

describe('preserves last byte of file content', () => {
  // Build a minimal USTAR archive containing a single file. Field offsets and
  // the space-then-sum checksum are per the USTAR spec (https://wiki.osdev.org/USTAR).
  function buildUstarArchive(name, content) {
    const HEADER_SIZE = 512;
    const header = Buffer.alloc(HEADER_SIZE);
    Buffer.from(name).copy(header, 0);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    Buffer.from(content.length.toString(8).padStart(11, "0") + "\0").copy(header, 124);
    Buffer.from("00000000000\0").copy(header, 136);
    header[156] = 0x30;
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);

    header.fill(0x20, 148, 148 + 8);
    let sum = 0;
    for (let i = 0; i < HEADER_SIZE; i++) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);

    const padded = Buffer.alloc(Math.ceil(content.length / HEADER_SIZE) * HEADER_SIZE);
    Buffer.from(content).copy(padded, 0);
    return new Uint8Array(Buffer.concat([header, padded, Buffer.alloc(HEADER_SIZE * 2)]));
  }

  async function extract(tar) {
    const parser = new USTarParser();
    let received = null;
    parser.on("file", (name, content) => { received = { name, content }; });
    await parser.parse(tar);
    return received;
  }

  it("keeps the last byte when it is a printable non-newline character", async () => {
    const content = Buffer.from("hello, world}");
    const got = await extract(buildUstarArchive("file.txt", content));

    assert.equal(got.content.length, content.length);
    assert.deepEqual([...got.content], [...content]);
  });

  it("keeps the last byte when it is 0x00", async () => {
    const content = Buffer.from([0x01, 0x02, 0x00]);
    const got = await extract(buildUstarArchive("bin", content));

    assert.equal(got.content.length, content.length);
    assert.deepEqual([...got.content], [...content]);
  });

  it("keeps the last byte when it is 0x0a", async () => {
    const content = Buffer.from("line one\nline two\n");
    const got = await extract(buildUstarArchive("multi.txt", content));

    assert.equal(got.content.length, content.length);
    assert.deepEqual([...got.content], [...content]);
  });

  // Regression for https://github.com/cdnjs/cdnjs/issues/14305 — real
  // fa-regular-400.woff2 extracted from @fortawesome/fontawesome-free@7.3.0.
  it("extracts a real font-awesome .woff2 byte-exact against upstream", async () => {
    const UPSTREAM_SIZE = 19480;
    const UPSTREAM_SHA256 = "f4f5cc8867d30647f0ad918c01599fa8aa9657c39eb55f0fc610120986544385";

    const tar = new Uint8Array(readFileSync(join("fixtures", "fa-regular-400.tar")));
    const got = await extract(tar);

    assert.equal(got.name, "package/webfonts/fa-regular-400.woff2");
    assert.equal(got.content.length, UPSTREAM_SIZE);
    assert.equal(
      createHash("sha256").update(Buffer.from(got.content)).digest("hex"),
      UPSTREAM_SHA256
    );
    assert.deepEqual([...got.content.slice(0, 4)], [0x77, 0x4f, 0x46, 0x32]);
  });
});

describe('streaming', () => {
  it("should dump in streaming - files between chunks", async () => {
    const tar = new Uint8Array(readFileSync("./fixtures/hi-sven-1.0.0.tar", null));
    const parser = new StreamingUSTarParser;

    let filename = "";

    parser.on("file", (name, content) => {
      filename = name;
    })

    await parser.write(tar.slice(0, 100));
    await parser.write(tar.slice(100, 400));
    await parser.write(tar.slice(400, 1124)); // package.json completed with 100 extra bytes

    assert.equal(filename, "package/package.json");
    assert.equal(parser._bufferLength, 100);

    await parser.write(tar.slice(1124, 1400));
    await parser.write(tar.slice(1400, 2048)); // index.js compltes

    assert.equal(filename, "package/index.js");
    assert.equal(parser._bufferLength, 0);

    await parser.write(tar.slice(2048)); // README.md completes

    assert.equal(filename, "package/README.md");

    // The end of an archive is marked by at least two consecutive zero-filled records
    assert.equal(parser._bufferLength, 1024);
  })

  it("should dump in streaming - chunks with mutliple files", async () => {
    const tar = new Uint8Array(readFileSync("./fixtures/hi-sven-1.0.0.tar", null));
    const parser = new StreamingUSTarParser;

    const filenames = [];

    parser.on("file", (name, content) => {
      filenames.push(name);
    })

    await parser.write(tar.slice(0, 1024)); // package.json completed with 100 extra bytes
    await parser.write(tar.slice(1024, 2048)); // index.js compltes

    assert.deepEqual(filenames, ["package/package.json", "package/index.js"]);
    assert.equal(parser._bufferLength, 0);

    await parser.write(tar.slice(2048)); // README.md completes

    assert.deepEqual(filenames, ["package/package.json", "package/index.js", "package/README.md"]);

    // The end of an archive is marked by at least two consecutive zero-filled records
    assert.equal(parser._bufferLength, 1024);
  })
});

