"""Public Flow rejections must not replay paid requests or penalize credentials."""

import json
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from src.core.models import Token
from src.services.flow_client import FlowClient
from src.services.flow_frontend import FlowFrontendMixin
from src.services.generation_handler import GenerationHandler


PROJECT = "22222222-2222-2222-2222-222222222222"
OPERATION = "11111111-1111-1111-1111-111111111111"
MEDIA = "33333333-3333-3333-3333-333333333333"
MINOR = "PUBLIC_ERROR_MINOR"


class PublicErrorSubmissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = FlowClient(None)
        self.client._get_runtime_config = lambda: types.SimpleNamespace(
            flow_max_retries=3, flow_image_request_timeout=10,
        )
        self.client._frontend_cookie = AsyncMock(return_value="synthetic-cookie")
        self.client._resolve_flow_frontend_cookie_storage = AsyncMock(
            return_value="synthetic-cookie"
        )
        self.client._get_recaptcha_token = AsyncMock(return_value=("synthetic-captcha", None))
        self.client._notify_browser_captcha_request_finished = AsyncMock()
        self.client._current_rpc = AsyncMock()

    async def video(self):
        return await self.client.generate_video_text(
            "access", PROJECT, "synthetic test", "veo_3_1_t2v",
            "VIDEO_ASPECT_RATIO_LANDSCAPE", token_id=7,
        )

    async def test_public_rejection_stops_video_submission_after_first_attempt(self):
        for code in (MINOR, "PUBLIC_ERROR_USER_MINOR", "PUBLIC_ERROR_UNKNOWN_FUTURE"):
            with self.subTest(code=code):
                self.setUp()
                self.client._current_rpc.side_effect = RuntimeError(
                    f"Flow frontend RPC rejected: rpc=YhhmEf, error={code}"
                )
                with self.assertRaisesRegex(RuntimeError, code) as error:
                    await self.video()
                self.assertIn("Google Flow отклонил", str(error.exception))
                self.client._current_rpc.assert_awaited_once()
                self.client._get_recaptcha_token.assert_awaited_once()

    async def test_minor_image_rejection_stops_before_retry_handler(self):
        self.client._current_rpc.side_effect = RuntimeError(
            f"Flow frontend RPC rejected: rpc=ogiZ0b, error={MINOR}"
        )
        self.client._handle_retryable_generation_error = AsyncMock(return_value=True)
        with self.assertRaisesRegex(RuntimeError, MINOR) as error:
            await self.client.generate_image(
                "access", PROJECT, "synthetic test", "BELUGA",
                "IMAGE_ASPECT_RATIO_LANDSCAPE", token_id=7,
            )
        self.assertIn("создание изображения", str(error.exception))
        self.client._current_rpc.assert_awaited_once()
        self.client._handle_retryable_generation_error.assert_not_awaited()

    async def test_video_unusual_activity_keeps_configured_retry_budget(self):
        for code in (
            "PUBLIC_ERROR_UNUSUAL_ACTIVITY",
            "PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC",
        ):
            with self.subTest(code=code):
                self.setUp()
                self.client._current_rpc.side_effect = RuntimeError(code)
                with self.assertRaisesRegex(RuntimeError, code):
                    await self.video()
                self.assertEqual(self.client._current_rpc.await_count, 3)

    def test_shared_retry_distinguishes_public_rejection_from_transient_error(self):
        for error in (
            MINOR, "PUBLIC_ERROR_USER_MINOR", "PUBLIC_ERROR_UNKNOWN_FUTURE",
            "PUBLIC_ERROR_UNSAFE_GENERATION",
        ):
            with self.subTest(error=error):
                self.assertIsNone(self.client._get_retry_reason(error))
        self.assertIsNotNone(self.client._get_retry_reason("PUBLIC_ERROR_UNUSUAL_ACTIVITY"))
        self.assertIsNotNone(self.client._get_retry_reason("PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC"))
        self.assertIsNotNone(self.client._get_retry_reason("HTTP 429: too many requests"))

    def test_terminal_submission_payload_preserves_minor_rejection(self):
        payload = [OPERATION, PROJECT, MEDIA, None, [4, [3, MINOR]]]
        with self.assertRaisesRegex(RuntimeError, MINOR) as error:
            self.client._normalize_frontend_video_submission(
                payload, project_id=PROJECT,
                aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE", model_key="veo_3_1_t2v",
            )
        self.assertIn("Возможна возрастная проверка содержимого", str(error.exception))


class PublicErrorPollingTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_public_status_never_falls_back_to_media(self):
        for payload in ([OPERATION, PROJECT, MEDIA, None, [4, [3, MINOR]]], RuntimeError(MINOR)):
            with self.subTest(payload_type=type(payload).__name__):
                client = FlowClient(None)
                client._current_rpc = AsyncMock()
                if isinstance(payload, Exception):
                    client._current_rpc.side_effect = payload
                else:
                    client._current_rpc.return_value = payload
                client.get_media = AsyncMock(return_value={})
                result = await client.check_video_status("access", [{
                    "name": OPERATION, "operation": {"name": OPERATION},
                    "projectId": PROJECT, "mediaName": MEDIA,
                }])
                self.assertEqual(result["operations"][0]["status"], "MEDIA_GENERATION_STATUS_FAILED")
                self.assertEqual(result["operations"][0]["operation"]["error"]["code"], MINOR)
                client._current_rpc.assert_awaited_once()
                client.get_media.assert_not_awaited()

    async def test_minor_poll_is_terminal_localized_and_has_no_retry_hint(self):
        operations = [{
            "name": OPERATION, "operation": {"name": OPERATION},
            "projectId": PROJECT, "mediaName": MEDIA,
        }]
        normalized = FlowFrontendMixin._normalize_frontend_video_status(
            [OPERATION, PROJECT, MEDIA, None, [4, [3, MINOR]]], operations,
        )
        rejected = normalized["operations"][0]
        self.assertEqual(rejected["status"], "MEDIA_GENERATION_STATUS_FAILED")
        self.assertEqual(rejected["operation"]["error"]["code"], MINOR)

        token = Token(id=7, email="synthetic@example.invalid", st="session", at="access")
        handler = GenerationHandler.__new__(GenerationHandler)
        handler.db = types.SimpleNamespace(
            get_token=AsyncMock(return_value=token), update_task=AsyncMock(),
        )
        handler.token_manager = types.SimpleNamespace(refresh_cookies=AsyncMock())
        handler.flow_client = types.SimpleNamespace(
            check_video_status=AsyncMock(return_value=normalized),
        )
        generation_result = {}
        runtime = types.SimpleNamespace(poll_interval=0.1, video_timeout=1)
        with patch("src.services.generation_handler.config", runtime):
            output = [json.loads(chunk) async for chunk in handler._poll_video_result(
                token, PROJECT, operations, False, generation_result=generation_result,
            )]
        message = output[0]["error"]["message"]
        self.assertIn(MINOR, message)
        self.assertIn("Возможна возрастная проверка содержимого", message)
        self.assertIn("Сервис не сообщил, какой элемент вызвал отказ", message)
        self.assertIn("в веб-версии Flow", message)
        self.assertNotIn("Повторите попытку", message)
        self.assertFalse(generation_result["success"])
        handler.flow_client.check_video_status.assert_awaited_once()
        handler.token_manager.refresh_cookies.assert_not_awaited()
        self.assertEqual(handler.db.update_task.await_args.kwargs["status"], "failed")


class PublicErrorAccountTests(unittest.IsolatedAsyncioTestCase):
    async def test_token_penalty_skips_only_known_content_rejections(self):
        for raises in (False, True):
            for code, count_result, count_exception in (
                (MINOR, False, False),
                ("PUBLIC_ERROR_UNSAFE_GENERATION", False, False),
                ("PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED", False, False),
                ("PUBLIC_ERROR_USER_MINOR", True, True),
                ("PUBLIC_ERROR_UNKNOWN_FUTURE", True, True),
                ("PUBLIC_ERROR_UNUSUAL_ACTIVITY", True, False),
                ("HTTP 429: too many requests", True, True),
            ):
                with self.subTest(raises=raises, code=code):
                    token = Token(
                        id=7, email="synthetic@example.invalid", st="session", at="access",
                        user_paygate_tier="PAYGATE_TIER_TWO",
                    )
                    handler = GenerationHandler.__new__(GenerationHandler)
                    handler.load_balancer = types.SimpleNamespace(
                        select_token=AsyncMock(return_value=token), release_pending=AsyncMock(),
                    )
                    handler.token_manager = types.SimpleNamespace(
                        ensure_valid_token=AsyncMock(return_value=token),
                        ensure_project_exists=AsyncMock(return_value=PROJECT),
                        record_error=AsyncMock(), record_usage=AsyncMock(), record_success=AsyncMock(),
                    )
                    handler.flow_client = types.SimpleNamespace(prefill_remote_browser_pool=AsyncMock())
                    handler._update_request_log_progress = AsyncMock()
                    handler._log_request = AsyncMock()

                    async def reject(*args, **kwargs):
                        if raises:
                            raise RuntimeError(code)
                        handler._mark_generation_failed(kwargs["generation_result"], code)
                        yield handler._create_error_response(code, status_code=502)

                    handler._handle_video_generation = reject
                    with patch("src.services.generation_handler.debug_logger", MagicMock()):
                        output = [json.loads(chunk) async for chunk in handler.handle_generation(
                            "veo-3.1-quality", "synthetic test", stream=False,
                        )]
                    self.assertIn(code, output[0]["error"]["message"])
                    if (count_exception if raises else count_result):
                        handler.token_manager.record_error.assert_awaited_once_with(7)
                    else:
                        handler.token_manager.record_error.assert_not_awaited()
                    handler.token_manager.record_usage.assert_not_awaited()
                    handler.token_manager.record_success.assert_not_awaited()
                    handler.load_balancer.release_pending.assert_awaited_once()

    def test_unknown_public_error_is_not_assumed_to_be_content_policy(self):
        handler = GenerationHandler.__new__(GenerationHandler)
        self.assertTrue(handler._should_count_token_error(RuntimeError("PUBLIC_ERROR_UNKNOWN_FUTURE")))
        self.assertTrue(handler._should_count_token_error(RuntimeError("PUBLIC_ERROR_USER_MINOR")))
        self.assertFalse(handler._should_count_token_error(RuntimeError("PUBLIC_ERROR_UNUSUAL_ACTIVITY")))
        self.assertTrue(handler._should_count_token_error(RuntimeError("HTTP 401: session rejected")))


if __name__ == "__main__":
    unittest.main()
