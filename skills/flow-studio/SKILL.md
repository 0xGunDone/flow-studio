---
name: flow-studio
description: Use the local Flow Studio app to prepare or generate images and videos, edit a source video, use start/end frames, inspect jobs and models, save results, or add Google accounts when the user chooses Flow Studio or invokes this skill. Generic image requests keep the built-in image_gen route.
---

# Flow Studio

Operate the installed Flow Studio app through its MCP tools. It owns the running backend, Google sessions, job history, and local media. The bridge can launch the app; do not start a second backend or call Google endpoints directly.

The engine runs while Flow Studio is open. Closing its window with × or quitting with `⌘Q` exits the app and stops the engine; minimizing keeps it open. MCP does not keep a standalone backend after exit, but a later call can reopen the app. If the user closes Flow Studio to stop work, stop polling.

## Route and discover

Use this route when the user chooses Flow Studio or invokes `$flow-studio`. Keep generic image requests on the built-in `image_gen` route. Do not silently switch routes after failure.

Discover tools ending in the `flow_studio_*` names below. A session may cache an older schema: reconnect its MCP client to load new tools, or use the same app bridge through [references/cli.md](references/cli.md). A full Codex restart is not needed for that fallback.

Read `flow_studio_status`: the current bridge reports `apiVersion: 2` and features `generation-settings`, `prepare-generation`, `explicit-methods`. If the session exposes an older schema, use the CLI fallback or reconnect MCP before using new fields. Then call `flow_studio_list_models` with the requested filters. Use current exact model IDs and metadata, never remembered IDs. Filters include `kind`, `method`, `family`, `durationSeconds`, `aspectRatio`, `resolution`, plus legacy `mode` and `query`. Methods are `image`, `text`, `ingredients`, `frames`, `edit`, and `extend`.

Inspect `family`, `methods`, `durationSource`, `resolution`, `inputsByMethod`, `fileLimits`, and input limits. `resolution: "standard"` is a real default. Edit reports `durationSource: "input_video"`. Legacy `mode` remains unchanged: image models report `mode: "text"` while using method `image`; video `mode: "references"` maps to ingredients. Ordinary Omni supports both `text` and `ingredients`.

Catalog presence and preflight do not prove active account access or enough credits. Preserve the user's model and settings. An absent, ambiguous, or unavailable combination fails without fallback; explain the returned state and obtain the user's choice before changing it. Settings resolution collapses only the known same-version aliases listed in the generation reference; an exact `model` request preserves its chosen catalog ID.

## Preferred video model

For a new video when the user has not chosen a model, prefer **Omni 1.2 Flash**. Select an exact compatible ID from live `list_models`, respecting method, aspect ratio, duration, resolution and input roles; catalog `preferred` metadata reflects this policy. Never invent IDs by replacing 1.1 with 1.2 or treat an official Gemini API ID as an internal Flow ID.

Omni 1.1 is not preferred. Preserve an explicit user selection, including Omni 1.1 and legacy aliases. Never migrate history, drafts, saved selections, prepared `generateArguments` or an identical request replay to the new preference. Image generation keeps its separate model choice.

If compatible Omni 1.2 is absent or unavailable, report the reason and returned code/message. Do not silently fall back to Omni 1.1, Veo or another model. A configured preference does not prove backend support and does not authorize a paid test.

## Prepare, generate, save

1. Preserve the user's prompt, model/settings, input order, and frame roles. Resolve inputs to absolute local file paths. If an attachment lacks an accessible local path, ask for the file or its path; do not invent paths or fetch arbitrary remote images.
2. Call `flow_studio_prepare_generation` with the prompt, inputs, and exactly one of `model` or `settings`. With an exact `model`, optional outer `method` makes the input method explicit. With `settings`, put the method inside that object and omit outer `method`. See [references/generation.md](references/generation.md) for settings and examples.
3. Read the resolved model, method, settings, input counts, and `checks`. Preparation validates absolute paths, formats, regular files, sizes, limits, and roles without decoding media, probing duration, upload, generation, job creation, persistence, or credit spend. It needs no `requestId` or `confirmCreditSpend`. A valid result reports `localFiles: "passed"`, `accountAccess`/`credits: "not_checked"`, and `videoDuration: "checked_at_submission"` for a source video or `"not_applicable"` otherwise. It does not guarantee Google acceptance or compliance with the source video's model-specific duration limit.
4. Preserve returned `generateArguments` verbatim: it pins the exact model ID, explicit method, prompt, and original paths. For this user-authorized generation, add a fresh UUID `requestId` and `confirmCreditSpend: true`, retain the full request, then call `flow_studio_generate`. Do not ask again for the same authorized spend. Setup, browsing, preflight, and diagnostics alone do not authorize generation.
5. Retain `jobId`. Use `flow_studio_wait_job` with `timeoutSeconds` up to 30, or `flow_studio_get_job`, until complete. A wait or transport timeout does not prove failure. Stop when the user requests it or closes the app to stop work.
6. Save successful media with `flow_studio_save_result`. Create the parent directory first. Prefer the task's user-facing `outputs/` unless the user chose another location; use an absolute path, correct extension, and `overwrite: false` unless replacement was authorized. Link the saved file and show local image/video media inline when supported. Open Finder with `flow_studio_open_result_folder` only when requested.

`generate` also accepts exactly one of `model` or `settings`, under the same rules. Prefer prepared `generateArguments` so model resolution stays fixed between checking and spending.

| Method | Inputs |
| --- | --- |
| `image` | Optional `referencePaths` in user order |
| `text` | No reference, frame, video, or source fields |
| `ingredients` | At least one image in `referencePaths`; ordinary Omni allows up to seven |
| `frames` | `startFramePath` required; optional `endFramePath` only when supported |
| `edit` | One `videoPaths` source plus optional image `referencePaths` |
| `extend` | Verified `sourceVideoId` only |

Frame paths carry separate roles. Never pass `referencePaths` as frames, infer roles from upload order, or send an end frame alone. If roles are unclear, ask before spending. End is required when the model reports `minImages: 2`. Cross-method inputs are rejected. Exact ordinary Omni without outer `method` infers `ingredients` when references exist and `text` otherwise; explicit `ingredients` always requires a reference.

Images: PNG, JPEG, WebP, GIF, at most 20 MB each. Image generation accepts up to five images, Veo ingredients up to three, ordinary Omni up to seven. Omni Edit accepts one MP4/MOV/M4V up to 100 MiB, plus up to five images. Read `fileLimits.video.maxDurationSeconds`: Omni 1.2 Edit allows 15 seconds; Omni 1.1 Edit keeps 10. Duration is checked during actual submission. Pass paths, never base64. MCP path fields use the same native format/size checks as app file selection and drag-and-drop; MCP has no drag-and-drop/File API.

Respect `inputsByMethod`, `fileLimits`, `minImages`, `maxImages`, `maxVideos`, `maxReferences`, `supportsVideoReferences`, `supportsStartFrame`, `supportsEndFrame`, and `requiredTier`. Omni 1.2 frames allow an optional end frame at 3–10 seconds; 11–15 seconds accept only a start frame and require Pro or Ultra. Veo 4s/6s requires Ultra; change to 8s only when it matches the request or the user chooses it.

For extension, read the existing job and use chosen `media[index].mediaGenerationId` as `sourceVideoId`. Local `jobId` is not Google's source video ID. If no verified media ID exists, obtain it from the user.

## Resume, retry, stop

Use `flow_studio_list_jobs` and `flow_studio_get_job` to resume work. Do not generate again because a result has not appeared.

If a generate response is lost, inspect history, then retry only with the **same UUID, identical arguments, and unchanged files**. The bridge deduplicates while the job remains among the latest 100 retained jobs, across restarts. Resolve an older request's outcome before retrying it. A new UUID means a new generation and potential new charge. Never change model, settings, prompt, route, or inputs automatically after failure.

On failure, preserve returned error/message and technical code. Distinguish confirmed failed jobs from unknown transport outcomes; do not infer moderation from an empty response. Offer a next step without starting another paid request. Never use paid generation as a diagnostic.

`FLOW_UPLOAD_BROWSER_TIMEOUT`, `FLOW_UPLOAD_BROWSER_UNAVAILABLE`, `FLOW_UPLOAD_BROWSER_ERROR`, and `FLOW_UPLOAD_VERIFICATION_EMPTY` distinguish local upload preparation failures; retain the exact code. They identify a failure stage, not proof that Google rejected the account or that a fix worked. The legacy `Failed to obtain reCAPTCHA token for image upload` is a local pre-upload failure: the failed image was not uploaded and this attempt did not reach generation submission; earlier input uploads may have completed. It does not prove quota exhaustion, model rejection, or expired login. Do not retry generation as a diagnostic or change account/model/inputs. Ask whether the same file attaches in the ordinary Flow browser UI without generating; any Google verification is completed by the user. The app's “Open Flow in browser” button is a manual handoff, not an automated CAPTCHA recovery or proof that app upload works.

`PUBLIC_ERROR_MINOR` is an explicit Google rejection with no documented exact public definition. It alone does not identify the input or prove anyone's age. Do not confuse it with `PUBLIC_ERROR_USER_MINOR`, `401`, or quota errors. Read the same task's Flow web UI message if available. Do not retry identical rejected inputs, rotate accounts, change references, or rewrite the prompt automatically. Google does not support editing uploaded videos of identifiable minors; misclassified adult content belongs in its feedback/support flow.

`flow_studio_cancel_job` stops the app request; Google may still complete or charge it. Quitting also stops local waiting. Check Flow for an accepted job's outcome before retrying; do not automatically resubmit failed or cancelled jobs.

## Accounts

Use status or `flow_studio_list_accounts` for account summaries and reported credits. For a new account, call `flow_studio_begin_google_login` without `accountId`; pass a known `accountId` only to reconnect it. The user signs in through Google's browser UI, then call `flow_studio_complete_google_login`; cancel abandoned sign-in with `flow_studio_cancel_google_login`.

Never request or read passwords, cookies, session tokens, or bridge secrets. The app handles credentials. Account summaries do not establish model entitlement.

## Tools

| MCP tool suffix | Purpose |
| --- | --- |
| `flow_studio_status` | App readiness, features, account/model/job summaries |
| `flow_studio_list_models` | Current filtered catalog and constraints |
| `flow_studio_prepare_generation` | Resolve and validate locally without spending |
| `flow_studio_generate` | Start one authorized asynchronous generation |
| `flow_studio_get_job` / `flow_studio_wait_job` | Inspect or wait for a known job |
| `flow_studio_list_jobs` | Recent durable history |
| `flow_studio_save_result` | Save one result by `jobId`, optional zero-based `index` |
| `flow_studio_open_result_folder` | Reveal saved or cached result |
| `flow_studio_list_accounts` | Account summaries without credentials |
| `flow_studio_begin_google_login` / `flow_studio_complete_google_login` / `flow_studio_cancel_google_login` | User-driven sign-in |
| `flow_studio_cancel_job` | Cancel the local request |
