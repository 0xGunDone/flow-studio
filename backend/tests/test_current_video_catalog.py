"""Contract from FlowService.GetModels on 2026-10-27; no generation requests."""

import unittest

from src.services.generation_handler import MODEL_CONFIG, GenerationHandler
from src.services.flow_current import CurrentFlowClientMixin


class CurrentVideoCatalogTests(unittest.TestCase):
    def test_subscription_uses_service_tier_instead_of_credit_balance(self):
        for payload, expected in (([1050, 1, 0, 1], "PAYGATE_TIER_NOT_PAID"), ([0, 1, 2, 2], "PAYGATE_TIER_ONE"), ([100, 1, 3, 3], "PAYGATE_TIER_TWO")):
            self.assertEqual(CurrentFlowClientMixin._frontend_paygate_tier(payload), expected)

    def test_short_fast_models_use_current_usage_keys(self):
        for seconds in (4, 6):
            for orientation in ("landscape", "portrait"):
                with self.subTest(seconds=seconds, orientation=orientation):
                    self.assertEqual(
                        MODEL_CONFIG[f"veo-3.1-fast-{seconds}s-{orientation}"]["model_key"],
                        f"veo_3_1_t2v_fast_{seconds}s",
                    )
                    self.assertEqual(
                        MODEL_CONFIG[f"veo-3.1-fast-i2v-{seconds}s-{orientation}"]["model_key"],
                        f"veo_3_1_i2v_s_fast_{seconds}s_fl",
                    )

    def test_eight_second_image_models_keep_frame_roles_and_aspect(self):
        for orientation, aspect, fast_key, quality_key in (
            ("landscape", "LANDSCAPE", "veo_3_1_i2v_s_fast_fl", "veo_3_1_i2v_s_fl"),
            ("portrait", "PORTRAIT", "veo_3_1_i2v_s_fast_portrait_fl", "veo_3_1_i2v_s_portrait_fl"),
        ):
            for family, key in (
                ("lite", "veo_3_1_interpolation_lite"),
                ("fast", fast_key),
                ("quality", quality_key),
            ):
                with self.subTest(family=family, orientation=orientation):
                    cfg = MODEL_CONFIG[f"veo-3.1-{family}-i2v-8s-{orientation}"]
                    self.assertEqual(cfg["model_key"], key)
                    self.assertEqual(cfg["aspect_ratio"], f"VIDEO_ASPECT_RATIO_{aspect}")
                    self.assertEqual((cfg["min_images"], cfg["max_images"]), (1, 2))
                    self.assertTrue(cfg["listed"])
                    if family == "lite":
                        self.assertEqual(cfg["start_model_key"], "veo_3_1_i2v_lite")

    def test_fast_eight_second_tier_selection_preserves_mode(self):
        handler = GenerationHandler.__new__(GenerationHandler)
        for suffix, standard, ultra in (
            ("8s-landscape", "veo_3_1_t2v_fast", "veo_3_1_t2v_fast_ultra"),
            ("8s-portrait", "veo_3_1_t2v_fast_portrait", "veo_3_1_t2v_fast_portrait_ultra"),
            ("i2v-8s-landscape", "veo_3_1_i2v_s_fast_fl", "veo_3_1_i2v_s_fast_ultra_fl"),
            ("i2v-8s-portrait", "veo_3_1_i2v_s_fast_portrait_fl", "veo_3_1_i2v_s_fast_portrait_ultra_fl"),
            ("r2v-8s-landscape", "veo_3_1_r2v_fast_landscape", "veo_3_1_r2v_fast_landscape_ultra"),
            ("r2v-8s-portrait", "veo_3_1_r2v_fast_portrait", "veo_3_1_r2v_fast_portrait_ultra"),
            ("extend-8s-landscape", "veo_3_1_extend_fast_landscape", "veo_3_1_extend_fast_landscape_ultra"),
            ("extend-8s-portrait", "veo_3_1_extend_fast_portrait", "veo_3_1_extend_fast_portrait_ultra"),
        ):
            cfg = MODEL_CONFIG[f"veo-3.1-fast-{suffix}"]
            for tier, expected in (("PAYGATE_TIER_ONE", standard), ("PAYGATE_TIER_TWO", ultra)):
                with self.subTest(model=suffix, tier=tier):
                    resolved, _ = handler._resolve_video_model_key_for_tier(cfg, tier)
                    self.assertEqual(resolved, expected)

    def test_omni_reference_and_edit_limits_follow_current_usages(self):
        for orientation in ("landscape", "portrait"):
            for seconds in (4, 6, 8, 10):
                cfg = MODEL_CONFIG[f"omni-1.1-flash-{seconds}s-{orientation}"]
                self.assertEqual(cfg["reference_model_key"], f"abra_r2v_{seconds}s")
                self.assertEqual(cfg["max_images"], 7)
            cfg = MODEL_CONFIG[f"omni-1.1-flash-edit-{orientation}"]
            self.assertEqual((cfg["video_type"], cfg["model_key"]), ("omni_edit", "abra_edit"))
            self.assertEqual((cfg["max_images"], cfg["max_videos"], cfg["max_input_duration"]), (5, 1, 10))
            self.assertTrue(cfg["listed"])


if __name__ == "__main__":
    unittest.main()
