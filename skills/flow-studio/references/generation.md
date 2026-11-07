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

Call `flow_studio_prepare_generation` with a selector, prompt, and original local paths. It resolves one exact model and checks absolute paths, file formats, regular files, sizes, counts, and roles. It does not decode media or probe duration. It performs no upload, generation, job creation, or persistence, and takes no `requestId` or `confirmCreditSpend`.

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
