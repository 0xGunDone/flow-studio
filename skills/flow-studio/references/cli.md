# CLI fallback

Use when Flow Studio MCP tools are unavailable or the current session caches an older schema. Reconnect the MCP client for fresh tools; meanwhile this CLI uses the same installed app bridge and needs no full Codex restart. Node.js 22 or newer is required.

The bridge can launch Flow Studio. Closing its window with × or quitting with `⌘Q` stops the engine; minimizing keeps it open. CLI does not keep a standalone backend after exit. Stop polling when the user closes the app to stop work. Google may continue an accepted job; check Flow before retrying.

App bridge entrypoint:

```text
/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs
```

No-spend discovery and preparation. Current status reports `apiVersion: 2` and features `generation-settings`, `prepare-generation`, `explicit-methods`:

```sh
node '/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs' --list-tools
node '/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs' --call status '{}'
node '/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs' --call models '{"kind":"video","method":"frames","durationSeconds":8,"aspectRatio":"16:9"}'
node '/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs' --call prepare '{"model":"<EXACT_MODEL_ID_FROM_LIST_MODELS>","method":"frames","prompt":"<USER_PROMPT>","startFramePath":"/absolute/path/start.png"}'
```

`prepare` has no spend or job side effect: no upload, generation, or persistence. It needs neither UUID nor `confirmCreditSpend`. It checks absolute paths, formats, regular files, sizes, and roles, without decoding media or probing duration; account access and credits remain unchecked. Source duration is checked during submission. Read [generation.md](generation.md) for settings and input roles.

Pass one allowlisted method and a JSON object. Preserve structured stdout so errors and identifiers stay exact. Use proper shell quoting or a subprocess argument array; never interpolate user text into shell code. Never read or print `agent-bridge.json` to obtain credentials.

| MCP tool suffix | CLI method | Parameters |
| --- | --- | --- |
| `flow_studio_status` | `status` | `{}` |
| `flow_studio_list_models` | `models` | Optional `kind`, `method`, `family`, `durationSeconds`, `aspectRatio`, `resolution`, legacy `mode`, `query` |
| `flow_studio_prepare_generation` | `prepare` | `prompt`, exactly one of `model` or `settings`; optional outer `method` with `model` only; local inputs below |
| `flow_studio_generate` | `generate` | Preparation fields plus `confirmCreditSpend: true`, stable UUID `requestId` |
| `flow_studio_get_job` | `job` | `jobId` |
| `flow_studio_wait_job` | `wait` | `jobId`; optional `timeoutSeconds` from 0 to 30 |
| `flow_studio_list_jobs` | `history` | Optional `limit` from 1 to 100 |
| `flow_studio_save_result` | `save` | `jobId`, absolute `outputPath`; optional zero-based `index`, `overwrite` |
| `flow_studio_open_result_folder` | `open_folder` | `jobId`; optional zero-based `index` |
| `flow_studio_list_accounts` | `accounts` | `{}` |
| `flow_studio_begin_google_login` | `login_start` | Optional existing `accountId` |
| `flow_studio_complete_google_login` | `login_complete` | `{}` |
| `flow_studio_cancel_google_login` | `login_cancel` | `{}` |
| `flow_studio_cancel_job` | `cancel` | `jobId` |

Local input fields: `referencePaths` for image ingredients, `videoPaths` for one edit source, separate `startFramePath`/`endFramePath` for frames, or verified `sourceVideoId` for extend. Do not combine input methods. Image/video paths must be absolute; URLs, base64, and browser File objects are not accepted.

For authorized generation, preserve returned `generateArguments`, add a UUID using the language's UUID generator and `confirmCreditSpend: true`, then pass it through a subprocess argument array. Retain the exact object and UUID before execution; retries reuse both and unchanged files. Do not test `generate` as a diagnostic. `status`, `models`, `prepare`, `history`, and `accounts` cover no-spend integration checks.
