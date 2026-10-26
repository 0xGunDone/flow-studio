import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from src.services.generation_handler import GenerationHandler, MODEL_CONFIG


class VideoEditHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_edit_uploads_original_video_and_ordered_photos_once(self):
        handler = GenerationHandler.__new__(GenerationHandler)
        token = SimpleNamespace(id=7, email="test@example.com", login_account="test@example.com", at="at", user_paygate_tier="PAYGATE_TIER_ONE", google_cookies="session", video_concurrency=1)
        handler.db = SimpleNamespace(get_token=AsyncMock(return_value=token), create_task=AsyncMock())
        handler.flow_client = MagicMock()
        handler.flow_client.upload_video = AsyncMock(return_value="video-source")
        handler.flow_client.upload_image = AsyncMock(side_effect=["photo-first", "photo-second"])
        handler.flow_client.generate_video_edit = AsyncMock(return_value={"operations": [{"operation": {"name": "operation"}}]})
        handler.flow_client.generate_video_text = AsyncMock()
        handler._update_request_log_progress = AsyncMock()
        async def poll(*args, **kwargs):
            yield json.dumps({"success": True})
        handler._poll_video_result = poll
        reference = {"bytes": b"native-video", "filename": "source.mp4", "mime_type": "video/mp4", "end_frame": 90}
        output = [chunk async for chunk in handler._handle_video_generation(
            token, "project", MODEL_CONFIG["omni-1.1-flash-edit-landscape"],
            "preserve motion", [b"first", b"second"], False,
            video_references=[reference],
        )]
        self.assertEqual(json.loads(output[-1]), {"success": True})
        handler.flow_client.upload_video.assert_awaited_once_with(
            "at", b"native-video", "source.mp4", "video/mp4", project_id="project", token_id=7, google_cookies="session",
        )
        self.assertEqual([call.args[1] for call in handler.flow_client.upload_image.await_args_list], [b"first", b"second"])
        call = handler.flow_client.generate_video_edit.await_args
        self.assertEqual(call.args, ("at", "project", "preserve motion", "abra_edit", "VIDEO_ASPECT_RATIO_LANDSCAPE", "video-source"))
        self.assertEqual(call.kwargs["reference_media_ids"], ["photo-first", "photo-second"])
        self.assertEqual((call.kwargs["start_frame"], call.kwargs["end_frame"]), (0, 90))
        self.assertEqual(handler.flow_client.generate_video_edit.await_count, 1)
        handler.flow_client.generate_video_text.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
