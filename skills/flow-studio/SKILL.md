---
name: flow-studio
description: Use the local Flow Studio app to generate images or videos, edit a source video with optional image references, work with start/end frames, inspect jobs and models, save results, or add Google accounts when the user chooses Flow Studio or invokes this skill. Generic image requests keep the built-in image_gen route.
---

# Flow Studio

Operate the installed Flow Studio app through its MCP tools. It owns the running backend, Google sessions, job history, and local media. The bridge can launch the app when needed; do not start a second backend or call Google endpoints directly.

## Route and discover

This skill is the selected generation route when the user explicitly chooses Flow Studio or invokes `$flow-studio`. Keep generic image requests on the user's default built-in `image_gen` route. Do not silently switch between routes after a failure.

Discover tools whose names end in the `flow_studio_*` names below. If the MCP server is not loaded in this session, use the same app bridge through the CLI in [references/cli.md](references/cli.md); a Codex restart is not required for that fallback.

Before choosing a model, call `flow_studio_status` and `flow_studio_list_models` with the required `kind` and, when useful, `mode`. Use the returned exact model ID and constraints, never a remembered model list. Useful filters: `kind: "image" | "video"`, `mode: "text" | "references" | "frames" | "extend" | "edit"`, and `query`. For image references, query `kind: "image"` and inspect `maxImages`: image models can accept references while reporting `mode: "text"`. The `references` mode identifies video generation from image references; `edit` identifies editing an uploaded source video.

The catalog reports configured capabilities; it does **not** prove that the active Google account can access a model or has enough credits. Preserve a user-chosen model. If it is absent or unavailable, explain the returned state and ask for their choice before substituting another model.

## Generate

1. Preserve the user's requested content, model, and frame roles. Resolve inputs to absolute local paths. If an attached image has no accessible local file, ask the user to attach it as a file or provide its local path. Do not invent paths or fetch arbitrary remote images.
2. Match the request to the live model's capabilities and input limits. Select exactly one input form from the table below.
3. Create a UUID `requestId` for this generation and retain it with the exact request arguments. Call `flow_studio_generate`. Set `confirmCreditSpend: true` when the user has requested this generation; do not ask again for the same authorized spend. Catalog browsing, account setup, and troubleshooting alone do not authorize generation.
4. Retain the returned `jobId`. Use `flow_studio_wait_job` with `timeoutSeconds` up to 30, or `flow_studio_get_job`, until the job finishes. Keep progress messages useful and respect any user stop request. A wait or transport timeout is not a failed generation.
5. For a completed job, save the requested media with `flow_studio_save_result`. Create the chosen output directory first; the save method requires an existing parent. Prefer the current task's user-facing `outputs/` directory unless the user chose another location. Use an absolute output path, correct media extension, and `overwrite: false` unless replacement was explicitly requested. Report the saved path as a clickable link and show local image/video media inline when supported.

| Request | Generation input |
| --- | --- |
| Text to image or video | No reference/frame/source fields |
| Image generation/edit or reference-guided video | `referencePaths: ["/absolute/image.png", ...]`, in the user's reference order |
| Image to video | `startFramePath`, with optional `endFramePath` only when supported |
| Edit a source video with Omni | `videoPaths: ["/absolute/source.mp4"]`, optionally with up to five `referencePaths` images |
| Extend an existing video | `sourceVideoId` from a verified existing source, only for an `extend` model |

For extension of a previous result, read `flow_studio_get_job` and reuse the chosen `media[index].mediaGenerationId` as `sourceVideoId`. The app's `jobId` identifies a local job, not the Google source video. If no source media ID is available, obtain the existing video ID from the user instead of guessing.

References (`referencePaths` and `videoPaths`), frame inputs, and `sourceVideoId` are mutually exclusive input forms. Only Omni Edit accepts `videoPaths`: one source video is required, with optional image references. Ordinary Omni accepts up to seven image references and no source video. Start/end frames are distinct roles: start is required for frame mode; end follows start and is required when the model reports `minImages: 2`, otherwise optional when supported. Do not turn ordinary references into boundary frames. When the roles cannot be inferred from the request, ask which image is start and which is end before spending credits.

Images must be local PNG, JPEG, WebP, or GIF files, at most 20 MB each. Omni Edit source videos must be local MP4, MOV, or M4V files, at most 100 MB and 10 seconds. The app validates video duration and media before upload; pass the local path, never read or encode the video as base64. Respect returned `minImages`, `maxImages`, `maxVideos`, `maxReferences`, `supportsVideoReferences`, `supportsStartFrame`, `supportsEndFrame`, and `requiredTier`. Image generation accepts up to five images, Veo R2V up to three, ordinary Omni up to seven, and Omni Edit one video plus up to five images. Veo 4s/6s requires Ultra; select an 8s model only if it matches the user's request or they approve the change. The model ID carries its advertised aspect ratio, duration, and resolution; `generate` does not accept extra settings. Select a matching catalog model or explain the unavailable combination.

Open the saved location with `flow_studio_open_result_folder` only when the user asks to show/open its folder. Saving does not itself authorize opening Finder.

## Resume, retry, or stop

Use `flow_studio_list_jobs` and `flow_studio_get_job` to resume existing work. Do not generate again merely because a result has not appeared yet.

If a generate call loses its response, inspect job history, then retry only with the **same UUID and identical arguments**. The bridge treats that request as idempotent while its job remains in history. The app retains the latest 100 jobs across restarts; do not retry an old request that is no longer retained without resolving its outcome first. A new UUID represents a new generation and potential new charge. Do not automatically change a model, prompt, route, or inputs to overcome an error.

On failure, state that no successful result was produced, quote the returned error/message and technical code, and distinguish an unknown outcome from a confirmed failed job. Do not infer moderation from an empty response. Offer a concrete next step without starting another paid request.

`PUBLIC_ERROR_MINOR` is an explicit Google rejection. Its exact public definition is not documented; a content-age check is possible, but the code alone does not identify the offending input or prove anyone's age. Do not confuse it with `PUBLIC_ERROR_USER_MINOR`, an authentication `401`, or a quota error. Read the same task's message in the Flow web UI if available. Do not retry identical rejected inputs, rotate accounts, change references, or rewrite the prompt automatically. Google states that editing uploaded videos of identifiable minors is unsupported; if adult content was misclassified, use the product's feedback/support flow.

`flow_studio_cancel_job` stops the app's own request; Google may still complete or charge for it. Explain that limit when cancellation matters. Do not automatically resubmit a cancelled job.

## Accounts

Use `flow_studio_list_accounts` or status for account summaries and reported credits. To add another account, call `flow_studio_begin_google_login` without `accountId`; pass a known `accountId` only to reconnect that account. The user completes Google's sign-in in the app's browser, then call `flow_studio_complete_google_login`. Use `flow_studio_cancel_google_login` when they abandon the sign-in.

Never request or read passwords, cookies, session tokens, or the bridge secret. The app handles credentials. Multiple accounts are supported; summaries do not establish model entitlement.

## Tool names

| MCP tool suffix | Purpose |
| --- | --- |
| `flow_studio_status` | App readiness, account summaries, model/job counts |
| `flow_studio_list_models` | Current filtered model catalog |
| `flow_studio_generate` | Start an authorized asynchronous generation |
| `flow_studio_get_job` / `flow_studio_wait_job` | Inspect or wait for a known job |
| `flow_studio_list_jobs` | Recent durable job history |
| `flow_studio_save_result` | Save one result by `jobId`, optional zero-based `index` |
| `flow_studio_open_result_folder` | Reveal saved result, or cached result if unsaved |
| `flow_studio_list_accounts` | Account summaries without credentials |
| `flow_studio_begin_google_login` / `flow_studio_complete_google_login` / `flow_studio_cancel_google_login` | User-driven sign-in |
| `flow_studio_cancel_job` | Cancel the app request for a known job |
