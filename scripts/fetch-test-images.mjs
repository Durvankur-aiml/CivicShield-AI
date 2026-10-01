/**
 * Downloads REAL civic test photos from Wikimedia Commons so the YOLO test
 * protocol (scripts/test-yolo.mjs) can run on genuine images, not synthetic
 * ones. Results of inference are still reported verbatim by the harness.
 *
 *   node scripts/fetch-test-images.mjs
 *
 * Files land in scripts/fixtures/{pothole,garbage,water,streetlight}.jpg
 * (gitignored). Images are CC/PD licensed on Commons; attribution: the
 * Commons file page (printed below).
 */
import { writeFile, mkdir } from "fs/promises";
import path from "path";

const UA = "CivicShieldAI-hackathon-test/1.0 (contact: project team)";
const OUT_DIR = path.join(process.cwd(), "scripts", "fixtures");

const WANT = [
  { file: "pothole.jpg", search: "pothole road asphalt" },
  { file: "garbage.jpg", search: "garbage bags street litter" },
  { file: "water.jpg", search: "flooded street waterlogging rain" },
  { file: "streetlight.jpg", search: "street light night road" },
];

const API = "https://commons.wikimedia.org/w/api.php";

async function candidates(search) {
  const url = `${API}?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(
    `filetype:bitmap ${search}`
  )}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1024`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const data = await res.json();
  const pages = Object.values(data?.query?.pages ?? {});
  const out = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    if (info.mime !== "image/jpeg") continue;
    if ((info.width ?? 0) < 640 || (info.height ?? 0) < 480) continue;
    out.push({
      url: info.thumburl ?? info.url,
      page: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      title: p.title,
      w: info.width,
      h: info.height,
    });
  }
  return out;
}

await mkdir(OUT_DIR, { recursive: true });

for (const want of WANT) {
  const dest = path.join(OUT_DIR, want.file);
  let done = false;
  try {
    const list = await candidates(want.search);
    for (const c of list) {
      try {
        const res = await fetch(c.url, { headers: { "User-Agent": UA } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 30_000) continue; // skip tiny thumbnails
        await writeFile(dest, buf);
        console.log(`✓ ${want.file}  ← ${c.title} (${c.w}×${c.h})  ${(buf.length / 1024).toFixed(0)}KB`);
        console.log(`   source: ${c.page}`);
        done = true;
        break;
      } catch {
        continue; // try the next candidate
      }
    }
  } catch (e) {
    console.error(`search failed for "${want.search}":`, e.message);
  }
  if (!done) {
    console.error(`✖ could not fetch a suitable image for ${want.file} — download one manually and retry`);
    process.exitCode = 1;
  }
}
