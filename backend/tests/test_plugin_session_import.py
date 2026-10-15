import hashlib
import tempfile
import unittest
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
