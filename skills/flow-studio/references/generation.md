# Generation settings and inputs

Read after `status` and filtered `list_models`, before preparing a generation. Examples are templates: substitute values from the user and live catalog. They do not authorize spending.

## Choose a model

Both `prepare_generation` and `generate` require `prompt` and **exactly one** selector:

- `model`: exact `id` from `list_models`; optional outer `method` pins its input method.
- `settings`: strict object below; outer `method` is forbidden.

```json
{
  "settings": {
    "kind": "video",
    "method": "frames",
    "family": "<EXACT_FAMILY_FROM_LIST_MODELS>",
    "durationSeconds": 8,
    "aspectRatio": "16:9",
    "resolution": "standard"
  },
  "prompt": "<USER_PROMPT>",
  "startFramePath": "/absolute/path/start.png",
  "endFramePath": "/absolute/path/end.png"
}
```

`settings` accepts only `kind`, `method`, `family`, `durationSeconds`, `aspectRatio`, `resolution`. Kind is `image` or `video`; method is `image`, `text`, `ingredients`, `frames`, `edit`, or `extend`. Images use method `image`; video uses the other methods. `family` and `aspectRatio` must match catalog metadata. Omitted `resolution` means `standard`. `durationSeconds` is required for video except `edit`, and forbidden for images and `edit`. Edit duration comes from the source (`durationSource: "input_video"`). Ambiguous or unavailable settings return an error; never substitute a nearby combination.

List filters use the same settings fields plus legacy `mode` and `query`. Read `methods` and `inputsByMethod` for method-specific limits. Legacy `mode` remains compatible: image models keep `mode: "text"`; Veo ingredients keep `mode: "references"`. Ordinary Omni supports `text` and `ingredients`; with an exact model and omitted outer `method`, references infer ingredients, otherwise text. Explicit ingredients requires at least one reference.

For a new video without an explicit model choice, prefer `Omni 1.2 Flash` only when the live catalog contains a compatible ID. Read `preferred` metadata; if no compatible preferred model is available, report that state without falling back to 1.1. Preserve saved selections, drafts, history, prepared `generateArguments` and identical request replays.

Omni 1.2 Flash supports `text`, `ingredients` and `frames` from 3 through 15 seconds, `16:9` and `9:16`, and `standard` (720p) or `360p`. Frames at 3–10 seconds require a start frame and allow an end frame; at 11–15 seconds they accept only a start frame. Durations above 10 seconds require Pro or Ultra. Read the chosen model's `inputsByMethod`, `requiredTier` and `fileLimits`; account access remains unchecked by preparation. Omni 1.2 extension, audio ingredients and motion inputs are not exposed by this app.

Settings resolution collapses only these known duplicate aliases when their corresponding same-version `-8s-landscape` ID exists: `veo-3.1-lite`, `veo-3.1-fast`, `veo-3.1-quality`, `omni-1.1-flash`, and `omni-1.2-flash`. An exact `model` request preserves the chosen catalog ID, including a legacy alias. This never migrates 1.1 to 1.2. Unknown IDs fail; names are not matched by similarity and absent IDs must not be invented.

## Prepare without spending

Call `flow_studio_prepare_generation` with a selector, prompt, and original local paths. It resolves one exact model and checks absolute paths, file formats, regular files, sizes, counts, and roles. It does not decode media or probe duration. By default it performs no upload, generation, job creation, or persistence, and takes no `requestId` or `confirmCreditSpend`. Optional `checkBrowser:true` uploads requested ingredients for the managed-browser check described below, without submitting.

Success includes `valid`, resolved model metadata, explicit `method`, normalized `settings`, input counts, `generateArguments`, and checks. With a source video:

```json
{
  "localFiles": "passed",
  "videoDuration": "checked_at_submission",
  "accountAccess": "not_checked",
  "credits": "not_checked"
}
```

Without a source video, `videoDuration` is `"not_applicable"`.

`generateArguments` contains exact resolved `model`, explicit `method`, original `prompt`, and original paths/ID; it omits `settings`, `requestId`, and `confirmCreditSpend`. Preserve it unchanged. For the authorized generation, add a fresh stable UUID `requestId` and `confirmCreditSpend: true`. Preparation does not prove account entitlement, balance, source duration, or Google acceptance.

Preparation preserves the supplied prompt in those arguments. Submission currently trims surrounding whitespace; it does not rewrite the prompt content.

## Input roles

| Method | Example preparation fields | Limits |
| --- | --- | --- |
| `image` | `"referencePaths": ["/absolute/reference.png"]` or no references | Up to five images, subject to model |
| `text` | No input fields | No ingredients, frames, video, or source ID |
| `ingredients` | `"referencePaths": ["/absolute/reference.png"]` | At least one; Veo up to three, ordinary Omni up to seven |
| `frames` | `"startFramePath": "/absolute/start.png"`, optional `"endFramePath": "/absolute/end.png"` | Start required; end only when supported and required for `minImages: 2` |
| `edit` | `"videoPaths": ["/absolute/source.mp4"]`, optional `"referencePaths": ["/absolute/style.png"]` | One video plus up to five images |
| `extend` | `"sourceVideoId": "<VERIFIED_MEDIA_GENERATION_ID>"` | Existing Flow media ID only |

Do not combine methods. Never use `referencePaths` as frame slots or send an end frame alone. If the user has not assigned frame roles, resolve them before spending. Preserve ingredient order and frame roles.

Images must be PNG, JPEG, WebP, or GIF, at most 20 MB each. Edit videos must be MP4, MOV, or M4V, at most 100 MiB. `fileLimits.video.maxDurationSeconds` is model-specific: 15 seconds for Omni 1.2 Edit, 10 for Omni 1.1 Edit. Submission checks duration through container `ffprobe`; preparation does not. MCP accepts absolute path fields and uses the same native format/size checks as app file selection and drag-and-drop; it does not accept drag-and-drop events, browser File objects, URLs, or base64.

For extend, obtain `sourceVideoId` from existing job `media[index].mediaGenerationId` or a user-provided verified ID. Never use local `jobId` or a local video file.


## Optional no-spend browser check

`prepare_generation` defaults to local validation. For an explicitly requested upload check, add `checkBrowser:true` and an exact positive `accountId` to a catalog-supported Nano Banana, Omni 1.2, or Veo preparation. Requested image references, explicit frame roles, or an Edit source video are uploaded to Google in the managed browser; the owned composer and settings are checked, then the owned composer is cleared and the browser is released. It never clicks Generate or creates a job. Successful output includes `checks.browser: "passed"`, `checks.upload`, and `browserCheck` with `submitted:false`, `cleared:true`, and uploaded image count. This does not prove credit balance or paid generation acceptance. Never automatically retry this check after failure. `generateArguments` omits `checkBrowser`; the `generate` tool rejects that flag. The bridge response timeout is 600 seconds for `checkBrowser:true` and 120 seconds for ordinary local preparation; allow the same wait in the MCP client, including human rights consent. Expiry never authorizes automatic upload retry.

## Submission and result identity

The background engine persists outcome-unknown before its single guarded submission. Existing image, pending and video cards form the baseline. Recovery after restart reads one selected semantic History entry, compares exact full prompt text and ordered canonical references after lazy-loading completes, and requires its output poster to match the opened result. Before download the same tuple is rechecked; only the entry’s own button and aria-controlled menus may select the original-size option. Missing, ambiguous or changed ownership fails closed. Flow may auto-title a card, so title text is not prompt identity. Read-only existing two-reference image and Veo 720p downloads and original receipt-based recovery passed this path without resubmission. Preparation/upload checks alone do not establish generated media.

An installed-app recovery of an existing paid one-reference task has been verified through actual original-size MP4 download and save (720×1280 H.264/AAC, about 10 seconds). The standard fresh-generation path with one ingredient is also verified for Omni 1.2 Flash 3s portrait 360p through submission, progress, history, original-size download, and save (360×640, 24 fps, AAC, 3.029333 seconds). A separate installed-app Frames task with explicit start and end images also generated and saved a 3.029333-second portrait MP4 360×640 H.264/AAC. Frame roles stay explicit; never turn them into ingredient order. These checks do not establish all models, Edit, account tiers, or input combinations. Download uses Flow’s website original-size button and accepts only its own frame’s validated Flow video URL or `blob:https://flow.google.com/<UUID>`; never fetch an arbitrary URL.

For new-generation tracking errors, the engine may release its browser lease and read the existing durable receipt to recover that same job. This is observation/download only: no second upload, Generate click, request ID, or paid submission. Unknown or mismatched identity remains an error; no account or model rotation.

Nano Banana routing covers exact standard-resolution IDs for three families across five aspects, plus the explicit upscale variants described below. Exact 2K/4K IDs for Nano Banana 2.1 and Pro use the explicit Flow download upscale; Nano Banana 2 Lite remains standard-only. Never return standard size for a requested upscale. Existing-result Nano Banana 2.1 portrait 2K Upscaled download is verified at 1536×2752 versus standard 768×1376, without a new generation; other families/aspects and 4K remain unverified. Installed-app image generation with two distinct references has completed through observation/download/save as JPG 768×1376; a zero-reference image was recovered at 1024×1024. These facts do not validate all families, aspect ratios, or higher-quality variants. A fresh two-different-ingredient Omni 1.2 3s portrait 360p job has also completed through verified MP4 download/save. Omni 1.2 Edit source-video upload uses Google’s separate video-rights consent; paid-generation authorization is not acceptance of those terms. Two installed-app Omni 1.2 Edit jobs through Flow Agent are verified without additional image references: 720p, 9:16, an approximately 10-second source. Each was submitted once; its completed result was recovered from the saved receipt, downloaded and saved without another generation. The measured MP4 is 720×1280 H.264/AAC, 10.026667 seconds; Agent quoted 36 credits for this source. Continuous automatic completion without a separate recovery and Edit with additional images remain under test. Successful 360p Edit is not claimed.

Standard Veo 3.1 Lite/Fast/Quality exact catalog variants now use the browser route through shared model validation. Preserve text/frame/ingredient roles and explicit IDs. The currently observed Pro editor offers 8s/720p; if requested 4s/6s Ultra selection cannot be verified, report `MODEL_DURATION_UNAVAILABLE` before paid submission, without an 8s substitute. Browser support metadata does not prove Google acceptance or completed Veo output.

Installed-app Veo 3.1 Lite R2V/Ingredients, 8s, one reference, portrait 720p has completed through normal generation, observation, download and save: 720×1280 H.264/AAC at 24 fps, 7.93 seconds. This verifies that exact case, not Fast/Quality, 4s/6s Ultra, every aspect, or every account tier.

Installed-app Omni 1.2 Flash text-only generation (no references), 3s landscape 360p, completed through download/save as 640×360 H.264/AAC at 24 fps, 3.029333 seconds. Enabled-account batch checking returned nine attributed results: seven passed and two required sign-in; it did not automatically enable, delete, or rotate accounts. Two installed-app Omni 1.2 Edit jobs through Flow Agent are verified without additional image references: 720p, 9:16, an approximately 10-second source. Each was submitted once; its completed result was recovered from the saved receipt, downloaded and saved without another generation. The measured MP4 is 720×1280 H.264/AAC, 10.026667 seconds; Agent quoted 36 credits for this source. Continuous automatic completion without a separate recovery and Edit with additional images remain under test. Successful 360p Edit is not claimed.

## Current Edit geometry, proposal and recovery

Omni 1.2 Edit uses Flow Agent in the same app-owned browser, preserving the exact account, model, prompt, source video and image order. Agent prepares one proposal for one video. Before one Approve action, the app verifies the proposal, persists its private receipt and crosses the same authorized-spend boundary; there is no automatic reapproval, account rotation or paid fallback.

The owned Agent proposal must quote the exact amount calculated for the selected mode using the source duration rounded up to whole seconds; Omni 1.2 seconds above ten count double. The direct-editor precheck follows its menu rounding, while Agent uses ceil duration: the observed 10.026667-second source quoted 36 credits in Agent versus 30 in the direct editor. This is not a doubled budget or permission to change models. Matching cost does not prove output resolution; exact dimensions and duration are checked before success.

Agent recovery saves a typed IMAGE preview of the source video and binds its resource to the original scene, exact prompt and ordered images in the selected History entry. The IMAGE preview is not a Google video ID; the app does not invent a /video/ identifier. Recovery reads the existing result without uploading inputs, creating another proposal or clicking Approve.

Two installed-app Omni 1.2 Edit jobs through Flow Agent are verified without additional image references: 720p, 9:16, an approximately 10-second source. Each was submitted once; its completed result was recovered from the saved receipt, downloaded and saved without another generation. The measured MP4 is 720×1280 H.264/AAC, 10.026667 seconds; Agent quoted 36 credits for this source. Continuous automatic completion without a separate recovery and Edit with additional images remain under test. Successful 360p Edit is not claimed.

Input geometry stays exact: portrait 360×640 or landscape 640×360 at 360p; portrait 720×1280 or landscape 1280×720 at standard 720p, source duration up to 15 seconds. Geometry mismatch fails before upload without resizing/model substitution. The direct-editor mode quote is checked before Agent; requested 360p remains unverified and the live 9-versus-3 mismatch stops before spending. Agent uses one new session with Always confirmation, one source video and ordered image refs, one exact proposal, and one Approve after a durable receipt. Never select Always approve in project or replay a used proposal. Preparation of the proposal is not the paid approval boundary.

Downloaded output must match source dimensions and duration within 0.15 seconds. An absent inspector or result above 100 MiB returns `OUTPUT_METADATA_UNAVAILABLE`; metadata mismatch returns `MODEL_SETTINGS_NOT_VERIFIED`. Unknown output/transport failures do not authorize another proposal or approval. Read the existing job and recover using its receipt.


Existing-result Nano Banana 2.1 portrait 2K Upscaled download is verified without a new image generation: 1536×2752 output versus standard 768×1376. This proves that specific download-upscale case, not all families, aspects, or 4K output.
