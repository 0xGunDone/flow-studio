"""Unit coverage for the open-source headed browser captcha path."""

import asyncio
import json
import os
import types
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

# Avoid Chromium download/install side effects while importing this module for
# pure unit tests.
_previous_docker_container = os.environ.get("DOCKER_CONTAINER")
_previous_allow_headed = os.environ.get("ALLOW_DOCKER_HEADED_CAPTCHA")
os.environ["DOCKER_CONTAINER"] = "1"
os.environ.pop("ALLOW_DOCKER_HEADED_CAPTCHA", None)
try:
    from src.services.browser_captcha import (
        BrowserCaptchaService,
        TokenBrowser,
        _resolve_flow_page_warmup_seconds,
    )
finally:
    if _previous_docker_container is None:
        os.environ.pop("DOCKER_CONTAINER", None)
    else:
        os.environ["DOCKER_CONTAINER"] = _previous_docker_container
    if _previous_allow_headed is not None:
        os.environ["ALLOW_DOCKER_HEADED_CAPTCHA"] = _previous_allow_headed


class BrowserCaptchaTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _streamchat_body(token: str, session_id: str) -> str:
        inner = [session_id, "payload", ["recaptcha", token]]
        outer = [None, json.dumps(inner), None]
        return urlencode({"f.req": json.dumps(outer), "at": "xsrf-token"})

    def test_parse_harvest_streamchat_post_extracts_token_and_session(self):
        token = "0cAFcW" + ("x" * 120)
        body = self._streamchat_body(token, "FLOW-SESSION-1")

        result = TokenBrowser._parse_harvest_streamchat_post(body)

        self.assertEqual(result, {"token": token, "session_id": "FLOW-SESSION-1"})

    def test_flow_page_warmup_zero_is_preserved(self):
        self.assertEqual(_resolve_flow_page_warmup_seconds(0), 0.0)
        self.assertEqual(_resolve_flow_page_warmup_seconds(None), 6.0)
        self.assertEqual(_resolve_flow_page_warmup_seconds(31), 30.0)
        self.assertEqual(_resolve_flow_page_warmup_seconds("invalid"), 6.0)

    def test_parse_harvest_streamchat_post_rejects_invalid_request(self):
        self.assertIsNone(TokenBrowser._parse_harvest_streamchat_post(None))
        self.assertIsNone(TokenBrowser._parse_harvest_streamchat_post("at=only"))
        self.assertIsNone(TokenBrowser._parse_harvest_streamchat_post("f.req=not-json"))

    async def test_get_token_uses_configured_retry_budget(self):
        browser = object.__new__(TokenBrowser)
        browser.token_id = 1
        browser._semaphore = asyncio.Semaphore(1)
        browser._solve_inflight = 0
        browser._solve_count = 0
        browser._error_count = 0
        browser._consecutive_browser_failures = 0
        browser._get_or_create_shared_browser = AsyncMock(
            return_value=(None, None, object())
        )
        browser._execute_captcha = AsyncMock(return_value=None)
        browser.recycle_browser = AsyncMock()
        browser.note_idle = lambda: None

        with patch("src.services.browser_captcha.config") as config_mock:
            config_mock.browser_captcha_max_retries = 2
            token, session_id = await browser.get_token(
                "project-1", "website-key", "CHAT_GENERATION"
            )

        self.assertIsNone(token)
        self.assertIsNone(session_id)
        self.assertEqual(browser._execute_captcha.await_count, 2)
        browser.recycle_browser.assert_awaited_once()

    def test_select_browser_id_prefers_slot_bound_to_token(self):
        service = BrowserCaptchaService(db=None)
        service._browser_count = 3
        service._browsers = {
            slot_id: types.SimpleNamespace(
                is_busy=lambda: False,
                has_shared_browser=lambda: True,
                _shared_bound_token_id=slot_id + 1,
            )
            for slot_id in range(3)
        }

        selected = asyncio.run(service._select_browser_id("project-1", token_id=2))

        self.assertEqual(selected, 1)

    async def test_select_browser_id_prefers_cold_slot_over_wrong_account(self):
        service = BrowserCaptchaService(db=None)
        service._browser_count = 2
        service._browsers = {
            0: types.SimpleNamespace(
                is_busy=lambda: False,
                has_shared_browser=lambda: True,
                _shared_bound_token_id=1,
            )
        }

        selected = await service._select_browser_id("project-1", token_id=2)

        self.assertEqual(selected, 1)

    def test_google_cookie_targets_use_valid_playwright_scope(self):
        cookies = TokenBrowser._build_google_cookie_targets("OSID=dummy")
        self.assertTrue(cookies)
        for cookie in cookies:
            self.assertFalse("url" in cookie and "path" in cookie)
            self.assertTrue(cookie["url"].endswith("/"))

    def test_host_cookie_keeps_its_original_origin(self):
        cookies = TokenBrowser._build_google_cookie_targets(json.dumps([
            {"name": "__Host-auth", "value": "dummy", "domain": "accounts.google.com", "path": "/"}
        ]))
        self.assertEqual(cookies[0]["url"], "https://accounts.google.com/")
        self.assertNotIn("path", cookies[0])
        self.assertTrue(cookies[0]["secure"])
        self.assertNotIn("domain", cookies[0])

    def test_host_only_cookie_keeps_nonroot_path(self):
        cookies = TokenBrowser._build_google_cookie_targets(json.dumps([
            {"name": "session", "value": "dummy", "domain": ".flow.google.com", "hostOnly": True, "path": "/private"}
        ]))
        self.assertEqual(cookies[0]["url"], "https://flow.google.com/")
        self.assertNotIn("domain", cookies[0])
        self.assertEqual(cookies[0]["path"], "/private")

    def test_explicit_domain_cookie_keeps_subdomain_scope(self):
        cookies = TokenBrowser._build_google_cookie_targets(json.dumps([
            {"name": "session", "value": "dummy", "domain": "google.com", "hostOnly": False, "path": "/"}
        ]))
        self.assertEqual(cookies[0]["domain"], "google.com")
        self.assertEqual(cookies[0]["path"], "/")
        self.assertNotIn("url", cookies[0])

    async def test_nonroot_cookie_import_closes_cdp_resources(self):
        for fail in (False, True):
            with self.subTest(fail=fail):
                browser = object.__new__(TokenBrowser)
                browser.token_id = 0
                browser._shared_bound_token_id = None
                browser._shared_bound_cookie_signature = None
                raw = json.dumps([{"name": "session", "value": "dummy", "domain": "flow.google.com", "path": "/private"}])
                browser._load_token_session_binding = AsyncMock(return_value=(7, None, raw, "signature"))
                page = types.SimpleNamespace(close=AsyncMock())
                session = types.SimpleNamespace(send=AsyncMock(side_effect=RuntimeError("failed") if fail else None), detach=AsyncMock())
                context = types.SimpleNamespace(
                    clear_cookies=AsyncMock(), add_cookies=AsyncMock(),
                    new_page=AsyncMock(return_value=page), new_cdp_session=AsyncMock(return_value=session),
                )
                success = await browser._ensure_shared_token_binding(context, 7)
                self.assertEqual(success, not fail)
                context.add_cookies.assert_not_awaited()
                self.assertEqual(session.send.call_args.args[0], "Network.setCookies")
                session.detach.assert_awaited_once()
                page.close.assert_awaited_once()

    async def test_warmup_binds_browser_to_active_token_credentials(self):
        service = BrowserCaptchaService(db=None)
        fake_browser = types.SimpleNamespace(
            _get_or_create_shared_browser=AsyncMock(return_value=(None, None, object()))
        )
        service._get_warmup_token_specs = AsyncMock(return_value=[(7, "http://proxy")])
        service._get_or_create_browser = AsyncMock(return_value=fake_browser)

        await service.warmup_browser_slots()

        fake_browser._get_or_create_shared_browser.assert_awaited_once_with(
            token_proxy_url="http://proxy", token_id=7
        )

    async def test_warmup_without_accounts_preserves_runtime_probe(self):
        service = BrowserCaptchaService(db=None)
        service._get_warmup_token_specs = AsyncMock(return_value=[])
        service._warmup_browser_slot = AsyncMock()

        await service.warmup_browser_slots()

        service._warmup_browser_slot.assert_awaited_once_with(
            0, token_id=None, token_proxy_url=None
        )

    async def test_warmup_skips_already_bound_slot(self):
        service = BrowserCaptchaService(db=None)
        service._browser_count = 2
        existing_browser = types.SimpleNamespace(
            _get_or_create_shared_browser=AsyncMock(),
            has_shared_browser=lambda: True,
            _shared_bound_token_id=1,
        )
        new_browser = types.SimpleNamespace(
            _get_or_create_shared_browser=AsyncMock(return_value=(None, None, object()))
        )
        service._browsers = {0: existing_browser}
        service._get_warmup_token_specs = AsyncMock(
            return_value=[(1, None), (2, "http://proxy")]
        )
        service._get_or_create_browser = AsyncMock(
            side_effect=lambda browser_id: existing_browser
            if browser_id == 0
            else new_browser
        )

        await service.warmup_browser_slots()

        existing_browser._get_or_create_shared_browser.assert_not_awaited()
        new_browser._get_or_create_shared_browser.assert_awaited_once_with(
            token_proxy_url="http://proxy", token_id=2
        )

    def test_warmup_token_specs_skip_banned_or_empty_credentials(self):
        service = BrowserCaptchaService(db=None)
        service._browser_count = 3
        tokens = [
            types.SimpleNamespace(
                id=1, google_cookies="", st="session", ban_reason="429_rate_limit"
            ),
            types.SimpleNamespace(
                id=2, google_cookies="", st="", captcha_proxy_url="", ban_reason=None
            ),
            types.SimpleNamespace(
                id=3,
                google_cookies="SID=1",
                st="",
                captcha_proxy_url="http://proxy",
                ban_reason=None,
            ),
        ]

        async def get_active_tokens():
            return tokens

        service.db = types.SimpleNamespace(get_active_tokens=get_active_tokens)

        self.assertEqual(
            asyncio.run(service._get_warmup_token_specs()), [(3, "http://proxy")]
        )


if __name__ == "__main__":
    unittest.main()
