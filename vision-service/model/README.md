# Model weights directory — `best.pt` is NOT in git

Place the CivicAI trained weight here:

```
vision-service/model/best.pt
```

## Where it comes from (verified 2026-09-20)

**`best.pt` is not publicly available from the CivicAI repository.** Verified
via the GitHub API: the repo has no releases, and `model/` contains only
`confusion_matrix.png` and `results.png`. The author's own docs
(`docs/yolo_ec2_setup.md`) list the trained weight as a private prerequisite
— `runs/detect/civicai-gpu/weights/best.pt` (6.3 MB) — which they copied to
their EC2 instance with `scp`.

**Legitimate way to obtain it:** ask the CivicAI author
(https://github.com/Sujit-1509) to share the file directly (Google Drive,
WhatsApp, or attach it to a GitHub Release). Do not substitute another
model, do not train a replacement, and do not fabricate the file.

Once placed here, the service picks it up automatically via
`YOLO_MODEL_PATH` (default `./model/best.pt`) and reads the class names from
the weight itself (`model.names`).

Expected documented classes: `0=pothole, 1=garbage, 2=water, 3=streetlight`
— but the service maps by **name** from `model.names`, never by hard-coded ID.
