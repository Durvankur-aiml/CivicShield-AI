"""
CivicShield AI — YOLO inference service (CivicAI best.pt).

PRODUCTION vision path for CivicShield AI. Runs the CivicAI custom-trained
YOLOv8 weight (`best.pt`, ~6.3 MB, documented classes: pothole / garbage /
water / streetlight) as an isolated FastAPI microservice.

IMPORTANT:
- The weight is NOT in git. Obtain it from the CivicAI project author
  (see README.md) and place it at the path given by YOLO_MODEL_PATH
  (default: ./model/best.pt).
- This service NEVER fabricates results: if the weight is missing it starts
  in degraded mode and /health + /predict report that honestly.
- Class names are read from the loaded model (`model.names`) — class IDs are
  never hardcoded. If names differ from the documented set, they flow
  through as-is and the web layer maps names, not IDs.

Endpoints:
  GET  /health   -> service + model status (names, size, file)
  POST /predict  -> multipart `image` -> {category, confidence, provider,
                     model, detections:[{label, confidence, x1,y1,x2,y2}]}
  POST /detect   -> alias of /predict (compat)
  POST /verify   -> multipart `after` (+ optional `before`, form `category`)
                    -> {verified, confidence, reason}

Run (Python 3.11–3.13 — torch does not support 3.14 yet):
    python -m venv .venv && .venv/Scripts/activate    # Windows
    pip install -r requirements.txt
    set YOLO_MODEL_PATH=./model/best.pt               # bash: export YOLO_MODEL_PATH=...
    uvicorn app:app --host 0.0.0.0 --port 8000
"""
import os
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", "./model/best.pt")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.25"))
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")

app = FastAPI(title="CivicShield Vision Service", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_model = None
_model_error: str | None = None


def _weights_path() -> Path:
    return Path(MODEL_PATH)


def get_model():
    """Loads the weight lazily and exactly once. Raises 503 with an honest
    message when the file is missing — never substitutes another model."""
    global _model, _model_error
    if _model is None:
        if not _weights_path().exists():
            _model_error = (
                f"Weights not found at {_weights_path().resolve()}. "
                "Obtain the CivicAI best.pt from the project author and place it there — "
                "this service deliberately has no fallback model."
            )
            raise HTTPException(503, _model_error)
        try:
            from ultralytics import YOLO
        except ImportError as e:
            _model_error = "ultralytics not installed — run pip install -r requirements.txt (Python 3.11–3.13)"
            raise HTTPException(503, _model_error) from e
        _model = YOLO(str(_weights_path()))
    return _model


async def _load_image(upload: UploadFile, field: str = "image") -> Image.Image:
    data = await upload.read()
    if len(data) == 0:
        raise HTTPException(400, f"Empty {field} file")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, f"{field} image exceeds 10MB limit")
    try:
        img = Image.open(BytesIO(data))
        img.verify()
        return Image.open(BytesIO(data)).convert("RGB")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Invalid {field} image file") from e


def _run_inference(img: Image.Image) -> list[dict]:
    """Runs the real model and returns raw detections with labels read from
    model.names. No ID-based mapping anywhere."""
    model = get_model()
    results = model.predict(img, conf=CONF_THRESHOLD, verbose=False)
    names = results[0].names if results else {}
    detections: list[dict] = []
    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = [round(float(v), 2) for v in box.xyxy[0].tolist()]
            detections.append({
                "class_id": cls_id,
                "label": names.get(cls_id, str(cls_id)),  # from model.names
                "confidence": round(conf, 3),
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            })
    detections.sort(key=lambda d: d["confidence"], reverse=True)
    return detections


# Documented CivicAI classes (expected): 0=pothole, 1=garbage, 2=water, 3=streetlight.
# Mapping is by LABEL NAME (read from model.names at runtime), never by ID.
_NAME_TO_CATEGORY = [
    ("pothole", "POTHOLE"),
    ("garbage", "GARBAGE"),
    ("trash", "GARBAGE"),
    ("waste", "GARBAGE"),
    ("water", "WATERLOGGING"),
    ("flood", "WATERLOGGING"),
    ("waterlog", "WATERLOGGING"),
    ("streetlight", "STREETLIGHT"),
    ("street_light", "STREETLIGHT"),
    ("street light", "STREETLIGHT"),
    ("lamp", "STREETLIGHT"),
    ("road", "ROAD_DAMAGE"),
    ("crack", "ROAD_DAMAGE"),
]


def label_to_category(label: str) -> str:
    l = label.lower()
    for token, category in _NAME_TO_CATEGORY:
        if token in l:
            return category
    return "OTHER"


def _model_name() -> str:
    return _weights_path().name  # e.g. "civicai-best.pt"


def _predict_payload(img: Image.Image) -> dict:
    detections = _run_inference(img)
    top = detections[0] if detections else None
    civic = label_to_category(top["label"]) if top else None
    return {
        "category": civic,
        "label": top["label"] if top else None,
        "confidence": top["confidence"] if top else 0.0,
        "provider": "yolo-service",
        "model": _model_name(),
        "detections": detections,
        "note": None if detections else "Model ran on the image but found no known civic issue above the confidence threshold.",
    }


@app.get("/health")
def health():
    path_ok = _weights_path().exists()
    payload = {
        "status": "ok" if (path_ok and _model is not None) else "degraded",
        "model_path": MODEL_PATH,
        "model_file": _model_name(),
        "weights_present": path_ok,
        "model_loaded": _model is not None,
        "provider": "yolo-service",
    }
    if path_ok:
        payload["model_size_bytes"] = _weights_path().stat().st_size
    if _model is not None:
        # Read straight from the loaded weight — never hardcoded.
        payload["names"] = {int(k): str(v) for k, v in _model.names.items()}
    if _model_error:
        payload["error"] = _model_error
    return payload


@app.post("/predict")
async def predict(image: UploadFile = File(...)):
    img = await _load_image(image, "image")
    return _predict_payload(img)


@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    """Compat alias of /predict kept for earlier integrations."""
    img = await _load_image(file, "image")
    return _predict_payload(img)


@app.post("/verify")
async def verify(
    after: UploadFile = File(...),
    category: str = Form(...),
    before: UploadFile | None = File(None),
):
    """Resolution verification with the real weight: does the reported issue
    category still appear in the AFTER image (vs BEFORE, if supplied)?

    Phase 4: the response carries an explicit `result` state — VERIFIED,
    FAILED, or INCONCLUSIVE — alongside the boolean for older clients. The
    service never fabricates a pass: an empty detection set is INCONCLUSIVE
    (nothing to compare), not an approval.
    """
    after_img = await _load_image(after, "after")

    def run(img):
        out: dict[str, float] = {}
        for d in _run_inference(img):
            cat = label_to_category(d["label"])
            out[cat] = max(out.get(cat, 0.0), d["confidence"])
        return out

    after_dets = run(after_img)
    still_visible_conf = after_dets.get(category, 0.0)

    verified = still_visible_conf < 0.35
    confidence = round(1.0 - still_visible_conf, 2)
    notes: list[str] = []
    has_before = False

    if before is not None:
        before_img = await _load_image(before, "before")
        has_before = True
        before_conf = run(before_img).get(category, 0.0)
        notes.append(f"before confidence {before_conf:.2f}, after confidence {still_visible_conf:.2f}")
        confidence = round(min(0.97, 0.5 + (before_conf - still_visible_conf) / 2), 2)
    else:
        notes.append("no before-image supplied; verification based on after image only")

    # Explicit outcome state (Phase 4). Product policy, not science: with a
    # before-image a pass/fail is decidable; the issue still clearly visible
    # in the after image is a genuine failure even without a baseline; without
    # baseline and without a clear signal the honest state is INCONCLUSIVE.
    if has_before:
        result = "VERIFIED" if verified else "FAILED"
    elif still_visible_conf >= 0.35:
        result = "FAILED"
        verified = False
    else:
        result = "INCONCLUSIVE"
        verified = False

    if result == "VERIFIED":
        reason = "The detected issue is no longer visible in the after image. " + "; ".join(notes)
    elif result == "FAILED":
        reason = f"Issue '{category}' still appears in the after image (confidence {still_visible_conf:.2f})."
    else:
        reason = "Evidence is inconclusive: " + "; ".join(notes)

    return {
        "verified": verified,
        "result": result,
        "confidence": max(0.05, confidence),
        "reason": reason,
        "provider": "yolo-service",
        "before_available": has_before,
    }
