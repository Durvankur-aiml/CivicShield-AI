// Generates tiny "JPEG" fixtures for the smoke test.
// Note: the dev verification provider analyzes raw byte statistics, so these
// padded JPEG payloads are sufficient for exercising the pipeline end-to-end.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const dir = path.join(process.cwd(), "scripts", "fixtures");
mkdirSync(dir, { recursive: true });

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function makeJpeg(fill) {
  const body = Buffer.alloc(80_000, fill);
  return Buffer.concat([JPEG_MAGIC, body, Buffer.from([0xff, 0xd9])]);
}

writeFileSync(path.join(dir, "before-dark.jpg"), makeJpeg(12));
writeFileSync(path.join(dir, "after-bright.jpg"), makeJpeg(200));
console.log("fixtures written to", dir);
