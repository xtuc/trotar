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
    async write(chunk) {
      parser.write(chunk);
    },

    close() { console.log("closed"); },
    abort(err) { console.error("Sink error:", err); },
  },
);

const ds = new DecompressionStream('gzip')

res.body.pipeThrough(ds).pipeTo(writableStream)
```
