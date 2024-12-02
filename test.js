const { StreamingUSTarParser, USTarParser, str, assertUsTar, roundNextSector, isTarSector } = require("./index.js");
const { join } = require("path");
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

