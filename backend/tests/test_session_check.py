import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI

from src.api import admin
from src.core.models import Token
from src.services.flow_client import FlowClient
from src.services.flow_frontend import FlowFrontendAuthError
from src.services.token_manager import TokenManager


EMAIL = "account@example.com"
COOKIES = "OSID=old-private-cookie; SID=private-google-cookie"
ROTATED = "OSID=new-private-cookie; SID=private-google-cookie"


class SessionCheckTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.account = Token(
            id=7, email=EMAIL, login_account=EMAIL, google_cookies=COOKIES,
            st="old-st", at="old-at", credits=999, is_active=False,
            proxy_url="http://account-proxy:8080",
        )
        self.db = SimpleNamespace(
            get_token=AsyncMock(side_effect=lambda token_id: self.account),
            update_token=AsyncMock(), update_token_if_cookie_matches=AsyncMock(return_value=True),
        )
        self.flow = MagicMock()
        self.flow.FRONTEND_ACCESS_TOKEN = FlowClient.FRONTEND_ACCESS_TOKEN
        self.flow.get_request_fingerprint.return_value = None
        self.flow.proxy_manager.get_request_proxy_url = AsyncMock(return_value="http://default-proxy:8080")
        self.flow.validate_session = AsyncMock(return_value={"email": EMAIL, "credits": 42, "google_cookies": ROTATED, "access_token": FlowClient.FRONTEND_ACCESS_TOKEN, "expires": "2026-12-01T00:00:00Z"})
        self.flow.generate_image = AsyncMock()
        self.flow.generate_video = AsyncMock()
        self.flow.create_project = AsyncMock()
        self.manager = TokenManager(self.db, self.flow)
        self.manager.refresh_credits = AsyncMock()
        self.manager.refresh_cookies = AsyncMock()
        self.manager.enable_token = AsyncMock()
        self.manager._save_refreshed_cookies = AsyncMock()
        self.patches = [
            patch.object(admin, "token_manager", self.manager),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(admin.router)
        admin.active_admin_tokens.add("session-check-test-admin")
        self.addCleanup(admin.active_admin_tokens.discard, "session-check-test-admin")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def call(self, authorized=True):
        headers = {"Authorization": "Bearer session-check-test-admin"} if authorized else {}
        return await self.client.post("/api/tokens/7/check-session", headers=headers)

    def assert_no_generation_or_enable(self):
        for operation in (
            self.db.update_token,
            self.manager.refresh_credits, self.manager.refresh_cookies,
            self.manager.enable_token, self.manager._save_refreshed_cookies,
            self.flow.generate_image, self.flow.generate_video, self.flow.create_project,
        ):
            operation.assert_not_called()

    async def test_live_check_uses_original_jar_and_saves_final_rotation_without_enabling(self):
        response = await self.call()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "accountId": 7, "email": EMAIL, "credits": 42})
        self.flow.validate_session.assert_awaited_once_with(
            google_cookies=COOKIES, token_id=7, expected_email=EMAIL,
        )
        self.assertEqual(self.flow._set_request_fingerprint.call_args_list[0].args[0], {"proxy_url": "http://account-proxy:8080"})
        saved = self.db.update_token_if_cookie_matches.call_args
        self.assertEqual(saved.args, (7, COOKIES))
        self.assertEqual(saved.kwargs["google_cookies"], ROTATED)
        self.assertEqual(saved.kwargs["credits"], 42)
        self.assertNotIn("is_active", saved.kwargs)
        self.assertFalse(self.account.is_active)
        self.assertEqual(self.account.google_cookies, COOKIES)
        self.assert_no_generation_or_enable()

    async def test_zero_credits_is_verified_success(self):
        self.flow.validate_session.return_value["credits"] = 0
        response = await self.call()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["credits"], 0)
        self.assert_no_generation_or_enable()

    async def test_default_request_proxy_and_email_fallback_match_protocol_refresh(self):
        self.account.proxy_url = ""
        self.account.login_account = None
        response = await self.call()
        self.assertEqual(response.status_code, 200)
        self.flow.validate_session.assert_awaited_once_with(google_cookies=COOKIES, token_id=7, expected_email=EMAIL)
        self.flow._set_request_fingerprint.assert_called_once_with(None)

    async def test_requires_admin_session(self):
        response = await self.call(authorized=False)
        self.assertEqual(response.status_code, 401)
        self.db.get_token.assert_not_awaited()
        self.flow.validate_session.assert_not_awaited()

    async def test_missing_account_returns_404(self):
        self.account = None
        response = await self.call()
        self.assertEqual(response.status_code, 404)
        self.flow.validate_session.assert_not_awaited()

    async def test_wrong_or_missing_live_identity_is_auth_failure_before_credits(self):
        for email in ("wrong@example.com", "", None):
            with self.subTest(email=email):
                self.flow.validate_session.return_value["email"] = email
                response = await self.call()
                self.assertEqual(response.status_code, 401)
                self.assertNotIn("wrong@example.com", response.text)
        self.assert_no_generation_or_enable()

    async def test_missing_cookie_session_fails_before_network(self):
        self.account.google_cookies = "SID=private-google-cookie"
        response = await self.call()
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("private-google-cookie", response.text)
        self.flow.validate_session.assert_not_awaited()
        self.assert_no_generation_or_enable()

    async def test_credit_rpc_rejection_and_network_failure_are_safe(self):
        for error, code in (
            (FlowFrontendAuthError("rpc=anything, code=401 private-cookie"), 401),
            (RuntimeError("rpc=anything, code=401 private-cookie"), 401),
            (RuntimeError("UNAUTHENTICATED private-cookie"), 401),
            (TimeoutError("private-password"), 503),
        ):
            with self.subTest(code=code):
                self.flow.validate_session.side_effect = error
                response = await self.call()
                self.assertEqual(response.status_code, code)
                self.assertNotIn("private-", response.text)
        self.assert_no_generation_or_enable()

    async def test_invalid_credits_cannot_be_reported_as_zero_success(self):
        for result in ({}, {"credits": None}, {"credits": True}, {"credits": "0"}, {"credits": -1}):
            with self.subTest(result=result):
                self.flow.validate_session.return_value = {"email": EMAIL, **result}
                self.assertEqual((await self.call()).status_code, 503)

    async def test_concurrent_cookie_identity_or_proxy_change_rejects_stale_result(self):
        original = self.account
        for update in (
            {"google_cookies": "newer-extension-push"}, {"email": "changed@example.com"},
            {"login_account": "changed@example.com"}, {"proxy_url": "http://new-proxy:8080"},
        ):
            with self.subTest(update=update):
                self.account = original

                async def changed_during_check(*args, **kwargs):
                    self.account = original.model_copy(update=update)
                    return {"email": EMAIL, "credits": 42}

                self.flow.validate_session.side_effect = changed_during_check
                response = await self.call()
                self.assertEqual(response.status_code, 409)
                self.assertNotIn("changed@example.com", response.text)
        self.assert_no_generation_or_enable()

    async def test_concurrent_cookie_push_during_commit_returns_conflict(self):
        self.db.update_token_if_cookie_matches.return_value = False
        self.assertEqual((await self.call()).status_code, 409)
        self.flow.validate_session.assert_awaited_once()
        self.assert_no_generation_or_enable()

    async def test_account_deleted_during_check_cannot_succeed(self):
        async def deleted(*args, **kwargs):
            self.account = None
            return {"email": EMAIL, "credits": 42}

        self.flow.validate_session.side_effect = deleted
        self.assertEqual((await self.call()).status_code, 409)
        self.assert_no_generation_or_enable()


if __name__ == "__main__":
    unittest.main()
