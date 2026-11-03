# trotar

> A performant tar parser with streaming support

## Usage

```js
import { USTarParser } from "trotar"
const parser = new USTarParser;

parser.on("file", (name, content) => {
  console.log("file", name, "has", content);
});

await parser.parse(tar);
```

With streaming:
```js
import { StreamingUSTarParser } from "trotar"

const parser = new StreamingUSTarParser

parser.on("file", (name, content) => {
  console.log("file", name, "has", content);
})

const res = await fetch("https://registry.npmjs.org/hi-sven/-/hi-sven-1.29.0.tgz")

const writableStream = new WritableStream(
  {
    // Wait for the parser before taking the next chunk.
    write(chunk) {
      return parser.write(chunk);
    },

    close() {
      // Throws if the stream ended in the middle of an entry.
      parser.close();
    },
    abort(err) { console.error("Sink error:", err); },
  },
);

const ds = new DecompressionStream('gzip')

res.body.pipeThrough(ds).pipeTo(writableStream)
```

The streaming parser buffers one entry at a time. To skip files without
buffering them, pass a `filter`. It gets each regular file's full path before
the content is read:

```js
const parser = new StreamingUSTarParser({
  filter: (name) => name.startsWith("package/dist/"),
})
```

The `file` hook is awaited before the next entry is read, so returning a
promise from it holds the stream back.

The streaming parser throws on a size field that is not octal and on pax or
GNU long-name metadata larger than `MAX_META_BYTES` (1 MiB).
