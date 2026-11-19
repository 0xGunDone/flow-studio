# CLI fallback

Use when Flow Studio MCP tools are unavailable or the current session caches an older schema. Reconnect the MCP client for fresh tools; meanwhile this CLI uses the same installed app bridge and needs no full Codex restart. Node.js 22 or newer is required.

The bridge can launch Flow Studio. Closing its window with × or quitting with `⌘Q` stops the engine; minimizing keeps it open. CLI does not keep a standalone backend after exit. Stop polling when the user closes the app to stop work. Google may continue an accepted job; check Flow before retrying.

Use the absolute path to the installed MCP adapter. The examples use `~/Applications/Flow-Studio-MCP/mcp-server.cjs`. A source checkout with installed dependencies can use its own `app/mcp-server.cjs`.

Current status reports `apiVersion: 3` and `video-watermark-selection` in `features`. These commands spend no credits.

```sh
flow_studio_mcp="$HOME/Applications/Flow-Studio-MCP/mcp-server.cjs"
node "$flow_studio_mcp" --list-tools
node "$flow_studio_mcp" --call status '{}'
node "$flow_studio_mcp" --call models '{"kind":"video","method":"frames","durationSeconds":8,"aspectRatio":"16:9"}'
node "$flow_studio_mcp" --call prepare '{"model":"<EXACT_MODEL_ID_FROM_LIST_MODELS>","method":"frames","prompt":"<USER_PROMPT>","startFramePath":"/absolute/path/start.png"}'
```

Default `prepare` has no spend or job side effect: no upload, generation, or persistence. It needs neither UUID nor `confirmCreditSpend`. It checks absolute paths, formats, regular files, sizes, and roles, without decoding media or probing duration; account access and credits remain unchecked. Source duration is checked during submission. Read [generation.md](generation.md) for settings and input roles.


For an explicitly requested browser/upload check, use the same `prepare` method with `checkBrowser:true` and an exact `accountId`. Use only an exact catalog model reporting `generationEngine:"isolated-browser"`: supported Nano Banana, Omni 1.2 or Veo. This uploads the requested image references, explicit frame roles or Edit source video to Google, then clears the owned composer before releasing the browser; no Generate click, job, or credit spend. Read `checks.browser`, `checks.upload`, and `browserCheck`; `generateArguments` excludes the diagnostic flag. Never automatically retry a browser check after timeout or transport failure.

```sh
node "$flow_studio_mcp" --call prepare '{"model":"<EXACT_OMNI_1.2_MODEL_ID_FROM_LIST_MODELS>","method":"ingredients","prompt":"<USER_PROMPT>","referencePaths":["/absolute/path/reference.png"],"accountId":7,"checkBrowser":true}'
```

Replace `7` with a known account ID. Omit `checkBrowser` for purely local preparation. Video uses `videoWatermark: "with"` by default. For an explicit no-mark request, add `"videoWatermark":"without"` alongside `model` or `settings`. For automatic account selection, omit `accountId`; for a pinned generation, use an eligible account with `browserReady:true` and `visibleWatermarkCapability:"optional"`. Use `--call check_account '{"accountId":7}'` to read capability without uploads. Browser preparation requires an explicit `accountId`, can change the official account preference, and reports `checks.visibleWatermark` of `"on"` or `"off"`.

Pass one allowlisted method and a JSON object. Preserve structured stdout so errors and identifiers stay exact. Use proper shell quoting or a subprocess argument array; never interpolate user text into shell code. Never read or print `agent-bridge.json` to obtain credentials.

| MCP tool suffix | CLI method | Parameters |
| --- | --- | --- |
| `flow_studio_status` | `status` | `{}` |
| `flow_studio_inspect_isolated_browser` | `isolated_inspect` | `{accountId}` to verify the managed session/project and refresh cached watermark capability |
| `flow_studio_recover_job` | `recover` | `{jobId}`; same receipt/account/result, no upload or new submission |
| `flow_studio_list_models` | `models` | Optional `kind`, `method`, `family`, `durationSeconds`, `aspectRatio`, `resolution`, legacy `mode`, `query` |
| `flow_studio_prepare_generation` | `prepare` | `prompt`, exactly one of `model` or `settings`, optional `accountId` and video-only top-level `videoWatermark`. Outer `method` applies only to `model` |
| `flow_studio_generate` | `generate` | Preparation fields plus `confirmCreditSpend: true`, stable UUID `requestId` |
| `flow_studio_get_job` | `job` | `jobId` |
| `flow_studio_wait_job` | `wait` | `jobId`; optional `timeoutSeconds` from 0 to 30 |
| `flow_studio_list_jobs` | `history` | Optional `limit` from 1 to 100 |
| `flow_studio_save_result` | `save` | `jobId`, absolute `outputPath`; optional zero-based `index`, `overwrite` |
| `flow_studio_open_result_folder` | `open_folder` | `jobId`; optional zero-based `index` |
| `flow_studio_list_accounts` | `accounts` | `{}` |
| `flow_studio_set_account_active` | `set_account_active` | `{accountId,enabled}` exact boolean; explicit change only |
| `flow_studio_check_account` | `check_account` | `{accountId}` for saved session, identity and watermark capability |
| `flow_studio_check_enabled_accounts` | `check_enabled_accounts` | `{}` for serial enabled-account checks, including watermark capability |
| `flow_studio_reset_account_cooldown` | `reset_cooldown` | `{accountId}`; requested local timer reset only, never automatic |
| `flow_studio_begin_google_login` | `login_start` | Optional existing `accountId` |
| `flow_studio_complete_google_login` | `login_complete` | `{}` |
| `flow_studio_cancel_google_login` | `login_cancel` | `{}` |
| `flow_studio_cancel_job` | `cancel` | `jobId` |

Local input fields: `referencePaths` for image ingredients, `videoPaths` for one edit source, separate `startFramePath`/`endFramePath` for frames, or verified `sourceVideoId` for extend. Do not combine input methods. Image/video paths must be absolute; URLs, base64, and browser File objects are not accepted.

For authorized generation, preserve returned `generateArguments`, add a UUID using the language's UUID generator and `confirmCreditSpend: true`, then pass it through a subprocess argument array. Retain the exact object and UUID before execution; retries reuse both and unchanged files. Do not test `generate` as a diagnostic. `status`, `models`, `prepare`, `history`, and `accounts` cover no-spend integration checks.

When a source checkout is cloud-backed and dependency reads stall, use the release MCP adapter in a local folder outside sync, for example `~/Applications/Flow-Studio-MCP`. Install its lockfile dependencies with `npm ci --ignore-scripts`, then point the client at that adapter’s absolute `mcp-server.cjs` path. It talks to the same installed app; do not launch another backend. Reconnect the MCP client to reload the 24-tool schema. A 600-second outer tool timeout matches serial enabled-account checks; a timeout never authorizes another generation.

The bridge allows 600 seconds for `prepare` with `checkBrowser:true`, including human rights consent; ordinary local `prepare` keeps 120 seconds. A response timeout does not authorize another upload or generation.
