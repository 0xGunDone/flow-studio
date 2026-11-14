# Flow Studio 1.3.0 — Alpha / Pre-release

Candidate for review: `releaseReady: false`, `published: false`. Omni 1.2 Edit output is not verified; this candidate is not marked feature-complete.

## Changes

- Supported Nano Banana image models, Omni 1.2 Flash video modes and standard Veo 3.1 variants now use an app-owned browser through normal generation. Exact model IDs, prompt, reference order, frame roles and selected account stay fixed. Unsupported combinations fail without model/account/engine substitution.
- Up to seven Omni image ingredients, explicit start/end Frames, image references, one source video for Omni 1.2 Edit with model-specific validation, and original-size downloads share normal history and save controls. Edit source-video output remains pending final live verification.
- History verification binds exact full prompt, ordered image references, selected output poster and the owning download-control/menu chain to one observed selected entry. Existing image and video downloads and receipt-based recovery passed without another generation. Edit source-video association still needs its own live proof.
- Private submission receipts are persisted before the single guarded submission. Unknown jobs can be checked and downloaded into the same history item without a new upload or paid request.
- Account participation is an explicit user choice, separate from backend session availability. Local cooldowns persist for 30 minutes; explicit manual reset changes only the local timer and preserves the last error and manual disabled state. It does not change Google restrictions or start generation.
- MCP API 3 exposes 24 tools, including local preparation, opt-in no-spend browser upload checks, existing-job recovery, account participation, connection/batch checks and local cooldown reset. The adapter can run outside a cloud-synced source folder; reconnect the MCP client for the current schema.
- Shutdown blocks new actions, drains owned browser/bridge/history/backend work, handles SIGTERM/SIGINT, and allows retry after failure. Managed startup pins one full container ID and Compose ownership labels; shutdown rechecks that identity and stops only that container without rereading a cloud-backed Compose file.
- CI now includes `test_video_inputs.py` in the backend suite list; the prerelease workflow reuses that CI job.

## Verified scope

Installed-app checks include Omni 1.2 text-only video; one- and two-distinct-image ingredients; separate start/end Frames; Veo 3.1 Lite Ingredients/R2V at 8 seconds with one reference; standard image generation with two references; original receipt-based recovery; native Save As and Open Folder; explicit cooldown reset; and serial account checks with attributed per-account failures.

Existing Nano Banana 2.1 portrait image was downloaded through its bound 2K Upscaled option without generating another image. The output measured 1536×2752 versus its standard 768×1376 version. This verifies that existing-result upscale case, not every family, aspect or 4K output.

No-spend Omni 1.2 Edit preparation with one source video and two image references passed in the installed app: the source scene and account were checked, references attached, and the owned prompt cleared without submission. Actual installed-app Edit generation attempts reached Google but returned `providerFailed`; no completed Edit output was verified. The user reports editing works in the ordinary Flow web UI with the same account. This candidate does not establish model or regional unavailability.

The current source passed one complete Node run: 496 tests across 28 files, no failures or skips. All 14 backend CI suites passed, 104 tests. Installed-app SIGTERM testing confirmed app exit and its managed backend changing from running to stopped without reading the cloud-backed Compose file. Final package signatures, architectures, extracted archives and SHA256 manifest are checked separately for this candidate; earlier 1.3.0 preview assets are stale.

## Requirements and limits

- macOS, Google Chrome, and Docker Desktop or Colima with Docker CLI/Compose. MCP needs Node.js 22.12 or newer.
- Builds use ad-hoc signatures; no Apple Developer ID signature or notarization.
- A model in the catalog does not establish account entitlement, available credits or Google acceptance. Google can reject a request, including `PUBLIC_ERROR_UNUSUAL_ACTIVITY`; the app reports that result without automatic paid retry or account rotation.
- Veo 4/6-second variants require Ultra. The currently observed Pro editor provides 8 seconds/720p; an unavailable requested duration fails before submission instead of becoming an 8-second request.
- Nano Banana 2 Lite remains standard-only. Nano Banana 2.1/Pro 2K/4K use explicit Flow download upscales; 4K and other families/aspects are not claimed live-verified.
- Current Omni 1.2 Edit source geometry must exactly match the requested mode: portrait 360×640 or landscape 640×360 at 360p; portrait 720×1280 or landscape 1280×720 at standard 720p. The app does not silently resize or replace the selected model. Downloaded Edit media must match the source dimensions and duration (within 0.15 seconds) before completion. A result above 100 MiB or unavailable probe reports `OUTPUT_METADATA_UNAVAILABLE`; mismatch reports `MODEL_SETTINGS_NOT_VERIFIED`, retaining unknown outcome without retry. Google video-rights terms are a separate user choice. Actual source-video association and Edit output proof remain a publication gate for this draft.
- Closing the app stops local waiting and its owned browser/backend. Google may continue an accepted job; checking an existing receipt is not a new submission.
- Intel packages can be built on Apple Silicon; that does not replace a physical Intel-Mac test.

## Assets

The candidate asset set is arm64/x64 ZIP and DMG files, MCP and extension source ZIPs, and `SHA256SUMS.txt`. The MCP ZIP includes the complete `skills/flow-studio/` skill and install instructions. Publication remains a separate decision; preserve the verified scope and current Edit limit in any Alpha pre-release.
