import unittest

from src.services.flow_client import FlowClient


PROJECT_ID = "01234567-89ab-cdef-0123-456789abcdef"
MEDIA_ID = "11234567-89ab-cdef-0123-456789abcdef"


class FlowClientImageGenerationArgumentTests(unittest.TestCase):
    def setUp(self):
        self.client = FlowClient(proxy_manager=None)

    def test_reference_images_use_media_envelope(self):
        argument = self.client._build_frontend_image_generation_argument(
            project_id=PROJECT_ID,
            prompt="换成针织开衫",
            model_name="BELUGA",
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            recaptcha_token="recaptcha-token",
            session_id="session-id",
            image_inputs=[{"name": MEDIA_ID}],
        )

        request = argument[1][0]
        # the reference slot is a 5-field envelope, not [1, mediaId]
        self.assertEqual(request[2], [[MEDIA_ID, None, None, None, 1]])
        # slot 9 stays null; a serialized settings blob here is rejected
        self.assertIsNone(request[9])
        self.assertEqual(request[8], [[["换成针织开衫"]]])

    def test_text_only_generation_omits_reference_slot(self):
        argument = self.client._build_frontend_image_generation_argument(
            project_id=PROJECT_ID,
            prompt="一只红苹果",
            model_name="BELUGA",
            aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
            recaptcha_token="recaptcha-token",
            session_id="session-id",
        )

        request = argument[1][0]
        self.assertIsNone(request[2])
        self.assertIsNone(request[9])

    def test_reference_layout_applies_only_to_valid_reference_ids(self):
        cases = (
            (None, []),
            ([], []),
            ([{}, {"name": " "}], []),
            ([{"name": MEDIA_ID}], [MEDIA_ID]),
            ([{"mediaId": MEDIA_ID}, {"name": PROJECT_ID}], [MEDIA_ID, PROJECT_ID]),
        )
        for model_name in ("BELUGA", "HARBOR_SEAL", "GEM_PIX_2"):
            for image_inputs, reference_ids in cases:
                with self.subTest(model=model_name, image_inputs=image_inputs):
                    argument = self.client._build_frontend_image_generation_argument(
                        project_id=PROJECT_ID,
                        prompt="an apple",
                        model_name=model_name,
                        aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
                        recaptcha_token="recaptcha-token",
                        session_id="session-id",
                        image_inputs=image_inputs,
                    )
                    request = argument[1][0]
                    self.assertEqual(len(request), 15 if reference_ids else 14)
                    self.assertEqual(request[14:], [4] if reference_ids else [])
                    self.assertEqual(
                        request[2],
                        [[media_id, None, None, None, 1] for media_id in reference_ids] or None,
                    )
                    self.assertEqual(request[5], model_name)
                    self.assertEqual(request[9:12], [None, None, None])
                    self.assertEqual(request[12], "session-id")
                    self.assertRegex(request[13], r"^[0-9A-F-]{36}$")
                    self.assertEqual(argument[4], ["session-id"])


if __name__ == "__main__":
    unittest.main()
