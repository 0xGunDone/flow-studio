"""Native video bytes, scoped upload cookies, and captured Omni edit RPC shape."""

import json
import types
import unittest
from unittest.mock import AsyncMock, patch

from curl_cffi.requests import Cookies

from src.services.browser_cookie_utils import serialize_cookie_header_for_url
from src.services.flow_client import FlowClient
from src.services.flow_frontend import FlowFrontendAuthError
from src.services.protocol_login import _export_cookie_jar
from test_flow_frontend_transport import BOOTSTRAP, COOKIES, _Transport, response


PROJECT = "01234567-89ab-cdef-0123-456789abcdef"
VIDEO = "11234567-89ab-cdef-0123-456789abcdef"
IMAGE = "21234567-89ab-cdef-0123-456789abcdef"
VIDEO_BYTES = b"\x00\x00\x00\x18ftypmp42original-video-bytes"


def upload_response(text, cookies, headers=None, status=200):
    result = response(text, cookies)
    result.headers = headers or {}
    result.status_code = status
    return result


class FlowVideoReferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = FlowClient(None)
        self.client._set_request_fingerprint({
            "user_agent": "Mozilla/5.0 Macintosh Version/18.0 Safari/605.1.15",
            "proxy_url": "http://proxy.invalid:8080",
            "session_cookies": {"HSID": "wrong-scope"},
        })
        self.client._get_recaptcha_token = AsyncMock()

    async def upload(self, transport):
        with patch("src.services.flow_frontend.AsyncSession", transport.session):
            return await self.client.upload_video(
                at="frontend-cookie", video_bytes=VIDEO_BYTES,
                filename="сцена.mp4", mime_type="video/mp4", project_id=PROJECT,
                google_cookies=json.dumps(COOKIES),
            )

    async def test_native_upload_keeps_bytes_cookie_scope_and_fingerprint(self):
        cookies = [cookie for cookie in COOKIES if cookie["name"] != "deleted"] + [{
            "name": "XSRF-TOKEN", "value": "cookie%3Atoken", "domain": "flow.google.com",
            "hostOnly": True, "path": "/", "httpOnly": False,
        }]
        transport = _Transport([
            upload_response(BOOTSTRAP, cookies),
            upload_response("", cookies, {"X-Goog-Upload-URL": "https://flow.google.com/upload/session/synthetic"}),
            upload_response(json.dumps({"media": {"name": f"media/{VIDEO}"}}), cookies),
        ])
        self.assertEqual(await self.upload(transport), VIDEO)
        bootstrap, start, final = transport.requests
        self.assertEqual(start["url"], f"https://flow.google.com/upload/v1/flow/upload/video/{PROJECT}")
        self.assertEqual(start["data"], b"")
        self.assertEqual(start["headers"]["X-Goog-Upload-Protocol"], "resumable")
        self.assertEqual(start["headers"]["X-Goog-Upload-Header-Content-Length"], str(len(VIDEO_BYTES)))
        self.assertEqual(start["headers"]["X-Framework-Xsrf-Token"], "cookie:token")
        self.assertEqual(final["data"], VIDEO_BYTES)
        self.assertEqual(final["headers"]["X-Goog-Upload-Command"], "upload, finalize")
        self.assertEqual(final["headers"]["X-Goog-Upload-Offset"], "0")
        self.assertNotIn("BOOTSTRAP", str(start["headers"]))
        self.assertEqual(len({request["cookie_jar_id"] for request in transport.requests}), 1)
        for request in transport.requests:
            self.assertNotIn("Cookie", request["headers"])
            self.assertNotIn("accounts-only", request["cookies"])
            self.assertNotIn("SID=path", request["cookies"])
            self.assertEqual(request["proxy"], "http://proxy.invalid:8080")
            self.assertEqual(request["impersonate"], "safari")
            self.assertEqual(request["headers"]["User-Agent"], bootstrap["headers"]["User-Agent"])
        self.assertFalse(start["allow_redirects"])
        self.assertFalse(final["allow_redirects"])
        self.client._get_recaptcha_token.assert_not_awaited()

    async def test_upload_rejects_cross_origin_continuation_before_sending_bytes(self):
        transport = _Transport([
            upload_response(BOOTSTRAP, COOKIES),
            upload_response("", COOKIES, {"X-Goog-Upload-URL": "https://flow.google.com.evil.invalid/upload/session"}),
        ])
        with self.assertRaisesRegex(RuntimeError, "unsupported upload URL"):
            await self.upload(transport)
        self.assertEqual(len(transport.requests), 2)

    async def test_persistent_session_does_not_resurrect_cookie_deleted_by_start(self):
        rotated = [
            {**cookie, "value": "rotated"} if cookie["name"] == "OSID" else cookie
            for cookie in COOKIES if cookie["name"] != "deleted"
        ]
        transport = _Transport([
            upload_response(BOOTSTRAP, COOKIES),
            upload_response("", rotated, {"X-Goog-Upload-URL": "/upload/session/synthetic"}),
            upload_response(json.dumps({"mediaId": VIDEO}), rotated),
        ])
        original_session = transport.session
        sent_cookies = []

        def copying_session(**kwargs):
            session = original_session(**kwargs)
            # Match curl_cffi BaseSession: constructor copies supplied Cookies.
            session.cookies = Cookies(kwargs["cookies"])
            original_post = session.post

            async def post(url, **request):
                sent_cookies.append(serialize_cookie_header_for_url(
                    _export_cookie_jar(Cookies(session.cookies).jar, ""), url,
                ))
                return await original_post(url, **request)

            session.post = post
            return session

        transport.session = copying_session
        self.assertEqual(await self.upload(transport), VIDEO)
        self.assertIn("deleted=old", sent_cookies[0])
        self.assertNotIn("deleted=", sent_cookies[1])
        self.assertIn("OSID=rotated", sent_cookies[1])
        self.assertNotIn("OSID=old", sent_cookies[1])

    async def test_upload_auth_error_does_not_retry(self):
        transport = _Transport([
            upload_response(BOOTSTRAP, COOKIES),
            upload_response("", COOKIES, status=401),
        ])
        with self.assertRaises(FlowFrontendAuthError):
            await self.upload(transport)
        self.assertEqual(len(transport.requests), 2)

    async def test_upload_persists_rotations_with_compare_and_swap(self):
        self.client.db = types.SimpleNamespace(
            get_token=AsyncMock(return_value=types.SimpleNamespace(email="user@example.com")),
            update_token_if_cookie_matches=AsyncMock(return_value=False),
        )

        async def uploaded(**kwargs):
            self.assertEqual(kwargs["session_context"]["expected_email"], "user@example.com")
            kwargs["session_context"]["google_cookies"] = "rotated"
            return VIDEO

        self.client._upload_flow_frontend_video = AsyncMock(side_effect=uploaded)
        self.assertEqual(await self.client.upload_video(
            at="frontend-cookie", video_bytes=VIDEO_BYTES, filename="clip.mp4",
            mime_type="video/mp4", project_id=PROJECT, token_id=1,
            google_cookies="SID=old",
        ), VIDEO)
        self.client.db.update_token_if_cookie_matches.assert_awaited_once_with(
            1, "SID=old", google_cookies="rotated",
        )

    async def test_edit_rpc_uses_source_frames_and_five_images(self):
        rpc, argument = self.client._build_frontend_video_generation_argument(
            project_id=PROJECT, prompt="Keep motion, change clothes", model_key="abra_edit",
            aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE", recaptcha_token="captcha",
            session_id="session", mode="edit", video_media_id=VIDEO,
            start_frame=0, end_frame=240, reference_media_ids=[IMAGE] * 5,
        )
        request = argument[0][0]
        self.assertEqual(rpc, "jIps6")
        self.assertEqual(request[0], [None, VIDEO, 0, 240])
        self.assertEqual(request[1], [None, None, [[["Keep motion, change clothes"]]]])
        self.assertEqual(request[2:4], ["abra_edit", 2])
        self.assertEqual(request[4][4], "session")
        self.assertEqual(request[8], [[None, IMAGE]] * 5)
        self.assertEqual(argument[1][5], PROJECT)

    async def test_edit_rejects_overflow_and_does_not_retry_unknown_submission(self):
        self.client._frontend_cookie = AsyncMock()
        self.client._get_recaptcha_token = AsyncMock(return_value=("captcha", None))
        self.client._notify_browser_captcha_request_finished = AsyncMock()
        self.client._current_rpc = AsyncMock(side_effect=TimeoutError("submission unknown"))
        self.client._get_runtime_config = lambda: types.SimpleNamespace(flow_max_retries=3)
        params = dict(
            at="frontend-cookie", project_id=PROJECT, prompt="Use source motion",
            model_key="abra_edit", aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
            source_video_id=VIDEO, end_frame=300,
        )
        with self.assertRaises(ValueError):
            await self.client.generate_video_edit(**{**params, "end_frame": 301})
        with self.assertRaises(ValueError):
            await self.client.generate_video_edit(**params, reference_media_ids=[IMAGE] * 6)
        self.client._current_rpc.assert_not_awaited()
        with self.assertRaisesRegex(TimeoutError, "submission unknown"):
            await self.client.generate_video_edit(**params)
        self.client._current_rpc.assert_awaited_once()
        self.client._get_recaptcha_token.assert_awaited_once()

    def test_native_resolution_uses_message_for_generation_and_enum_for_upsample(self):
        params = dict(
            project_id=PROJECT, prompt="Test", model_key="abra_edit_360p",
            aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE", recaptcha_token="captcha",
            session_id="session", video_media_id=VIDEO, end_frame=120,
        )
        self.assertEqual(self.client._frontend_video_resolution("VIDEO_RESOLUTION_4K"), 3)
        for mode, slot in (("text", 7), ("references", 11), ("start", 9), ("edit", 12)):
            with self.subTest(mode=mode):
                _, argument = self.client._build_frontend_video_generation_argument(
                    **params, mode=mode, resolution="360p",
                )
                self.assertEqual(argument[0][0][slot], [4])
        _, argument = self.client._build_frontend_video_generation_argument(
            **params, mode="upsample", resolution="1080p",
        )
        self.assertEqual(argument[0][0][6], 2)


if __name__ == "__main__":
    unittest.main()
