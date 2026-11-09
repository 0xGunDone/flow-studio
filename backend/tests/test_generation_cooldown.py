"""Offline account cooldown, protected hold, and pinned retry contracts."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from src.api import admin, routes
from src.core.database import Database
from src.core.models import ChatCompletionRequest, Token
from src.services.load_balancer import LoadBalancer
from src.services.flow_client import FlowClient
from src.services.generation_handler import GenerationHandler
from src.services.token_manager import TokenManager


class GenerationCooldownTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = Database(f"{self.temp_dir.name}/flow.db")
        await self.db.init_db()
        self.token_id = await self.db.add_token(Token(
            st="synthetic-session", email="synthetic@example.invalid",
            user_paygate_tier="PAYGATE_TIER_TWO",
        ))
        self.manager = TokenManager(self.db, None)

    async def asyncTearDown(self):
        self.temp_dir.cleanup()

    async def test_failure_persists_30_minute_cooldown_across_db_reopen(self):
        before = datetime.now(timezone.utc)
        await self.db.update_admin_config(error_ban_threshold=1)
        await self.manager.record_generation_error(self.token_id, "HTTP 500: upstream error")
        reopened = Database(self.db.db_path)
        token = await reopened.get_token(self.token_id)
        self.assertTrue(token.is_active)
        self.assertIsNone(token.ban_reason)
        self.assertEqual(token.generation_last_error, "HTTP 500: upstream error")
        self.assertGreaterEqual(token.generation_last_error_at, before)
        self.assertGreaterEqual(token.generation_cooldown_until, before + timedelta(minutes=30))
        self.assertLessEqual(token.generation_cooldown_until, datetime.now(timezone.utc) + timedelta(minutes=30))
        self.assertGreater(token.generation_cooldown_remaining_seconds, 1790)
        self.assertEqual((await reopened.get_token_stats(self.token_id)).error_count, 1)

    async def test_clear_ordinary_cooldown_preserves_manual_disable_and_error_history(self):
        await self.manager.record_generation_error(self.token_id, "HTTP 401: session rejected")
        await self.manager.disable_token(self.token_id, manual=True)
        with patch.object(admin, "db", self.db):
            result = await admin.clear_token_cooldown(self.token_id, token="synthetic-admin")
        self.assertTrue(result["success"])
        token = await self.db.get_token(self.token_id)
        self.assertFalse(token.is_active)
        self.assertEqual(token.ban_reason, "manual_disabled")
        self.assertIsNone(token.generation_cooldown_until)
        self.assertEqual(token.generation_last_error, "HTTP 401: session rejected")
        self.assertEqual((await self.db.get_token_stats(self.token_id)).error_count, 1)

    async def test_unusual_activity_hold_cannot_be_cleared_or_hidden_by_later_error(self):
        await self.manager.record_generation_error(self.token_id, "PUBLIC_ERROR_UNUSUAL_ACTIVITY")
        await self.manager.record_generation_error(self.token_id, "HTTP 500: upstream error")
        token = await self.db.get_token(self.token_id)
        self.assertFalse(token.generation_cooldown_reset_allowed)
        self.assertIn("PUBLIC_ERROR_UNUSUAL_ACTIVITY", token.generation_last_error)
        with patch.object(admin, "db", self.db):
            with self.assertRaises(HTTPException) as error:
                await admin.clear_token_cooldown(self.token_id, token="synthetic-admin")
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("PUBLIC_ERROR_UNUSUAL_ACTIVITY", str(error.exception.detail))
        self.assertGreater((await self.db.get_token(self.token_id)).generation_cooldown_remaining_seconds, 0)

    async def test_expired_hold_allows_local_reset_without_enabling_account(self):
        await self.manager.record_generation_error(self.token_id, "PUBLIC_ERROR_UNUSUAL_ACTIVITY")
        await self.manager.disable_token(self.token_id, manual=True)
        await self.db.update_token(self.token_id, generation_cooldown_until=datetime.now(timezone.utc) - timedelta(seconds=1))
        with patch.object(admin, "db", self.db):
            self.assertTrue((await admin.clear_token_cooldown(self.token_id, token="synthetic-admin"))["success"])
        self.assertFalse((await self.db.get_token(self.token_id)).is_active)

    async def test_admin_accounts_expose_persisted_cooldown_without_credentials_in_error(self):
        await self.manager.record_generation_error(self.token_id, "HTTP 429: too many requests")
        with patch.object(admin, "db", self.db):
            accounts = await admin.get_tokens(token="synthetic-admin")
        account = accounts[0]
        self.assertEqual(account["generation_last_error"], "HTTP 429: too many requests")
        self.assertIsNotNone(account["generation_cooldown_until"])
        self.assertIsNotNone(account["generation_last_error_at"])
        self.assertGreater(account["generation_cooldown_remaining_seconds"], 0)
        self.assertTrue(account["generation_cooldown_reset_allowed"])

    async def test_migration_adds_fields_to_existing_database(self):
        async with self.db._connect(write=True) as conn:
            for column in ("generation_cooldown_until", "generation_last_error", "generation_last_error_at"):
                await conn.execute(f"ALTER TABLE tokens DROP COLUMN {column}")
            await conn.commit()
        await self.db.check_and_migrate_db()
        token = await self.db.get_token(self.token_id)
        self.assertIsNone(token.generation_cooldown_until)
        self.assertEqual(token.generation_last_error, "")
        self.assertIsNone(token.generation_last_error_at)

    async def test_pinned_retry_never_falls_back_when_account_cools_down(self):
        second_id = await self.db.add_token(Token(st="synthetic-second", email="second@example.invalid", user_paygate_tier="PAYGATE_TIER_TWO"))
        self.manager.needs_at_refresh = lambda token: False
        self.manager.ensure_valid_token = AsyncMock(side_effect=lambda token: token)
        balancer = LoadBalancer(self.manager)
        await self.manager.record_generation_error(self.token_id, "HTTP 500: upstream error")
        selected = await balancer.select_token(for_video_generation=True, token_id=self.token_id)
        self.assertIsNone(selected)
        self.manager.ensure_valid_token.assert_not_awaited()
        selected = await balancer.select_token(for_video_generation=True)
        self.assertEqual(selected.id, second_id)
        message = await balancer.get_unavailable_reason(for_video_generation=True, token_id=self.token_id)
        self.assertIn("synthetic@example.invalid", message)
        self.assertIn("30", message)
        await self.db.update_token(self.token_id, generation_cooldown_until=datetime.now(timezone.utc) - timedelta(seconds=1))
        self.assertEqual((await balancer.select_token(for_video_generation=True, token_id=self.token_id)).id, self.token_id)
        self.assertIsNone(await balancer.select_token(for_video_generation=True, token_id=999999))
        self.assertIn("не найден", await balancer.get_unavailable_reason(token_id=999999))

    async def test_already_selected_account_is_checked_again_before_paid_submission(self):
        selected = await self.db.get_token(self.token_id)
        await self.manager.record_generation_error(self.token_id, "PUBLIC_ERROR_UNUSUAL_ACTIVITY")
        client = FlowClient(None, db=self.db)
        client._frontend_cookie = AsyncMock(return_value="synthetic-cookie")
        client._resolve_flow_frontend_cookie_storage = AsyncMock(return_value="synthetic-cookie")
        client._get_runtime_config = lambda: SimpleNamespace(flow_max_retries=1, flow_image_request_timeout=10)
        client._get_recaptcha_token = AsyncMock(return_value=("synthetic-captcha", None))
        client._notify_browser_captcha_request_finished = AsyncMock()
        client._current_rpc = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, "cooldown"):
            await client.generate_image("access", "22222222-2222-2222-2222-222222222222", "synthetic prompt", "BELUGA", "IMAGE_ASPECT_RATIO_LANDSCAPE", token_id=selected.id)
        client._current_rpc.assert_not_awaited()

    async def test_generation_handler_persists_failure_before_emitting_final_error(self):
        token = await self.db.get_token(self.token_id)
        handler = GenerationHandler.__new__(GenerationHandler)
        handler.db = self.db
        handler.load_balancer = SimpleNamespace(select_token=AsyncMock(return_value=token), release_pending=AsyncMock())
        handler.token_manager = self.manager
        self.manager.ensure_valid_token = AsyncMock(return_value=token)
        self.manager.ensure_project_exists = AsyncMock(return_value="22222222-2222-2222-2222-222222222222")
        handler.flow_client = SimpleNamespace(prefill_remote_browser_pool=AsyncMock())
        handler._update_request_log_progress = AsyncMock()
        handler._log_request = AsyncMock()

        async def reject(*args, **kwargs):
            handler._mark_generation_failed(kwargs["generation_result"], "HTTP 500: upstream error")
            yield handler._create_error_response("HTTP 500: upstream error", status_code=502)

        handler._handle_video_generation = reject
        async for chunk in handler.handle_generation("veo-3.1-quality", "synthetic prompt", requested_token_id=self.token_id):
            if "error" in json.loads(chunk):
                self.assertGreater((await self.db.get_token(self.token_id)).generation_cooldown_remaining_seconds, 0)
                self.assertEqual(json.loads(chunk)["flow_studio"]["account"]["id"], self.token_id)

    async def test_session_validation_failure_keeps_account_attribution_and_pending_release(self):
        account = await self.db.get_token(self.token_id)
        handler = GenerationHandler.__new__(GenerationHandler)
        handler.flow_client = SimpleNamespace()
        handler.load_balancer = SimpleNamespace(select_token=AsyncMock(return_value=account), release_pending=AsyncMock())
        handler.token_manager = self.manager
        self.manager.ensure_valid_token = AsyncMock(return_value=None)
        handler._update_request_log_progress = AsyncMock()
        handler._log_request = AsyncMock()
        output = [json.loads(chunk) async for chunk in handler.handle_generation("veo-3.1-quality", "synthetic prompt")]
        self.assertEqual(output[-1]["flow_studio"]["account"]["id"], self.token_id)
        self.assertGreater((await self.db.get_token(self.token_id)).generation_cooldown_remaining_seconds, 0)
        handler.load_balancer.release_pending.assert_awaited_once()


class PinnedRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_stream_and_nonstream_preserve_explicit_account(self):
        request = ChatCompletionRequest(model="veo-3.1-quality", messages=[{"role": "user", "content": "synthetic prompt"}], flow_studio_account_id=7)
        normalized = await routes._normalize_openai_request(request)
        self.assertEqual(normalized.requested_token_id, 7)
        calls = []

        async def generate(**kwargs):
            calls.append(kwargs)
            yield json.dumps({"error": {"message": "synthetic failure", "status_code": 503}})

        with patch.object(routes, "generation_handler", SimpleNamespace(handle_generation=generate)):
            async for _ in routes._iterate_openai_stream(normalized):
                pass
            await routes._collect_non_stream_result(normalized.model, normalized.prompt, normalized.images, requested_token_id=normalized.requested_token_id)
        self.assertEqual([call["requested_token_id"] for call in calls], [7, 7])

    def test_invalid_explicit_account_is_rejected(self):
        for value in (0, -1, True, 2.5, "not-an-id"):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                ChatCompletionRequest(model="veo-3.1-quality", flow_studio_account_id=value)


if __name__ == "__main__":
    unittest.main()
