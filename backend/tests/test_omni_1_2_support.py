"""Offline routing contract from FlowService.GetModels captured 2026-11-07."""
import json
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.core.account_tiers import supports_model_for_tier
from src.services.flow_client import FlowClient
from src.services.generation_handler import GenerationHandler, MODEL_CONFIG
from src.services import video_inputs

CATALOG = json.loads((Path(__file__).parent / "fixtures" / "omni-1.2-flow-models.json").read_text())
USAGES = {usage["key"]: usage for usage in CATALOG["usages"]}
VIDEO = "11234567-89ab-cdef-0123-456789abcdef"
IMAGE = "21234567-89ab-cdef-0123-456789abcdef"


class Omni12CatalogTests(unittest.TestCase):
    def test_every_published_omni12_routes_to_captured_usage(self):
        models = {name: config for name, config in MODEL_CONFIG.items() if name.startswith("omni-1.2-flash")}
        self.assertEqual(len(models), 109)
        for name, config in models.items():
            with self.subTest(model=name):
                self.assertTrue(config["listed"])
                for field in ("model_key", "reference_model_key", "start_model_key"):
                    if field in config:
                        self.assertIn(config[field], USAGES)
                usage = USAGES[config["model_key"]]
                expected_resolution = 4 if name.endswith("-360p") else 1
                self.assertEqual(usage["resolutions"][0], [expected_resolution])
                if expected_resolution == 4:
                    self.assertEqual(config["resolution"], "360p")
                self.assertEqual(usage["aspects"], [[2, 1]])
                self.assertFalse(config["allow_tier_upgrade"])
        self.assertEqual(MODEL_CONFIG["omni-1.1-flash"]["model_key"], "abra_t2v_8s")
        self.assertEqual(MODEL_CONFIG["omni"]["model_key"], "abra_t2v_8s")
        self.assertEqual(MODEL_CONFIG["omni-1.2-flash"]["model_key"], "macaron_cookie_t2v_8s")

    def test_frames_keep_start_end_roles_and_long_frames_start_only(self):
        for suffix, provider_suffix in (("", ""), ("-360p", "_360p")):
            for seconds in range(3, 16):
                config = MODEL_CONFIG[f"omni-1.2-flash-i2v-{seconds}s-portrait{suffix}"]
                self.assertEqual((config["video_type"], config["min_images"], config["max_images"]), ("i2v", 1, 2 if seconds <= 10 else 1))
                self.assertEqual(config["model_key"], f"macaron_cookie_i2v{'_fl' if seconds <= 10 else ''}_{seconds}s{provider_suffix}")
                if seconds <= 10:
                    self.assertEqual(config["start_model_key"], f"macaron_cookie_i2v_{seconds}s{provider_suffix}")
                normal = MODEL_CONFIG[f"omni-1.2-flash-{seconds}s-portrait{suffix}"]
                self.assertEqual(normal["reference_model_key"], f"macaron_cookie_r2v_{seconds}s{provider_suffix}")
                self.assertEqual(normal["max_images"], 7)
        for orientation in ("landscape", "portrait"):
            self.assertEqual(MODEL_CONFIG[f"omni-1.2-flash-edit-{orientation}"]["max_input_duration"], 15)
            self.assertEqual(MODEL_CONFIG[f"omni-1.1-flash-edit-{orientation}"]["max_input_duration"], 10)

    def test_long_omni_requires_pro_without_upgrading_legacy_requests(self):
        for model in ("omni-1.2-flash-11s-landscape", "omni-1.2-flash-i2v-15s-portrait-360p", "macaron_cookie_r2v_15s_360p"):
            self.assertFalse(supports_model_for_tier(model, "PAYGATE_TIER_NOT_PAID"))
            self.assertTrue(supports_model_for_tier(model, "PAYGATE_TIER_ONE"))
            self.assertTrue(supports_model_for_tier(model, "PAYGATE_TIER_TWO"))
        self.assertTrue(supports_model_for_tier("omni-1.2-flash-10s-landscape", "PAYGATE_TIER_NOT_PAID"))
        self.assertTrue(supports_model_for_tier("omni-1.1-flash-10s-landscape", "PAYGATE_TIER_NOT_PAID"))


class Omni12SubmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_handler_keeps_selected_usage_resolution_and_frame_roles(self):
        cases = (
            ("omni-1.2-flash-15s-portrait-360p", [], None, "generate_video_text", "macaron_cookie_t2v_15s_360p"),
            ("omni-1.2-flash-3s-portrait-360p", [b"first"], None, "generate_video_reference_images", "macaron_cookie_r2v_3s_360p"),
            ("omni-1.2-flash-i2v-3s-portrait-360p", [b"first"], None, "generate_video_start_image", "macaron_cookie_i2v_3s_360p"),
            ("omni-1.2-flash-i2v-3s-portrait-360p", [b"first", b"last"], None, "generate_video_start_end", "macaron_cookie_i2v_fl_3s_360p"),
            ("omni-1.2-flash-edit-portrait-360p", [b"first"], {"bytes": b"video", "filename": "source.mp4", "mime_type": "video/mp4", "end_frame": 450}, "generate_video_edit", "macaron_cookie_edit_360p"),
        )
        for model, images, video, method, key in cases:
            with self.subTest(model=model, method=method):
                handler = GenerationHandler.__new__(GenerationHandler)
                token = SimpleNamespace(id=7, email="offline@example.com", login_account="offline@example.com", at="unused", user_paygate_tier="PAYGATE_TIER_ONE", google_cookies="unused", video_concurrency=1)
                handler.db = SimpleNamespace(get_token=AsyncMock(return_value=token), create_task=AsyncMock())
                async def submit(*args, **kwargs):
                    submitted_key = args[3] if args else kwargs["model_key"]
                    self.assertEqual(submitted_key, key)
                    self.assertEqual(kwargs["resolution"], "360p")
                    if method == "generate_video_start_image":
                        self.assertEqual(kwargs["start_media_id"], IMAGE)
                    if method == "generate_video_start_end":
                        self.assertEqual((kwargs["start_media_id"], kwargs["end_media_id"]), (IMAGE, VIDEO))
                    if method == "generate_video_edit":
                        self.assertEqual(kwargs["end_frame"], 450)
                    return {"operations": [{"operation": {"name": "offline"}}]}
                handler.flow_client = SimpleNamespace(upload_video=AsyncMock(return_value=VIDEO), upload_image=AsyncMock(side_effect=[IMAGE, VIDEO]), **{method: submit})
                handler._update_request_log_progress = AsyncMock()
                async def poll(*args, **kwargs):
                    yield json.dumps({"success": True})
                handler._poll_video_result = poll
                output = [chunk async for chunk in handler._handle_video_generation(
                    token, VIDEO, MODEL_CONFIG[model], "Keep movement", images, False,
                    video_references=[video] if video else None,
                )]
                self.assertEqual(json.loads(output[-1]), {"success": True})

    async def test_360p_reaches_existing_rpc_for_each_supported_input_method(self):
        client = FlowClient(None)
        submitted = []
        async def submit(**kwargs):
            rpc, argument = client._build_frontend_video_generation_argument(
                **{key: value for key, value in kwargs.items() if key in {
                    "project_id", "prompt", "model_key", "aspect_ratio", "mode", "reference_media_ids",
                    "start_media_id", "end_media_id", "video_media_id", "start_frame", "end_frame", "resolution",
                }}, recaptcha_token="unused", session_id="offline",
            )
            submitted.append((rpc, argument[0][0]))
            return {"operations": []}
        client._current_generate_video = submit
        common = dict(at="unused", project_id=VIDEO, prompt="Keep movement", aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT", resolution="360p")
        await client.generate_video_text(**common, model_key="macaron_cookie_t2v_15s_360p")
        await client.generate_video_reference_images(**common, model_key="macaron_cookie_r2v_3s_360p", reference_images=[{"mediaId": IMAGE}])
        await client.generate_video_start_image(**common, model_key="macaron_cookie_i2v_15s_360p", start_media_id=IMAGE)
        await client.generate_video_start_end(**common, model_key="macaron_cookie_i2v_fl_3s_360p", start_media_id=IMAGE, end_media_id=VIDEO)
        await client.generate_video_edit(**common, model_key="macaron_cookie_edit_360p", source_video_id=VIDEO, end_frame=450, reference_media_ids=[IMAGE] * 5)
        self.assertEqual([rpc for rpc, _ in submitted], ["YhhmEf", "MZZa6b", "eb1hJf", "nprQif", "jIps6"])
        for (_, request), slot in zip((submitted[0], submitted[1], submitted[2], submitted[4]), (7, 11, 9, 12)):
            self.assertEqual(request[slot], [4])
        self.assertEqual(submitted[3][1][1], "macaron_cookie_i2v_fl_3s_360p")
        self.assertEqual(submitted[4][1][0], [None, VIDEO, 0, 450])
        with self.assertRaises(ValueError):
            await client.generate_video_edit(**common, model_key="macaron_cookie_edit_360p", source_video_id=VIDEO, end_frame=451)
        with self.assertRaises(ValueError):
            await client.generate_video_edit(**common, model_key="abra_edit", source_video_id=VIDEO, end_frame=301)

    async def test_video_probe_uses_selected_edit_duration_limit(self):
        identifier = "11111111-1111-1111-1111-111111111111.mp4"
        reference = {"file_id": identifier, "mime_type": "video/mp4"}
        process = AsyncMock(returncode=0)
        process.communicate.return_value = (json.dumps({"format": {"duration": "15"}, "streams": [{"codec_type": "video"}]}).encode(), b"")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / identifier).write_bytes(b"original")
            with patch.object(video_inputs, "INPUT_DIR", root), patch.object(video_inputs.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
                with self.assertRaisesRegex(ValueError, "10 секунд"):
                    await video_inputs.read_video_reference(reference)
                result = await video_inputs.read_video_reference(reference, max_duration_seconds=15)
                self.assertEqual((result["bytes"], result["end_frame"]), (b"original", 450))
                process.communicate.return_value = (json.dumps({"format": {"duration": "16"}, "streams": [{"codec_type": "video"}]}).encode(), b"")
                with self.assertRaisesRegex(ValueError, "15 секунд"):
                    await video_inputs.read_video_reference(reference, max_duration_seconds=15)


if __name__ == "__main__":
    unittest.main()
