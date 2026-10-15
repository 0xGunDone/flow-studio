import asyncio
import json
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, call, patch

from src.core.models import Token
from src.services.flow_frontend import FlowFrontendAuthError, FlowFrontendMixin
from src.services.generation_handler import GenerationHandler


OPERATION_ID = "11111111-1111-1111-1111-111111111111"
PROJECT_ID = "22222222-2222-2222-2222-222222222222"
MEDIA_ID = "33333333-3333-3333-3333-333333333333"
VIDEO_URL = f"https://flow-content.google/video/{MEDIA_ID}"
AUTH_ERROR = "Google Flow отклонил авторизацию (rpc=jwpduf, code=401)"


class VideoPollCredentialsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.token = Token(
            id=7, email="account@example.com", st="old-session",
            at="old-access", google_cookies="old-cookies",
        )
        self.latest = self.token.model_copy(update={
            "login_account": " ACCOUNT@EXAMPLE.COM ",
            "st": "new-session", "at": "new-access", "google_cookies": "new-cookies",
        })
        self.operations = [{
            "name": OPERATION_ID, "operation": {"name": OPERATION_ID},
            "projectId": PROJECT_ID, "mediaName": MEDIA_ID,
        }]
        completed = {
            **self.operations[0], "operation": {"name": OPERATION_ID},
            "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
        }
        self.handler = GenerationHandler.__new__(GenerationHandler)
        self.handler.db = types.SimpleNamespace(
            get_token=AsyncMock(return_value=self.latest), update_task=AsyncMock(),
        )
        self.handler.token_manager = types.SimpleNamespace(
            refresh_cookies=AsyncMock(return_value=False),
        )
        self.handler.flow_client = MagicMock()
        self.handler.flow_client.check_video_status = AsyncMock(
            return_value={"operations": [completed]}
        )
        self.handler.flow_client.get_media_url_redirect = AsyncMock(return_value=VIDEO_URL)
        self.handler.flow_client.generate_video_text = AsyncMock()
        self.handler.flow_client.upsample_video = AsyncMock()
        self.config = types.SimpleNamespace(
            poll_interval=0.1, video_timeout=2, cache_enabled=False,
        )
        self.generation_result = {}

    async def poll(self):
        with patch("src.services.generation_handler.config", self.config):
            return [json.loads(chunk) async for chunk in self.handler._poll_video_result(
                self.token, PROJECT_ID, self.operations, False,
                generation_result=self.generation_result,
            )]

    def assert_no_generation_replay(self):
        self.handler.flow_client.generate_video_text.assert_not_awaited()
        self.handler.flow_client.upsample_video.assert_not_awaited()

    async def test_latest_same_account_credentials_reach_status_and_media(self):
        result = await self.poll()

        self.handler.db.get_token.assert_awaited_once_with(self.token.id)
        self.handler.flow_client.check_video_status.assert_awaited_once_with(
            "new-access", self.operations, token_id=7, google_cookies="new-cookies",
        )
        self.handler.flow_client.get_media_url_redirect.assert_awaited_once_with(
            "new-session", OPERATION_ID, media_url_type="MEDIA_URL_TYPE_FULL_MEDIA",
            token_id=7, google_cookies="new-cookies", project_id=PROJECT_ID,
        )
        self.assertTrue(self.generation_result["success"])
        self.assertIn(VIDEO_URL, result[0]["choices"][0]["message"]["content"])
        self.assertEqual(self.handler.db.update_task.await_args.kwargs["status"], "completed")
        self.assert_no_generation_replay()

    async def test_auth_failure_recovers_after_cookie_update_without_resubmitting(self):
        self.handler.db.get_token.return_value = self.token

        async def refresh(_token_id):
            self.handler.db.get_token.return_value = self.latest
            return True

        self.handler.token_manager.refresh_cookies.side_effect = refresh
        completed = self.handler.flow_client.check_video_status.return_value
        self.handler.flow_client.check_video_status.side_effect = [
            FlowFrontendAuthError(AUTH_ERROR), completed,
        ]

        await self.poll()

        self.assertEqual(self.handler.db.get_token.await_args_list, [call(7), call(7)])
        calls = self.handler.flow_client.check_video_status.await_args_list
        self.assertEqual([entry.kwargs["google_cookies"] for entry in calls], [
            "old-cookies", "new-cookies",
        ])
        for entry in calls:
            self.assertIs(entry.args[1], self.operations)
            self.assertEqual(entry.kwargs["token_id"], 7)
        self.assertTrue(self.generation_result["success"])
        self.handler.token_manager.refresh_cookies.assert_awaited_once_with(7)
        self.assert_no_generation_replay()

    async def test_changed_account_identity_never_reaches_flow(self):
        self.handler.db.get_token.return_value = self.latest.model_copy(update={
            "login_account": "other@example.com", "email": "other@example.com",
        })

        result = await self.poll()

        self.assertEqual(self.handler.db.get_token.await_count, 3)
        self.handler.flow_client.check_video_status.assert_not_awaited()
        self.handler.flow_client.get_media_url_redirect.assert_not_awaited()
        self.assertIn("Аккаунт отправленной задачи видео изменился", result[0]["error"]["message"])
        self.assertFalse(self.generation_result["success"])
        self.handler.token_manager.refresh_cookies.assert_not_awaited()
        self.assert_no_generation_replay()

    async def test_persistent_auth_failure_keeps_three_attempt_limit(self):
        self.handler.flow_client.check_video_status.side_effect = FlowFrontendAuthError(AUTH_ERROR)

        result = await self.poll()

        self.assertEqual(self.handler.flow_client.check_video_status.await_count, 3)
        self.assertEqual(self.handler.db.get_token.await_args_list, [call(7)] * 3)
        self.assertEqual(result[0]["error"]["status_code"], 502)
        self.assertIn(AUTH_ERROR, result[0]["error"]["message"])
        self.assertEqual(self.handler.db.update_task.await_args.kwargs["status"], "failed")
        self.handler.token_manager.refresh_cookies.assert_awaited_once_with(7)
        self.assert_no_generation_replay()

    async def test_non_auth_failure_does_not_refresh_cookies(self):
        self.handler.flow_client.check_video_status.side_effect = RuntimeError("status request timed out")

        result = await self.poll()

        self.assertEqual(self.handler.flow_client.check_video_status.await_count, 3)
        self.handler.token_manager.refresh_cookies.assert_not_awaited()
        self.assertIn("Не удалось проверить статус видео", result[0]["error"]["message"])
        self.assert_no_generation_replay()

    async def test_refresh_exception_preserves_original_poll_failure_and_retry_limit(self):
        self.handler.flow_client.check_video_status.side_effect = FlowFrontendAuthError(AUTH_ERROR)
        self.handler.token_manager.refresh_cookies.side_effect = RuntimeError("refresh failed")

        result = await self.poll()

        self.assertEqual(self.handler.flow_client.check_video_status.await_count, 3)
        self.handler.token_manager.refresh_cookies.assert_awaited_once_with(7)
        self.assertIn(AUTH_ERROR, result[0]["error"]["message"])
        self.assertIn("Не удалось проверить статус видео", result[0]["error"]["message"])
        self.assertNotIn("refresh failed", result[0]["error"]["message"])
        self.assert_no_generation_replay()

    async def test_refresh_is_cancelled_at_poll_deadline(self):
        cancelled = asyncio.Event()

        async def blocked_refresh(_token_id):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        self.handler.flow_client.check_video_status.side_effect = FlowFrontendAuthError(AUTH_ERROR)
        self.handler.token_manager.refresh_cookies.side_effect = blocked_refresh
        self.config.video_timeout = 0.2

        result = await asyncio.wait_for(self.poll(), timeout=1)

        self.assertTrue(cancelled.is_set())
        self.handler.flow_client.check_video_status.assert_awaited_once()
        self.handler.token_manager.refresh_cookies.assert_awaited_once_with(7)
        self.assertEqual(result[0]["error"]["status_code"], 504)
        self.assertIn(AUTH_ERROR, result[0]["error"]["message"])
        self.assert_no_generation_replay()

    def test_rpc_only_classifies_explicit_401_as_auth_error(self):
        with self.assertRaises(FlowFrontendAuthError):
            FlowFrontendMixin._raise_batchexecute_error(
                [[["er", None, None, None, None, 401]]], "jwpduf"
            )
        with self.assertRaises(RuntimeError) as error:
            FlowFrontendMixin._raise_batchexecute_error(
                [[["er", None, None, None, None, 500]]], "jwpduf"
            )
        self.assertNotIsInstance(error.exception, FlowFrontendAuthError)

    async def test_credential_reload_is_cancelled_at_poll_deadline(self):
        cancelled = asyncio.Event()

        async def blocked_reload(_token_id):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        self.handler.db.get_token.side_effect = blocked_reload
        self.config.video_timeout = 0.2

        result = await asyncio.wait_for(self.poll(), timeout=1)

        self.assertTrue(cancelled.is_set())
        self.handler.db.get_token.assert_awaited_once_with(7)
        self.handler.flow_client.check_video_status.assert_not_awaited()
        self.assertEqual(result[0]["error"]["status_code"], 504)
        self.assert_no_generation_replay()


if __name__ == "__main__":
    unittest.main()
