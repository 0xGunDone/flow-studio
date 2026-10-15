import asyncio
import copy
import io
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
import httpx

from src.core.config import config
from src.core.database import Database
from src.services.flow_client import FlowClient
from src.services.generation_handler import GenerationHandler
from src.services.twocaptcha import TwoCaptchaError, solve_recaptcha_v3
from src.api import admin


class ProviderSession:
    def __init__(self, responses, statuses=None):
        self.responses = list(responses)
        self.statuses = statuses or [200] * len(self.responses)
        self.requests = []
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def post(self, url, **kwargs):
        self.requests.append((url, kwargs))
        index = len(self.requests) - 1
        return types.SimpleNamespace(
            status_code=self.statuses[index], json=lambda: self.responses[index]
        )


CREATED = {"errorId": 0, "taskId": 123}
READY = {
    "errorId": 0,
    "status": "ready",
    "solution": {"gRecaptchaResponse": "solved-token"},
}


class TwoCaptchaSolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_failure_does_not_count_as_account_fault(self):
        handler = GenerationHandler.__new__(GenerationHandler)
        self.assertFalse(
            handler._should_count_token_error(
                TwoCaptchaError("2Captcha: ERROR_ZERO_BALANCE")
            )
        )
        self.assertFalse(
            handler._should_count_token_error(RuntimeError("twocaptcha API 请求失败"))
        )

    async def test_enterprise_payload_and_five_second_polling(self):
        session = ProviderSession(
            [CREATED, {"errorId": 0, "status": "processing"}, READY]
        )
        with (
            patch(
                "src.services.twocaptcha.AsyncSession", return_value=session
            ) as factory,
            patch("src.services.twocaptcha.asyncio.sleep", AsyncMock()) as sleep,
        ):
            solution = await solve_recaptcha_v3(
                "fixture-key",
                "https://flow.google.com/project/project-1",
                "site-key",
                "CHAT_GENERATION",
                proxy_url="http://127.0.0.1:7890",
            )
        self.assertEqual(
            solution, {"gRecaptchaResponse": "solved-token", "userAgent": ""}
        )
        self.assertEqual(
            session.requests[0][1]["json"],
            {
                "clientKey": "fixture-key",
                "task": {
                    "type": "RecaptchaV3TaskProxyless",
                    "websiteURL": "https://flow.google.com/project/project-1",
                    "websiteKey": "site-key",
                    "minScore": 0.9,
                    "pageAction": "CHAT_GENERATION",
                    "isEnterprise": True,
                },
            },
        )
        self.assertEqual(
            session.requests[1][1]["json"], {"clientKey": "fixture-key", "taskId": 123}
        )
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [5, 5])
        self.assertFalse(factory.call_args.kwargs["trust_env"])
        self.assertEqual(factory.call_args.kwargs["proxy"], "http://127.0.0.1:7890")
        self.assertTrue(session.closed)

    async def test_token_alias_and_returned_user_agent(self):
        session = ProviderSession(
            [
                CREATED,
                {
                    "errorId": 0,
                    "status": "ready",
                    "solution": {"token": "alias-token", "userAgent": "solver-agent"},
                },
            ]
        )
        with (
            patch("src.services.twocaptcha.AsyncSession", return_value=session),
            patch("src.services.twocaptcha.asyncio.sleep", AsyncMock()),
        ):
            solution = await solve_recaptcha_v3(
                "fixture-key", "https://example.com", "key", "test", enterprise=False
            )
        self.assertEqual(
            solution, {"gRecaptchaResponse": "alias-token", "userAgent": "solver-agent"}
        )
        self.assertFalse(session.requests[0][1]["json"]["task"]["isEnterprise"])

    async def test_provider_error_stops_polling_without_exposing_key(self):
        error = {
            "errorId": 1,
            "errorCode": "ERROR_CAPTCHA_UNSOLVABLE",
            "errorDescription": "fixture-key failed",
        }
        session = ProviderSession([CREATED, error])
        with (
            patch("src.services.twocaptcha.AsyncSession", return_value=session),
            patch("src.services.twocaptcha.asyncio.sleep", AsyncMock()),
        ):
            with self.assertRaises(TwoCaptchaError) as caught:
                await solve_recaptcha_v3(
                    "fixture-key", "https://example.com", "key", "test"
                )
        self.assertIn("ERROR_CAPTCHA_UNSOLVABLE", str(caught.exception))
        self.assertNotIn("fixture-key", str(caught.exception))
        self.assertEqual(len(session.requests), 2)
        self.assertTrue(session.closed)

    async def test_http_and_malformed_payloads_are_terminal(self):
        for payload, status in (
            ({"errorDescription": "fixture-key"}, 403),
            (["fixture-key"], 200),
            ({"errorId": 0}, 200),
        ):
            session = ProviderSession([payload], [status])
            with (
                self.subTest(status=status, payload_type=type(payload).__name__),
                patch("src.services.twocaptcha.AsyncSession", return_value=session),
            ):
                with self.assertRaises(TwoCaptchaError) as caught:
                    await solve_recaptcha_v3(
                        "fixture-key", "https://example.com", "key", "test"
                    )
                self.assertNotIn("fixture-key", str(caught.exception))
                self.assertTrue(session.closed)

    async def test_deadline_and_cancellation_release_session(self):
        for cancel in (False, True):
            session = ProviderSession([CREATED])
            entered = asyncio.Event()

            async def post(url, **kwargs):
                if url.endswith("/createTask"):
                    return types.SimpleNamespace(status_code=200, json=lambda: CREATED)
                entered.set()
                await asyncio.Event().wait()

            session.post = post
            with (
                self.subTest(cancel=cancel),
                patch("src.services.twocaptcha.AsyncSession", return_value=session),
                patch("src.services.twocaptcha.asyncio.sleep", AsyncMock()),
            ):
                task = asyncio.create_task(
                    solve_recaptcha_v3(
                        "fixture-key",
                        "https://example.com",
                        "key",
                        "test",
                        timeout=0.05 if not cancel else 5,
                    )
                )
                await entered.wait()
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertRaisesRegex(TwoCaptchaError, "超时"):
                        await task
                self.assertTrue(session.closed)

    async def test_flow_route_uses_twocaptcha_without_optional_task_fields(self):
        flow = FlowClient(proxy_manager=None)
        session = ProviderSession([CREATED, READY])
        with (
            patch("src.services.flow_client.config") as cfg,
            patch("src.services.twocaptcha.AsyncSession", return_value=session),
            patch("src.services.twocaptcha.asyncio.sleep", AsyncMock()),
        ):
            cfg.twocaptcha_api_key = "fixture-key"
            cfg.twocaptcha_base_url = "https://api.2captcha.com"
            result = await flow._get_api_captcha_token(
                "twocaptcha", "project-1", "VIDEO_GENERATION", user_agent="caller-agent"
            )
        self.assertEqual(result, ("solved-token", ""))
        task = session.requests[0][1]["json"]["task"]
        self.assertEqual(task["pageAction"], "VIDEO_GENERATION")
        self.assertEqual(
            task["websiteURL"], "https://flow.google.com/project/project-1"
        )
        self.assertNotIn("userAgent", task)
        self.assertNotIn("proxy", task)

    async def test_generation_dispatch_uses_selected_provider_and_request_proxy(self):
        flow = FlowClient(proxy_manager=None)
        flow._set_request_fingerprint({"proxy_url": "http://127.0.0.1:7890"})
        with (
            patch.dict(
                config._config.setdefault("captcha", {}),
                {"captcha_method": "twocaptcha"},
            ),
            patch.object(
                flow,
                "_get_api_captcha_token",
                AsyncMock(return_value=("solved-token", "")),
            ) as solve,
        ):
            result = await flow._get_recaptcha_token(
                "project-1", "CHAT_GENERATION", token_id=1
            )
        self.assertEqual(result, ("solved-token", None))
        self.assertEqual(
            solve.call_args.args[:3], ("twocaptcha", "project-1", "CHAT_GENERATION")
        )
        self.assertEqual(solve.call_args.kwargs["proxy_url"], "http://127.0.0.1:7890")

    async def test_admin_score_solver_uses_shared_provider_client(self):
        session = ProviderSession([CREATED, READY])
        with (
            patch.object(admin, "config") as cfg,
            patch.object(admin, "proxy_manager", None),
            patch("src.services.twocaptcha.AsyncSession", return_value=session),
            patch("src.services.twocaptcha.asyncio.sleep", AsyncMock()),
        ):
            cfg.twocaptcha_api_key = "fixture-key"
            cfg.twocaptcha_base_url = "https://api.2captcha.com"
            result = await admin._solve_recaptcha_with_api_service(
                "twocaptcha",
                "https://example.com",
                "site-key",
                "check",
                enterprise=False,
            )
        self.assertEqual(result, "solved-token")
        self.assertFalse(session.requests[0][1]["json"]["task"]["isEnterprise"])


class TwoCaptchaConfigTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(self.temp.name + "/flow.db")
        await self.db.init_db()
        self.saved_config = copy.deepcopy(config.get_raw_config())

    async def asyncTearDown(self):
        config._config = self.saved_config
        self.temp.cleanup()

    async def test_save_reload_restart_and_partial_update_preserve_keys(self):
        await self.db.update_captcha_config(
            captcha_method="twocaptcha",
            twocaptcha_api_key="two-fixture-key",
            yescaptcha_api_key="yes-fixture-key",
        )
        await self.db.reload_config_to_memory()
        self.assertEqual(config.twocaptcha_api_key, "two-fixture-key")
        self.assertEqual(config.captcha_method, "twocaptcha")
        await self.db.update_captcha_config(browser_count=2)
        restarted = Database(self.db.db_path)
        cfg = await restarted.get_captcha_config()
        self.assertEqual(cfg.twocaptcha_api_key, "two-fixture-key")
        self.assertEqual(cfg.yescaptcha_api_key, "yes-fixture-key")
        self.assertEqual(cfg.twocaptcha_base_url, "https://api.2captcha.com")

    async def test_initial_configuration_imports_twocaptcha_from_toml(self):
        with redirect_stdout(io.StringIO()):
            await self.db.init_config_from_toml(
                {
                    "captcha": {
                        "captcha_method": "twocaptcha",
                        "twocaptcha_api_key": "toml-fixture-key",
                        "twocaptcha_base_url": "https://gateway.example",
                    }
                },
                is_first_startup=True,
            )
        cfg = await self.db.get_captcha_config()
        self.assertEqual(cfg.twocaptcha_api_key, "toml-fixture-key")
        self.assertEqual(cfg.twocaptcha_base_url, "https://gateway.example")

    async def test_upgrade_adds_columns_and_preserves_existing_provider(self):
        async with self.db._connect(write=True) as conn:
            await conn.execute("DROP TABLE captcha_config")
            await conn.execute(
                "CREATE TABLE captcha_config (id INTEGER PRIMARY KEY, captcha_method TEXT, yescaptcha_api_key TEXT, yescaptcha_base_url TEXT)"
            )
            await conn.execute(
                "INSERT INTO captcha_config VALUES (1, 'yescaptcha', 'existing-fixture-key', 'https://api.yescaptcha.com')"
            )
            await conn.commit()
        with redirect_stdout(io.StringIO()):
            await self.db.check_and_migrate_db()
        cfg = await self.db.get_captcha_config()
        self.assertEqual(cfg.yescaptcha_api_key, "existing-fixture-key")
        self.assertEqual(cfg.twocaptcha_api_key, "")
        self.assertEqual(cfg.twocaptcha_base_url, "https://api.2captcha.com")

    async def test_admin_configuration_roundtrip_and_authentication(self):
        app = FastAPI()
        app.include_router(admin.router)

        async def authenticated():
            return "fixture-admin"

        with patch.object(admin, "db", self.db):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://localhost"
            ) as client:
                unauthenticated = await client.get("/api/captcha/config")
                self.assertEqual(unauthenticated.status_code, 401)
                app.dependency_overrides[admin.verify_admin_token] = authenticated
                response = await client.post(
                    "/api/captcha/config",
                    json={
                        "captcha_method": "twocaptcha",
                        "twocaptcha_api_key": "api-fixture-key",
                        "twocaptcha_base_url": "https://api.2captcha.com/",
                    },
                )
                self.assertTrue(response.json()["success"])
                response = await client.get("/api/captcha/config")
        self.assertEqual(response.json()["captcha_method"], "twocaptcha")
        self.assertEqual(response.json()["twocaptcha_api_key"], "api-fixture-key")
        self.assertEqual(
            response.json()["twocaptcha_base_url"], "https://api.2captcha.com"
        )


if __name__ == "__main__":
    unittest.main()
