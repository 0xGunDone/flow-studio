import io
import sys
import traceback
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import AsyncMock, MagicMock, patch

from src.services.flow_client import FlowClient


JPEG_BYTES = b"\xff\xd8\xff" + b"0" * 16
PROJECT_ID = "01234567-89ab-cdef-0123-456789abcdef"
MEDIA_ID = "11234567-89ab-cdef-0123-456789abcdef"


class FlowClientUploadImageTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_uses_current_frontend_rpc(self):
        client = FlowClient(proxy_manager=None)
        client._get_recaptcha_token = AsyncMock(return_value=("captcha-token", None))
        client._call_flow_frontend_rpc = AsyncMock(
            return_value=[
                [
                    MEDIA_ID,
                    PROJECT_ID,
                    f"https://flow-content.google/image/{MEDIA_ID}?Signature=1",
                ]
            ]
        )
        client._make_request = AsyncMock()

        media_id = await client.upload_image(
            at="frontend-cookie",
            image_bytes=JPEG_BYTES,
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            project_id=PROJECT_ID,
            google_cookies="SID=session-cookie",
        )

        self.assertEqual(media_id, MEDIA_ID)
        client._make_request.assert_not_awaited()
        request = client._call_flow_frontend_rpc.await_args.kwargs
        self.assertEqual(request["rpc_id"], "maseQ")
        self.assertEqual(request["argument"][0][5], PROJECT_ID)
        self.assertEqual(request["argument"][0][10], ["captcha-token", 1])
        self.assertEqual(request["argument"][2], "image/jpeg")

    async def test_upload_argument_matches_current_frontend_envelope(self):
        client = FlowClient(proxy_manager=None)
        client._get_recaptcha_token = AsyncMock(return_value=("captcha-token", None))
        client._call_flow_frontend_rpc = AsyncMock(
            return_value=[[MEDIA_ID, PROJECT_ID, f"https://flow-content.google/image/{MEDIA_ID}?Signature=1"]]
        )
        client._make_request = AsyncMock()

        await client.upload_image(
            at="frontend-cookie",
            image_bytes=JPEG_BYTES,
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            project_id=PROJECT_ID,
            google_cookies="SID=session-cookie",
        )

        argument = client._call_flow_frontend_rpc.await_args.kwargs["argument"]
        self.assertEqual(len(argument), 12)
        # slot 3 is an integer enum; sending a bool makes the RPC reject with code=[3]
        self.assertIs(type(argument[3]), int)
        self.assertIsNone(argument[7])
        self.assertIsNone(argument[9])
        for slot in (10, 11):
            self.assertRegex(argument[slot], r"^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$")

    async def test_missing_upload_verification_never_sends_image(self):
        client = FlowClient(proxy_manager=None)
        client._get_recaptcha_token = AsyncMock(return_value=(None, None))
        client._current_rpc = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, "^Failed to obtain reCAPTCHA token for image upload$"):
            await client.upload_image(
                at="synthetic", image_bytes=JPEG_BYTES,
                project_id=PROJECT_ID, token_id=7,
            )
        client._current_rpc.assert_not_awaited()

    async def test_browser_upload_failures_keep_safe_cause_without_sending_image(self):
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError
        secret = "synthetic-cookie-secret HTTP 401"
        for error, code in (
            (TimeoutError(secret), "FLOW_UPLOAD_BROWSER_TIMEOUT"),
            (PlaywrightTimeoutError(secret), "FLOW_UPLOAD_BROWSER_TIMEOUT"),
            (ImportError(secret), "FLOW_UPLOAD_BROWSER_UNAVAILABLE"),
            (RuntimeError(secret), "FLOW_UPLOAD_BROWSER_ERROR"),
            (ValueError(secret), "FLOW_UPLOAD_BROWSER_ERROR"),
        ):
            with self.subTest(error_type=type(error).__name__):
                client = FlowClient(proxy_manager=None)
                client._current_rpc = AsyncMock()
                client._set_request_fingerprint({"user_agent": "synthetic"})
                service = types.SimpleNamespace(get_token=AsyncMock(side_effect=error))
                module = types.ModuleType("src.services.browser_captcha")
                module.BrowserCaptchaService = types.SimpleNamespace(
                    get_instance=AsyncMock(return_value=service)
                )
                module.BrowserCaptchaQueueTimeout = type("BrowserCaptchaQueueTimeout", (RuntimeError,), {})
                output = io.StringIO()
                logger = MagicMock()
                with patch.dict(sys.modules, {module.__name__: module}), patch(
                    "src.services.flow_client.config", types.SimpleNamespace(captcha_method="browser")
                ), patch("src.services.flow_client.debug_logger", logger), redirect_stdout(output), redirect_stderr(output):
                    with self.assertRaisesRegex(RuntimeError, rf"\[{code}\]") as raised:
                        await client.upload_image(
                            at="synthetic", image_bytes=JPEG_BYTES,
                            project_id=PROJECT_ID, token_id=7,
                        )
                client._current_rpc.assert_not_awaited()
                self.assertIsNone(client.get_request_fingerprint())
                public_output = "".join(traceback.format_exception(raised.exception)) + output.getvalue() + repr(logger.mock_calls)
                self.assertNotIn(secret, public_output)
                self.assertNotIn("401", public_output)
                self.assertIn(f"[{code}]", output.getvalue())

    async def test_browser_empty_upload_verification_has_code_and_never_sends_image(self):
        client = FlowClient(proxy_manager=None)
        client._get_recaptcha_token = AsyncMock(return_value=(None, None))
        client._set_captcha_request_context({"method": "browser"})
        client._current_rpc = AsyncMock()
        output = io.StringIO()
        with redirect_stderr(output), self.assertRaisesRegex(RuntimeError, r"\[FLOW_UPLOAD_VERIFICATION_EMPTY\]"):
            await client.upload_image(
                at="synthetic", image_bytes=JPEG_BYTES,
                project_id=PROJECT_ID, token_id=7,
            )
        client._current_rpc.assert_not_awaited()
        self.assertIn("[FLOW_UPLOAD_VERIFICATION_EMPTY]", output.getvalue())

    async def test_browser_nonupload_failure_and_queue_timeout_keep_existing_behavior(self):
        queue_error = type("BrowserCaptchaQueueTimeout", (RuntimeError,), {})("synthetic queue timeout")
        for action, error in (("IMAGE_GENERATION", RuntimeError("synthetic error")), ("UPLOAD_IMAGE", queue_error)):
            with self.subTest(action=action):
                client = FlowClient(proxy_manager=None)
                module = types.ModuleType("src.services.browser_captcha")
                module.BrowserCaptchaService = types.SimpleNamespace(
                    get_instance=AsyncMock(side_effect=error)
                )
                module.BrowserCaptchaQueueTimeout = type(queue_error)
                with patch.dict(sys.modules, {module.__name__: module}), patch(
                    "src.services.flow_client.config", types.SimpleNamespace(captcha_method="browser")
                ), patch("src.services.flow_client.debug_logger", MagicMock()), redirect_stdout(io.StringIO()):
                    if action == "UPLOAD_IMAGE":
                        with self.assertRaises(type(queue_error)) as raised:
                            await client._get_recaptcha_token(PROJECT_ID, action=action)
                        self.assertIs(raised.exception, queue_error)
                    else:
                        self.assertEqual(await client._get_recaptcha_token(PROJECT_ID, action=action), (None, None))

    async def test_upload_requires_project_id(self):
        client = FlowClient(proxy_manager=None)

        with self.assertRaisesRegex(ValueError, "requires project_id"):
            await client.upload_image(
                at="frontend-cookie",
                image_bytes=JPEG_BYTES,
                project_id=None,
                google_cookies="SID=session-cookie",
            )


if __name__ == "__main__":
    unittest.main()
