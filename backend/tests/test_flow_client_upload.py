import unittest
from unittest.mock import AsyncMock

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
