const { StreamingUSTarParser, USTarParser, str, assertUsTar, roundNextSector, isTarSector, MAX_META_BYTES } = require("./index.js");
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

    await parser.write(tar.slice(1124, 1400));
    await parser.write(tar.slice(1400, 2048)); // index.js compltes

    assert.equal(filename, "package/index.js");

    await parser.write(tar.slice(2048)); // README.md completes

    assert.equal(filename, "package/README.md");
    parser.close();
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

    await parser.write(tar.slice(2048)); // README.md completes

    assert.deepEqual(filenames, ["package/package.json", "package/index.js", "package/README.md"]);
    parser.close();
  })
});

describe('long paths', () => {
  const deepDir = "package/" + "a".repeat(60) + "/" + "b".repeat(60);

  // Feeds `tar` to the streaming parser in `chunkSize` slices and collects
  // [name, content] pairs.
  async function extractAll(tar, chunkSize) {
    const parser = new StreamingUSTarParser();
    const files = [];
    parser.on("file", (name, content) => {
      files.push([name, Buffer.from(content).toString()]);
    });
    for (let offset = 0; offset < tar.length; offset += chunkSize) {
      await parser.write(tar.slice(offset, offset + chunkSize));
    }
    return files;
  }

  // Fixtures written by bsdtar 3.5.3 (libarchive 3.7.4) with --format ustar,
  // pax and gnutar. Each ends with a short file whose header must not inherit
  // the long name; in the pax fixture it has its own `x` header without `path`.
  const cases = [
    ["long-path-ustar.tar", "joins the ustar prefix and name", deepDir + "/long-path.js", "long\n"],
    ["long-path-pax.tar", "uses the pax path record", "package/" + "c".repeat(110) + ".js", "pax\n"],
    ["long-path-gnutar.tar", "uses the UTF-8 GNU long name", deepDir + "/long-path-é.js", "gnu\n"],
  ];

  for (const [fixture, title, longName, content] of cases) {
    it(title + " (" + fixture + ")", async () => {
      const tar = new Uint8Array(readFileSync(join("fixtures", fixture)));
      const expected = [[longName, content], ["package/short.js", "short\n"]];

      assert.deepEqual(await extractAll(tar, tar.length), expected);
      // 100-byte chunks put the long-name entry and the entry it names in
      // separate parse() calls.
      assert.deepEqual(await extractAll(tar, 100), expected);
    });
  }

  it("falls back to the header name when an empty pax path record follows a path", async () => {
    // An empty pax value deletes the keyword, including a path set by an
    // earlier extended header, rather than naming the file "".
    function entry(name, typeflag, content) {
      const header = Buffer.alloc(512);
      Buffer.from(name).copy(header, 0);
      Buffer.from(content.length.toString(8).padStart(11, "0") + "\0").copy(header, 124);
      header[156] = typeflag.charCodeAt(0);
      Buffer.from("ustar\u000000").copy(header, 257);
      const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      Buffer.from(content).copy(padded, 0);
      return Buffer.concat([header, padded]);
    }
    const tar = new Uint8Array(Buffer.concat([
      entry("PaxHeader/stale.txt", "x", "25 path=package/stale.txt\n"),
      entry("PaxHeader/file.txt", "x", "8 path=\n"),
      entry("package/file.txt", "0", "file\n"),
      Buffer.alloc(1024),
    ]));

    assert.deepEqual(await extractAll(tar, tar.length), [["package/file.txt", "file\n"]]);
  });
});

describe('streaming parser', () => {
  // Header, content and padding blocks of one entry. `gnu` writes the GNU
  // magic ("ustar  \0") instead of POSIX "ustar\0" "00".
  function entry({ name, content = "", prefix = "", typeflag = "0", gnu = false, size }) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    Buffer.from(name).copy(header, 0);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    const declared = size === undefined ? data.length : size;
    Buffer.from(declared.toString(8).padStart(11, "0") + "\0").copy(header, 124);
    Buffer.from("00000000000\0").copy(header, 136);
    header.fill(0x20, 148, 156);
    Buffer.from(typeflag).copy(header, 156);
    Buffer.from(gnu ? "ustar  \0" : "ustar\u000000").copy(header, 257);
    Buffer.from(prefix).copy(header, 345);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
    if (size !== undefined) return header;
    return Buffer.concat([header, data, Buffer.alloc(roundNextSector(data.length) - data.length)]);
  }

  // One pax record: "<length> <key>=<value>\n", where <length> counts the whole record.
  function paxRecord(key, value) {
    const body = " " + key + "=" + value + "\n";
    let length = body.length + 1;
    while (String(length).length + body.length !== length) length = String(length).length + body.length;
    return length + body;
  }

  function chunked(bytes, size) {
    const chunks = [];
    for (let i = 0; i < bytes.byteLength; i += size) chunks.push(bytes.slice(i, i + size));
    return chunks;
  }

  const text = (bytes) => Buffer.from(bytes).toString("latin1");

  async function stream(chunks, filter) {
    const parser = new StreamingUSTarParser({ filter });
    const files = [];
    parser.on("file", (name, content) => { files.push([name, text(content)]); });
    for (const chunk of chunks) await parser.write(chunk);
    parser.close();
    return { files, parser };
  }

  async function whole(tar) {
    const parser = new USTarParser();
    const files = [];
    parser.on("file", (name, content) => { files.push([name, text(content)]); });
    await parser.parse(tar);
    return files;
  }

  const deep = "a".repeat(60) + "/" + "b".repeat(60);

  // Every header variant the parsers handle, followed by the end-of-archive
  // blocks and an entry that must be ignored.
  const edgeCaseTar = new Uint8Array(Buffer.concat([
    entry({ name: "package/plain.js", content: "plain\n" }),
    entry({ name: "package/dist/", typeflag: "5" }),
    entry({ prefix: "package/" + deep, name: "ustar.js", content: "ustar\n" }),
    entry({ name: "PaxHeader/pax.js", typeflag: "x", content: paxRecord("path", "package/" + deep + "/pax.js") }),
    entry({ name: "package/truncated-pax-name.js", content: "pax\n" }),
    entry({ name: "PaxHeader/empty", typeflag: "x", content: paxRecord("path", "") }),
    entry({ name: "package/pax-empty-falls-back.js", content: "fallback\n" }),
    entry({ name: "././@LongLink", typeflag: "L", content: "package/" + deep + "/gnu.js\0" }),
    entry({ name: "pax_global_header", typeflag: "g", content: paxRecord("comment", "x") }),
    entry({ name: "package/truncated-gnu-name.js", content: "gnu\n", gnu: true }),
    entry({ name: "././@LongLink", typeflag: "L", content: "package/" + deep + "/dropped.js\0" }),
    entry({ name: "package/link", typeflag: "2" }),
    entry({ name: "package/after-link.js", content: "after link\n" }),
    entry({ name: "package/gnu-prefix-ignored.js", prefix: "not-a-prefix", content: "gnu\n", gnu: true }),
    entry({ name: "package/old-type.js", content: "nul type\n", typeflag: "\0" }),
    entry({ name: "package/empty.js" }),
    entry({ name: "package/exact-block.js", content: "x".repeat(512) }),
    Buffer.alloc(1024),
    entry({ name: "package/after-end.js", content: "must not be read\n" }),
  ]));

  for (const size of [1, 7, 511, 512, 513, 4096, edgeCaseTar.byteLength]) {
    it("matches USTarParser in " + size + "-byte chunks", async () => {
      const { files } = await stream(chunked(edgeCaseTar, size));
      assert.deepEqual(files, await whole(edgeCaseTar));
    });
  }

  it("resolves every header variant in the edge-case archive", async () => {
    const { files } = await stream([edgeCaseTar]);
    assert.deepEqual(files.map(([name]) => name), [
      "package/plain.js",
      "package/" + deep + "/ustar.js",
      "package/" + deep + "/pax.js",
      "package/pax-empty-falls-back.js",
      "package/" + deep + "/gnu.js",
      "package/after-link.js",
      "package/gnu-prefix-ignored.js",
      "package/old-type.js",
      "package/empty.js",
      "package/exact-block.js",
    ]);
  });

  it("matches USTarParser on the fixtures", async () => {
    for (const name of ["hi-sven-1.0.0.tar", "random.tar", "fa-regular-400.tar"]) {
      const tar = new Uint8Array(readFileSync(join("fixtures", name)));
      const { files } = await stream(chunked(tar, 1000));
      assert.deepEqual(files, await whole(tar), name);
    }
  });

  it("skips a filtered-out entry without buffering it", async () => {
    const size = 64 * 1024 * 1024;
    const zeros = new Uint8Array(1024 * 1024);
    const chunks = [
      entry({ name: "repo/spec/assets/large.xml", size }),
      ...Array.from({ length: size / zeros.byteLength }, () => zeros),
      entry({ name: "repo/lib/fxparser.min.js", content: "parser\n" }),
      new Uint8Array(1024),
    ];
    const { files, parser } = await stream(chunks, (name) => name.startsWith("repo/lib/"));
    assert.deepEqual(files, [["repo/lib/fxparser.min.js", "parser\n"]]);
    assert.equal(parser.peakBufferedBytes, "parser\n".length);
  });

  it("asks the filter about regular files only, with their resolved paths", async () => {
    const asked = [];
    const { files } = await stream([edgeCaseTar], (name) => { asked.push(name); return false; });
    assert.deepEqual(files, []);
    assert.deepEqual(asked, (await whole(edgeCaseTar)).map(([name]) => name));
  });

  it("waits for the file hook before reading the next entry", async () => {
    const events = [];
    const parser = new StreamingUSTarParser();
    parser.on("file", async (name) => {
      events.push("start " + name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("end " + name);
    });
    await parser.write(new Uint8Array(Buffer.concat([
      entry({ name: "p/a", content: "a" }),
      entry({ name: "p/b", content: "b" }),
    ])));
    assert.deepEqual(events, ["start p/a", "end p/a", "start p/b", "end p/b"]);
  });

  it("fails on close when the stream ends inside an entry", async () => {
    const tar = new Uint8Array(entry({ name: "p/a.js", content: "abcdef" }));
    const parser = new StreamingUSTarParser();
    await parser.write(tar.subarray(0, 512 + 3));
    assert.throws(() => parser.close(), /ended in the middle of an entry/);
  });

  it("fails on close when the stream ends inside a header", async () => {
    const tar = new Uint8Array(Buffer.concat([
      entry({ name: "p/a.js", content: "a" }),
      entry({ name: "p/b.js", content: "b" }),
    ]));
    const parser = new StreamingUSTarParser();
    const files = [];
    parser.on("file", (name) => { files.push(name); });
    await parser.write(tar.subarray(0, 1024 + 100));
    assert.deepEqual(files, ["p/a.js"]);
    assert.throws(() => parser.close(), /ended in the middle of an entry/);
  });

  it("fails on close when the stream ends inside an entry's padding", async () => {
    const tar = new Uint8Array(entry({ name: "p/a.js", content: "abc" }));
    const parser = new StreamingUSTarParser();
    const files = [];
    parser.on("file", (name) => { files.push(name); });
    await parser.write(tar.subarray(0, 512 + 100));
    assert.deepEqual(files, ["p/a.js"]);
    assert.throws(() => parser.close(), /ended in the middle of an entry/);
  });

  it("accepts a stream that ends after a complete entry without end-of-archive blocks", async () => {
    const { files } = await stream([new Uint8Array(entry({ name: "p/a.js", content: "abc" }))]);
    assert.deepEqual(files, [["p/a.js", "abc"]]);
  });

  it("rejects write when the file hook rejects", async () => {
    const parser = new StreamingUSTarParser();
    parser.on("file", async () => { throw new Error("hook failed"); });
    let error = null;
    await parser.write(new Uint8Array(entry({ name: "p/a.js", content: "a" }))).catch((e) => { error = e; });
    assert.match(String(error), /hook failed/);
  });

  it("fails on a size field that is not octal", async () => {
    const header = entry({ name: "p/a.js" });
    Buffer.from("0000000009x\0").copy(header, 124);
    const parser = new StreamingUSTarParser();
    let error = null;
    await parser.write(new Uint8Array(header)).catch((e) => { error = e; });
    assert.match(String(error), /invalid size field/);
  });

  it("fails on pax metadata larger than MAX_META_BYTES instead of buffering it", async () => {
    const header = entry({ name: "PaxHeader/huge", typeflag: "x", size: MAX_META_BYTES + 1 });
    const parser = new StreamingUSTarParser();
    let error = null;
    await parser.write(new Uint8Array(header)).catch((e) => { error = e; });
    assert.match(String(error), /pax header of \d+ bytes exceeds/);
    assert.equal(parser.peakBufferedBytes, 0);
  });

  it("fails on a GNU long name larger than MAX_META_BYTES instead of buffering it", async () => {
    const header = entry({ name: "././@LongLink", typeflag: "L", size: MAX_META_BYTES + 1 });
    const parser = new StreamingUSTarParser();
    let error = null;
    await parser.write(new Uint8Array(header)).catch((e) => { error = e; });
    assert.match(String(error), /GNU long name of \d+ bytes exceeds/);
    assert.equal(parser.peakBufferedBytes, 0);
  });
});

