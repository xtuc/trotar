const { UsTarParser, str, assertUsTar, roundNextSector, isTarSector } = require("./index.js");
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
    assert.isTrue(isTarSector(b, 0));

    const b1 = [...new Array(257 + 100), 117, 115, 116, 97, 114];
    assert.isTrue(isTarSector(b1, 100));

    const b2 = [...new Array(257), 0, 0, 0, 97, 114];
    assert.isFalse(isTarSector(b1));
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
    const parser = new UsTarParser;
    let dump = "";
    parser.on("file", (name, content) => {
      dump += JSON.stringify(name) + "\n";
      dump += JSON.stringify(content) + "\n\n";
    });

    it("dump " + name, () => {
      const fixture = join("fixtures", name);
      const tar = readFileSync(fixture, null);

      parser.write(tar);
      parser.next();

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

