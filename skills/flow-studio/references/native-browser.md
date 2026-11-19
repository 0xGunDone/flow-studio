# Native Chrome diagnostics — current limits

**`flow_studio_prepare_browser` / `native_prepare` and `flow_studio_submit_browser` / `native_submit` fail with `VISIBLE_WATERMARK_ROUTE_UNVERIFIED`, including with old tokens.** The route cannot verify the requested official Google `Visible watermarking` setting. It stops before uploads, preparation-token issuance or credit spend.

- `flow_studio_inspect_browser` / `native_inspect`: `{accountId}`. Opens or focuses the selected account's ordinary Chrome and reads its Flow account/editor for diagnosis. No uploads, draft preparation or generation. Its existing macOS access/profile constraints still apply.
- `flow_studio_cancel_browser_preparation` / `native_cancel`: `{}`. Releases old preparation, token and owned temporary references. It does not cancel an already accepted Google job or remove prior uploads.

Use normal `prepare_generation` / `generate` for supported app-owned browser routes. Video requires verified official `Visible watermarking: On` with default `videoWatermark: "with"` or `Off` with explicit `"without"`. Unsupported routes fail without switching the model, account or engine.

Old native helper preparation/submission tests describe historical code behavior, not an available client workflow. Never call the native helper directly to bypass the app's block. Preserve unknown outcomes from any earlier accepted job and inspect that same Flow task before considering a separately authorized new request.
