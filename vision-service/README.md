# CivicShield Vision Service — CivicAI best.pt

The **production** computer-vision path for CivicShield AI: a FastAPI service
running the CivicAI custom-trained YOLOv8 weight (`best.pt`) for issue
detection and resolution verification.

> **Status (2026-09-20):** the service implementation is complete and running,
> but `best.pt` has **not yet been obtained** (see below), so real-model
> inference has **not** been verified. Until then CivicShield uses its
> clearly-labeled development provider — this is disclosed in the UI, agent
> log, and `/api/health/ai`.

## Where `best.pt` comes from (verified)

**`best.pt` is not publicly available from the CivicAI repository.** Verified
2026-09-20 via the GitHub API: no releases exist, and `model/` contains only
`confusion_matrix.png` and `results.png`. The author's `docs/yolo_ec2_setup.md`
lists the weight as a private prerequisite (`runs/detect/civicai-gpu/weights/
best.pt`, 6.3 MB) that they copied to EC2 with `scp`.

**Legitimate way to obtain it:** ask the CivicAI author
(https://github.com/Sujit-1509) to share the exact file (Google Drive /
WhatsApp / attach to a GitHub Release). This project does not train,
re-train, substitute, or fabricate a model — Task rule.

Place the file at:

```
vision-service/model/best.pt     (or set YOLO_MODEL_PATH)
```

## Endpoints

| Endpoint | Body | Response |
|---|---|---|
| `GET /health` | — | `{status, model_path, model_file, weights_present, model_loaded, names?}` |
| `POST /predict` | multipart `image` | `{category, label, confidence, provider, model, detections:[{label, confidence, x1, y1, x2, y2}]}` — `category` is the highest-confidence civic category; `note` explains when nothing was detected |
| `POST /detect` | multipart `file` | compat alias of `/predict` |
| `POST /verify` | multipart `after`, form `category`, optional multipart `before` | `{verified, confidence, reason}` |

Class names are read from the loaded weight (`model.names`) and mapped to
CivicShield categories **by name** (pothole→POTHOLE, garbage→GARBAGE,
water→WATERLOGGING, streetlight→STREETLIGHT) — class IDs are never hardcoded.
Expected documented classes: `0=pothole, 1=garbage, 2=water, 3=streetlight`.

## Setup (verified on Python 3.14.2)

```bash
cd vision-service
python -m venv .venv && .venv/Scripts/activate     # Windows (bash: source .venv/bin/activate)
pip install -r requirements.txt                    # ultralytics 8.4.156, torch 2.14.0+cpu verified
uvicorn app:app --port 8000
```

Then in the web app `.env`:

```
YOLO_SERVICE_URL=http://localhost:8000
```

The web app now reports provider `yolo-service` + model file (e.g.
`civicai-best.pt`) in the Agent Activity panel as **REAL YOLO MODEL**. If the
service is down or refuses, the labeled development provider is used and that
fact is disclosed — results are never silently faked.

## Honest behavior without the weight

- `GET /health` → `{"status":"degraded","weights_present":false,"model_loaded":false,...}`
- `POST /predict` → **503** `{"detail":"Weights not found at …best.pt. Obtain the CivicAI best.pt from the project author and place it there — this service deliberately has no fallback model."}`

(Both verified live on this machine.)

## Real-image test protocol (run once the weight is placed)

```bash
# 1. fetch four real civic photos from Wikimedia Commons (one-time)
node scripts/fetch-test-images.mjs      # → scripts/fixtures/{pothole,garbage,water,streetlight}.jpg

# 2. run the honest inference harness
node scripts/test-yolo.mjs scripts/fixtures/pothole.jpg scripts/fixtures/garbage.jpg scripts/fixtures/water.jpg scripts/fixtures/streetlight.jpg
```

The harness prints the ACTUAL class, confidence and bounding boxes returned
by the model — nothing is asserted or fabricated; "no detections" is reported
as-is. Record the output in the demo notes. A full end-to-end check: start
the web app, submit a real pothole photo, and confirm the Agent Activity
panel shows `VisionAgent → … detected (…% confidence, provider yolo-service,
model best.pt)` with the **REAL YOLO MODEL** chip.

## Permissions note

The weight is an external, custom-trained model dependency from the CivicAI
project. The team must confirm the author's permission to use it before
submission; the README attribution intentionally omits "used with permission"
until that confirmation exists.
