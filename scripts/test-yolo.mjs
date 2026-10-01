/**
 * Real-image YOLO test harness (honest results only).
 *
 *   node scripts/test-yolo.mjs <image1> [image2 ...]
 *   YOLO_SERVICE_URL=http://localhost:8000
 *
 * Sends each image to the vision service /predict endpoint and prints the
 * ACTUAL returned class, confidence, bounding boxes and provider/model.
 * It never fabricates or asserts expected detections — if the model finds
 * nothing, that is reported as-is. A missing weight surfaces the service's
 * 503 message verbatim.
 */
const BASE = process.env.YOLO_SERVICE_URL ?? "http://localhost:8000";
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("Usage: node scripts/test-yolo.mjs <image1> [image2 ...]");
  process.exit(1);
}

console.log(`YOLO service: ${BASE}\n`);

// 0. Health (honest state of the service + weight)
const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
console.log("health:", JSON.stringify(health, null, 2));
if (health.weights_present === false) {
  console.error("\n✖ Weights are not present on the service. Place CivicAI best.pt at the configured YOLO_MODEL_PATH and restart. Aborting before sending images (results would not be real).");
  process.exit(1);
}
console.log();

let exitCode = 0;
for (const file of files) {
  const buf = await import("fs/promises").then((fs) => fs.readFile(file));
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(buf)], { type: "image/jpeg" }), file.split(/[\\/]/).pop());
  const res = await fetch(`${BASE}/predict`, { method: "POST", body: form });
  const data = await res.json().catch(() => null);
  console.log(`── ${file}`);
  if (!res.ok || !data) {
    console.log(`   HTTP ${res.status}: ${data?.detail ?? "(no body)"}`);
    exitCode = 1;
    continue;
  }
  if (!data.category && data.note) console.log(`   NOTE: ${data.note}`);
  console.log(`   category:   ${data.category ?? "(none)"}`);
  console.log(`   label:      ${data.label ?? "(none)"}`);
  console.log(`   confidence: ${data.confidence}`);
  console.log(`   provider:   ${data.provider} · model: ${data.model}`);
  if (data.detections?.length) {
    for (const d of data.detections) {
      console.log(`   • ${d.label} @ ${(d.confidence * 100).toFixed(1)}%  bbox=(${d.x1}, ${d.y1}, ${d.x2}, ${d.y2})`);
    }
  } else {
    console.log("   • no detections above threshold — reported honestly");
  }
  console.log();
}

process.exit(exitCode);
