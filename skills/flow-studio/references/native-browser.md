> Legacy foreground diagnostics. Supported Nano Banana, Omni 1.2 Flash and standard Veo 3.1 models use the app-owned isolated browser automatically through normal generate. This document is not the default workflow.

# Native Chrome diagnostic route

The app uses ordinary Chrome UI for exact Omni 1.2 Flash text or image ingredients. This is separate from the general server Runtime. No stealth, CAPTCHA recovery, account rotation, or automatic fallback. Google sign-in and verification remain user actions.

- `flow_studio_inspect_browser` / CLI `native_inspect`: `{accountId}`. Focus or open selected account's Chrome, read its Flow account drawer and editor. No upload or generation.
- `flow_studio_prepare_browser` / `native_prepare`: `{accountId, model, prompt, referencePaths}`. All fields required; `referencePaths:[]` means text. Exact supported IDs are `omni-1.2-flash-<3..15>s-<landscape|portrait>` with optional `-360p`. Use live models and preserve selection. Up to seven absolute local image paths, same order. No videos or frame roles. Preparation fills exact prompt/settings and uploads references through ordinary UI, without clicking Generate. Returns `readyToSubmit`, token, project URL, model/settings and reference hashes.
- `flow_studio_submit_browser` / `native_submit`: `{token,confirmCreditSpend:true}`. Only for a generation already authorized by the user. Same token expires after ten minutes and is consumed once. The app writes an outcome-unknown submission record before a single Generate press. Does not return a normal history job or observe completion automatically.
- `flow_studio_cancel_browser_preparation` / `native_cancel`: `{}`. Releases prepared lease and private temporary references. Does not undo uploads already made to Flow or cancel a submitted Google job.

Native methods never retry automatically after timeout or transport failure. After uncertain submit, inspect the same Flow project before any further action; a new preparation is not a safe retry. A requestId is not used for this route. Save returned token privately until used; do not expose app bridge secrets.

Use the release source `app/mcp-server.cjs` for CLI, or the installed app’s exposed bridge entrypoint when available. Standard installation is `/Applications/Flow Studio.app`. CLI uses `mcp-server.cjs --call <method> '<JSON>'`; the same module may be loaded from the task's release source. Client reads its private bridge credentials internally, never print `agent-bridge.json`. For source tests/diagnostics, instantiate the provided `BridgeClient` and call these exact methods with structured objects. Do not call native helper JSONL directly as an alternate UI control mechanism.

The app needs its previously granted Accessibility and Screen Recording permissions. A changed local ad-hoc signature may invalidate them. Restore the same installed app through macOS Settings with no expansion of scope. Multiple distinct user Flow windows remain ambiguous; the app drains its own background sync before discovery.

Validate the final video in the same project, preserving prompt, account, model, aspect, duration and reference identity. Until completion is observed, report preparation/submission separately from a generated result.

Current validation limitation: the uploaded ingredient can keep the exact immutable Flow image URL while the native screen-pixel fingerprint changes after UI interactions. INGREDIENT_MISMATCH alone does not prove the user changed a reference. Preserve the error and stop before submission; do not remove fingerprint checks, repin an issued preparation, or count-only verify. Stable asset identity is not yet available to the native helper in this case, so full reference generation remains unverified.

A result created through a separate browser tool does not verify this legacy native app route. Report preparation, submission, and verified media separately; each new generation requires its own user-authorized request.
