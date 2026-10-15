import unittest

from src.core.config import get_yescaptcha_min_score, normalize_yescaptcha_task_type


class YesCaptchaTaskTypeTests(unittest.TestCase):
    def test_supported_task_types_are_preserved(self):
        self.assertEqual(
            normalize_yescaptcha_task_type("RecaptchaV3TaskProxyless"),
            "RecaptchaV3TaskProxyless",
        )
        self.assertEqual(
            normalize_yescaptcha_task_type("RecaptchaV3TaskProxylessM1S9"),
            "RecaptchaV3TaskProxylessM1S9",
        )

    def test_unknown_task_type_falls_back_to_default(self):
        self.assertEqual(
            normalize_yescaptcha_task_type("bad-type"),
            "RecaptchaV3TaskProxylessM1S9",
        )

    def test_s7_s9_force_expected_min_score(self):
        self.assertEqual(get_yescaptcha_min_score("RecaptchaV3TaskProxylessM1S7"), 0.7)
        self.assertEqual(get_yescaptcha_min_score("RecaptchaV3TaskProxylessM1S9"), 0.9)
        self.assertIsNone(get_yescaptcha_min_score("RecaptchaV3TaskProxylessM1"))


if __name__ == "__main__":
    unittest.main()
