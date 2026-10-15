"""Verify API-mode captcha injects solution user_agent into the request fingerprint.

背景: YesCaptcha / CapMonster / EzCaptcha / CapSolver 返回的 solution 包含
gRecaptchaResponse 与 userAgent。Google reCAPTCHA V3 评估会校验 token 与
提交请求的 User-Agent 一致性, 因此调用 Flow API 时必须沿用打码服务返回的
UA, 否则服务端判定 UNUSUAL_ACTIVITY 并返回 reCAPTCHA evaluation failed。
"""

import unittest
from unittest.mock import patch, AsyncMock, MagicMock

from src.services.flow_client import FlowClient


class _FakeProxyManager:
    async def get_request_proxy_url(self):
        return None


class _FakeAsyncSession:
    """模拟 curl_cffi 的 AsyncSession: createTask 返回 taskId, getTaskResult 返回 ready。"""

    def __init__(self):
        self._calls = 0
        self.requests = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        self._calls += 1
        self.requests.append((args, kwargs))
        response = MagicMock()
        if self._calls == 1:
            # createTask
            response.status_code = 200
            response.json.return_value = {
                "errorId": 0,
                "taskId": "tid-xyz",
            }
        else:
            # getTaskResult
            response.status_code = 200
            response.json.return_value = {
                "errorId": 0,
                "status": "ready",
                "solution": {
                    "gRecaptchaResponse": "token-abc",
                    "userAgent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/147.0.0.0 Safari/537.36"
                    ),
                },
            }
        return response


class _FakeCaptchaRunSession:
    def __init__(self):
        self.requests = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, **kwargs):
        self.requests.append(("POST", url, kwargs))
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {"taskId": "run-task-1"}
        return response

    async def get(self, url, **kwargs):
        self.requests.append(("GET", url, kwargs))
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "status": "Success",
            "response": {"gRecaptchaResponse": "run-token-1"},
        }
        return response


class ApiCaptchaFingerprintTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_captcha_returns_token_and_user_agent(self):
        """_get_api_captcha_token 必须返回 (token, userAgent) 元组。"""
        flow = FlowClient.__new__(FlowClient)
        flow.proxy_manager = _FakeProxyManager()
        fake_session = _FakeAsyncSession()

        with (
            patch(
                "src.services.flow_client.AsyncSession", lambda *a, **kw: fake_session
            ),
            patch("src.services.flow_client.config") as cfg,
            patch("asyncio.sleep", new=AsyncMock()),
        ):
            cfg.yescaptcha_api_key = "key"
            cfg.yescaptcha_base_url = "https://api.yescaptcha.com"
            cfg.yescaptcha_task_type = "RecaptchaV3TaskProxylessM1"
            cfg.debug_enabled = False

            result = await flow._get_api_captcha_token(
                method="yescaptcha",
                project_id="proj-1",
                action="IMAGE_GENERATION",
            )

        self.assertIsNotNone(result, "函数不应返回 None, 因为我们 mock 了 ready 状态")
        self.assertIsInstance(
            result, tuple, "_get_api_captcha_token 应返回 (token, userAgent) 元组"
        )
        token, user_agent = result
        self.assertEqual(token, "token-abc")
        self.assertIn(
            "Windows", user_agent, "userAgent 应当来自打码服务 solution, 包含 Windows"
        )
        self.assertIn("Chrome/147", user_agent)
        self.assertEqual(fake_session.requests[0][1]["json"]["softID"], "33424")

    async def test_captcharun_uses_v2_task_api(self):
        flow = FlowClient.__new__(FlowClient)
        flow.proxy_manager = _FakeProxyManager()
        session = _FakeCaptchaRunSession()

        with (
            patch("src.services.flow_client.AsyncSession", lambda *a, **kw: session),
            patch("src.services.flow_client.config") as cfg,
            patch("asyncio.sleep", new=AsyncMock()),
        ):
            cfg.captcharun_api_key = "key"
            cfg.captcharun_base_url = "https://api.captcha-run.com"
            result = await flow._get_api_captcha_token(
                method="captcharun",
                project_id="project-1",
                action="IMAGE_GENERATION",
                website_url="https://flow.google.com/project/project-1",
                user_agent="agent-1",
            )

        self.assertEqual(result, ("run-token-1", "agent-1"))
        self.assertEqual(session.requests[0][0:2], (
            "POST",
            "https://api.captcha-run.com/v2/tasks",
        ))
        self.assertEqual(
            session.requests[0][2]["json"],
            {
                "captchaType": "ReCaptchaV3",
                "siteKey": "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV",
                "siteReferer": "https://flow.google.com/project/project-1",
                "siteAction": "IMAGE_GENERATION",
            },
        )
        self.assertEqual(
            session.requests[0][2]["headers"]["Authorization"],
            "Bearer key",
        )


if __name__ == "__main__":
    unittest.main()
