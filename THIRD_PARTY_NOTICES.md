# Third-party notices

Flow Studio includes third-party software. Each component remains subject to its own license; the root MIT license does not replace those terms.

## Flow2API

- Project: [TheSmallHanCat/flow2api](https://github.com/TheSmallHanCat/flow2api)
- Vendored base: `f6f201c298ee6ee4b28a7d36adf3a8d49cfb2844`
- Location: [`backend/`](backend)
- License: [MIT](backend/LICENSE)
- Original notice: **Copyright (c) 2025 TheSmallHanCat**

The vendored backend includes local modifications for Flow Studio. Preserve `backend/LICENSE` and its original notice when redistributing this code.

## Flow Studio Session Sync

The optional [`extension/`](extension) is an original Flow Studio implementation under the root [MIT license](LICENSE). Its source and artwork do not include the upstream Flow2API Token Updater extension.

## Desktop and MCP dependencies

| Component | Purpose | License source |
| --- | --- | --- |
| Electron | Desktop application runtime | Electron's license and bundled third-party notices in its distribution |
| Chromium and Node.js | Components of the Electron runtime | Licenses and notices included with Electron |
| `@modelcontextprotocol/sdk` | MCP server and stdio transport | License distributed with the installed package |
| `zod` | MCP argument validation | License distributed with the installed package |
| Backend Python dependencies | Local generation service | Individual distributions listed in `backend/requirements.txt` |

Exact JavaScript dependency versions are recorded in [`app/package-lock.json`](app/package-lock.json). Packaging must retain the notices supplied with Electron and installed dependencies. This document is an attribution summary, not a replacement for the dependency license files.

## Names and services

Google, Google Flow, Chrome, Docker and other product names belong to their respective owners. Flow Studio is an independent project and does not imply their endorsement. The software license does not grant rights to third-party services, accounts, trademarks, or generated content beyond the rights granted by their applicable terms.
