import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from src.services import video_inputs
from src.core.account_tiers import supports_model_for_tier

FILE_ID = "11111111-1111-1111-1111-111111111111.mp4"


class VideoInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / FILE_ID).write_bytes(b"original-video")
        self.reference = {"file_id": FILE_ID, "mime_type": "video/mp4", "filename": "clip.mp4"}
        self.process = AsyncMock()
        self.process.returncode = 0
        self.process.communicate.return_value = (json.dumps({"format": {"duration": "3"}, "streams": [{"codec_type": "video"}]}).encode(), b"")
        self.folder = patch.object(video_inputs, "INPUT_DIR", self.root)
        self.factory = patch.object(video_inputs.asyncio, "create_subprocess_exec", AsyncMock(return_value=self.process))
        self.folder.start()
        self.spawn = self.factory.start()
        self.addCleanup(self.folder.stop)
        self.addCleanup(self.factory.stop)

    async def test_native_video_bytes_frame_range_and_local_probe(self):
        result = await video_inputs.read_video_reference(self.reference)
        self.assertEqual(result["bytes"], b"original-video")
        self.assertEqual(result["end_frame"], 90)
        self.assertIn("file,pipe", self.spawn.call_args.args)
        self.assertIn("pass_fds", self.spawn.call_args.kwargs)

    async def test_oversized_duration_or_nonvideo_rejected_before_upload(self):
        for data in ({"format": {"duration": "11"}, "streams": [{"codec_type": "video"}]}, {"format": {"duration": "3"}, "streams": [{"codec_type": "audio"}]}):
            self.process.communicate.return_value = (json.dumps(data).encode(), b"")
            with self.assertRaisesRegex(ValueError, "10 секунд"):
                await video_inputs.read_video_reference(self.reference)

    async def test_path_traversal_remote_file_and_symlink_never_read(self):
        for identifier in ("../../secret.mp4", "https://example.com/private.mp4", "/etc/passwd"):
            with self.assertRaises(ValueError):
                await video_inputs.read_video_reference({**self.reference, "file_id": identifier})
        (self.root / FILE_ID).unlink()
        (self.root / FILE_ID).symlink_to(self.root / "not-a-video")
        with self.assertRaises(OSError):
            await video_inputs.read_video_reference(self.reference)
        self.spawn.assert_not_awaited()

    def test_short_veo_requires_ultra_while_eight_seconds_remains_available(self):
        for duration in (4, 6):
            self.assertFalse(supports_model_for_tier(f"veo-3.1-fast-i2v-{duration}s-landscape", "PAYGATE_TIER_ONE"))
            self.assertTrue(supports_model_for_tier(f"veo-3.1-fast-i2v-{duration}s-landscape", "PAYGATE_TIER_TWO"))
        self.assertTrue(supports_model_for_tier("veo-3.1-fast-i2v-8s-landscape", "PAYGATE_TIER_ONE"))


if __name__ == "__main__":
    unittest.main()
