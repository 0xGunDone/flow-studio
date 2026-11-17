# Native Chrome diagnostics — current limits

**`flow_studio_prepare_browser` / `native_prepare` and `flow_studio_submit_browser` / `native_submit` always fail with `VISIBLE_WATERMARK_ROUTE_UNVERIFIED`.** No inputs are uploaded, no preparation token is issued, and no paid video is submitted; an old token does not bypass this block. This route cannot verify official Google `Visible watermarking: Off`.

- `flow_studio_inspect_browser` / `native_inspect`: `{accountId}`. Opens or focuses the selected account's ordinary Chrome and reads its Flow account/editor for diagnosis. No uploads, draft preparation or generation. Its existing macOS access/profile constraints still apply.
- `flow_studio_cancel_browser_preparation` / `native_cancel`: `{}`. Releases old preparation, token and owned temporary references. It does not cancel an already accepted Google job or remove prior uploads.

Use normal `prepare_generation` / `generate` for a supported app-owned browser route. New video generation still requires verified official `Visible watermarking: Off`; inspection or cancellation does not establish that proof. Unsupported models/routes fail without automatic model/account/engine substitution.

Old native helper preparation/submission tests describe historical code behavior, not an available client workflow. Never call the native helper directly to bypass the app's block. Preserve unknown outcomes from any earlier accepted job and inspect that same Flow task before considering a separately authorized new request.
