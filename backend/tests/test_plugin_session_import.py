import hashlib
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from src.api import admin
from src.core.database import Database
from src.core.models import Token
from src.services.flow_frontend import FlowFrontendAuthError
from src.services.token_manager import TokenManager


EMAIL = "account@example.com"
ORIGINAL = "OSID=original; SID=account"
FINAL = "OSID=final; SID=account"


class PluginSessionImportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Database(db_path=self.temp.name + "/flow.db")
        await self.db.init_db()
        self.db.get_plugin_config = AsyncMock(return_value=SimpleNamespace(auto_enable_on_update=True))
        self.flow = MagicMock()
        self.flow.get_request_fingerprint.return_value = None
        self.flow.validate_session = AsyncMock(return_value={
            "email": EMAIL, "user": {"email": EMAIL}, "google_cookies": FINAL,
            "access_token": "flow-frontend-cookie", "expires": "2026-12-01T00:00:00Z",
            "credits": 42, "userPaygateTier": "PAYGATE_TIER_ONE",
        })
        self.flow.st_to_at = AsyncMock()
        self.flow.get_credits = AsyncMock()
        self.manager = TokenManager(self.db, self.flow)
        for patcher in (
            patch.object(admin, "db", self.db),
            patch.object(admin, "token_manager", self.manager),
            patch.object(admin, "_verify_plugin_connection_token", AsyncMock()),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def call(self):
        return await admin.plugin_update_token(admin.PluginTokenUpdateRequest(
            google_cookies=ORIGINAL, login_account=EMAIL,
        ), authorization="Bearer synthetic")

    async def existing(self):
        return await self.db.add_token(Token(
            email=EMAIL, login_account=EMAIL, st="old-st", google_cookies="OSID=old; SID=account",
            proxy_url="http://account-proxy.invalid:8080",
        ))

    async def test_existing_import_stores_final_validated_jar_and_metadata(self):
        token_id = await self.existing()
        self.assertTrue((await self.call())["success"])
        token = await self.db.get_token(token_id)
        self.assertEqual(token.google_cookies, FINAL)
        self.assertEqual(token.st, "frontend-" + hashlib.sha256(FINAL.encode()).hexdigest()[:32])
        self.assertEqual(token.credits, 42)
        self.assertEqual(token.last_st_refresh_result, "success")
        self.flow.validate_session.assert_awaited_once_with(
            google_cookies=ORIGINAL, expected_email=EMAIL, token_id=token_id,
        )
        self.assertEqual(self.flow._set_request_fingerprint.call_args_list[0].args[0], {"proxy_url": "http://account-proxy.invalid:8080"})
        self.flow.st_to_at.assert_not_awaited()
        self.flow.get_credits.assert_not_awaited()

    async def test_rejected_identity_does_not_change_existing_account(self):
        token_id = await self.existing()
        before = await self.db.get_token(token_id)
        for message in ("Flow не вернул аккаунт", "Аккаунт Flow не совпадает"):
            self.flow.validate_session.side_effect = FlowFrontendAuthError(message)
            with self.assertRaises(HTTPException):
                await self.call()
            self.assertEqual((await self.db.get_token(token_id)).model_dump(), before.model_dump())

    async def test_manual_disable_survives_import_and_automatic_failures_until_enabled(self):
        token_id = await self.existing()
        await admin.disable_token(token_id, token="synthetic")
        result = await self.call()
        await self.manager.disable_token(token_id)
        with patch.object(self.db, "get_admin_config", return_value=SimpleNamespace(error_ban_threshold=1)):
            await self.manager.record_error(token_id)
        await self.manager.ban_token_for_429(token_id)
        token = await self.db.get_token(token_id)
        self.assertFalse(token.is_active)
        self.assertEqual(token.ban_reason, "manual_disabled")
        self.assertIsNone(token.banned_at)
        self.assertEqual(token.google_cookies, FINAL)
        self.assertFalse(result.get("auto_enabled", False))

        await admin.enable_token(token_id, token="synthetic")
        token = await self.db.get_token(token_id)
        self.assertTrue(token.is_active)
        self.assertIsNone(token.ban_reason)

    async def test_automatic_disable_still_allows_plugin_recovery(self):
        token_id = await self.existing()
        await self.manager.disable_token(token_id)
        result = await self.call()
        self.assertTrue(result["auto_enabled"])
        token = await self.db.get_token(token_id)
        self.assertTrue(token.is_active)
        self.assertIsNone(token.ban_reason)

    async def test_disable_during_plugin_validation_survives_reconnect(self):
        token_id = await self.existing()
        session = self.flow.validate_session.return_value

        async def disable_before_validation_returns(**kwargs):
            await self.manager.disable_token(token_id, manual=True)
            return session

        self.flow.validate_session.side_effect = disable_before_validation_returns
        await self.call()
        token = await self.db.get_token(token_id)
        self.assertFalse(token.is_active)
        self.assertEqual(token.ban_reason, "manual_disabled")
        self.assertEqual(token.google_cookies, FINAL)

    async def test_disable_wins_credential_and_plugin_enable_commit_races(self):
        token_id = await self.existing()
        original_update = self.db.update_token
        for stage in ("credentials", "plugin_enable"):
            with self.subTest(stage=stage):
                await self.manager.enable_token(token_id)
                await self.manager.disable_token(token_id)
                raced = False

                async def disable_before_commit(id, **kwargs):
                    nonlocal raced
                    matches_stage = ("st" in kwargs) == (stage == "credentials")
                    if not raced and kwargs.get("is_active") is True and matches_stage:
                        raced = True
                        await original_update(id, is_active=False, ban_reason="manual_disabled", banned_at=None)
                    await original_update(id, **kwargs)

                with patch.object(self.db, "update_token", side_effect=disable_before_commit):
                    result = await self.call()
                self.assertTrue(raced)
                token = await self.db.get_token(token_id)
                self.assertFalse(token.is_active)
                self.assertEqual(token.ban_reason, "manual_disabled")
                self.assertEqual(token.google_cookies, FINAL)
                self.assertFalse(result.get("auto_enabled", False))

    async def test_manual_disable_wins_stale_429_unban(self):
        token_id = await self.existing()
        now = datetime.now(timezone.utc)
        await self.db.update_token(
            token_id, is_active=False, ban_reason="429_rate_limit",
            banned_at=now - timedelta(hours=13), at_expires=now + timedelta(days=1),
        )
        original_list = self.db.get_all_tokens

        async def disable_after_snapshot():
            snapshot = await original_list()
            await self.manager.disable_token(token_id, manual=True)
            return snapshot

        with patch.object(self.db, "get_all_tokens", side_effect=disable_after_snapshot):
            await self.manager.auto_unban_429_tokens()
        token = await self.db.get_token(token_id)
        self.assertFalse(token.is_active)
        self.assertEqual(token.ban_reason, "manual_disabled")
        self.assertIsNone(token.banned_at)

    async def test_new_account_keeps_rotations_during_project_setup(self):
        self.manager._get_project_pool_size = lambda: 2
        calls = []

        async def create_project(st, title, *, google_cookies, session_context):
            calls.append(google_cookies)
            self.assertEqual(session_context["expected_email"], EMAIL)
            session_context["google_cookies"] = f"OSID=project-{len(calls)}; SID=account"
            return f"00000000-0000-0000-0000-{len(calls):012d}"

        self.flow.create_project = AsyncMock(side_effect=create_project)
        result = await self.call()
        token = await self.db.get_token(result["token_id"])
        self.assertEqual(calls, [FINAL, "OSID=project-1; SID=account"])
        self.assertEqual(token.google_cookies, "OSID=project-2; SID=account")
        self.assertEqual(token.credits, 42)
        self.assertEqual(token.last_st_refresh_result, "success")
        self.flow.st_to_at.assert_not_awaited()
        self.flow.get_credits.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
