import unittest
from unittest.mock import AsyncMock, MagicMock

from src.services.generation_handler import GenerationHandler


MEDIA_NAME = "4a7b00b4-a60f-44d2-a5fa-c0a4883c5fcc"
GENERATION_ID = "a1607a19-a932-4c31-bb39-b5f6283f1eee"
VIDEO_URL = f"https://flow-content.google/video/{GENERATION_ID}"


def _operation():
    return {
        "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
        "projectId": "86955db9-5925-4e7b-b7ed-a3e9c5302c92",
        "mediaName": MEDIA_NAME,
        "name": GENERATION_ID,
        "operation": {
            "name": GENERATION_ID,
            "metadata": {
                "video": {
                    "mediaName": MEDIA_NAME,
                    "mediaGenerationId": GENERATION_ID,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                }
            },
        },
    }


class VideoAssetResolutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.handler = GenerationHandler.__new__(GenerationHandler)
        self.handler.flow_client = MagicMock()
        self.handler.flow_client.get_media_url_redirect = AsyncMock(return_value=VIDEO_URL)

    async def test_resolves_media_by_generation_id_not_media_name(self):
        """as29s 按生成操作 id 索引；传 mediaName 会返回 code=[5]。"""
        resolved = await self.handler._resolve_video_asset(MagicMock(), _operation())

        self.handler.flow_client.get_media_url_redirect.assert_awaited_once()
        _, passed_id = self.handler.flow_client.get_media_url_redirect.await_args.args
        self.assertEqual(passed_id, GENERATION_ID)
        self.assertNotEqual(passed_id, MEDIA_NAME)
        self.assertEqual(resolved["video_url"], VIDEO_URL)
        self.assertEqual(resolved["video_media_id"], GENERATION_ID)
        self.assertEqual(resolved["media_name"], MEDIA_NAME)

    async def test_reuses_signed_url_and_preserves_media_name(self):
        operation = _operation()
        operation["operation"]["metadata"]["video"]["fifeUrl"] = VIDEO_URL

        resolved = await self.handler._resolve_video_asset(MagicMock(), operation)

        self.handler.flow_client.get_media_url_redirect.assert_not_awaited()
        self.assertEqual(resolved["video_url"], VIDEO_URL)
        self.assertEqual(resolved["video_media_id"], GENERATION_ID)
        self.assertEqual(resolved["media_name"], MEDIA_NAME)

    async def test_falls_back_to_operation_name_when_metadata_missing(self):
        operation = _operation()
        operation["operation"]["metadata"] = {}
        operation.pop("name")

        resolved = await self.handler._resolve_video_asset(MagicMock(), operation)

        _, passed_id = self.handler.flow_client.get_media_url_redirect.await_args.args
        self.assertEqual(passed_id, GENERATION_ID)
        self.assertEqual(resolved["video_url"], VIDEO_URL)
        self.assertEqual(resolved["media_name"], MEDIA_NAME)


if __name__ == "__main__":
    unittest.main()
