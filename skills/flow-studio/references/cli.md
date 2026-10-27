# CLI fallback

Use this only when Flow Studio MCP tools are unavailable. It connects to the same local app and can launch it automatically; it is not a separate generator. Node must be version 22 or newer.

Closing the app window with × or quitting with `⌘Q` stops its engine; minimizing keeps the app open. The CLI does not keep a standalone backend running, but a later call can reopen the app. Stop polling if the user closes Flow Studio to stop work. Google may continue an accepted generation after exit; check Flow before retrying.

Persistent app-engine entrypoint:

```text
/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs
```

Read-only discovery examples:

```sh
node '/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs' --call status '{}'
node '/ABSOLUTE/PATH/flow-studio/app/mcp-server.cjs' --call models '{"kind":"video","mode":"frames"}'
```

Pass exactly one allowlisted method and a JSON object. Preserve stdout as structured output so errors and identifiers remain exact. Use proper shell quoting or a subprocess argument array; do not interpolate user text into shell code. Never print or read `agent-bridge.json` to obtain credentials.

| MCP tool suffix | CLI method | Parameters |
| --- | --- | --- |
| `flow_studio_status` | `status` | `{}` |
| `flow_studio_list_models` | `models` | Optional `kind`, `mode`, `query` |
| `flow_studio_generate` | `generate` | `model`, `prompt`, `confirmCreditSpend`, UUID `requestId`; optional `referencePaths`, `videoPaths` (Omni Edit only), `startFramePath`, `endFramePath`, `sourceVideoId` |
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

When constructing paid requests programmatically, use the language's UUID generator and subprocess argument array. Retain the request object and UUID before execution; a retry must reuse both exactly. Read-only `status`, `models`, `history`, and `accounts` are sufficient for a no-spend integration check. Do not test `generate` without a user-requested prompt and authorization to generate it.
