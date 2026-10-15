"""Frontend requests retain scoped cookies through bootstrap and XSRF rotation."""

import json
import types
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

from curl_cffi import CurlInfo
from curl_cffi.requests.cookies import CurlMorsel

from src.services.browser_cookie_utils import serialize_cookie_header_for_url
from src.services.flow_client import FlowClient
from src.services.flow_frontend import FlowFrontendAuthError
from src.services.protocol_login import _cookie_jar, _export_cookie_jar


PROJECT_ID = "01234567-89ab-cdef-0123-456789abcdef"
BOOTSTRAP = (
    'boq_labs-ai-sandbox-frontend_20261007.14_p0 '
    '{"FdrFJe":"123","SNlM0e":"BOOTSTRAP"}'
)
COOKIES = [
    {"name": "OSID", "value": "old", "domain": "flow.google.com", "hostOnly": True, "path": "/"},
    {"name": "SID", "value": "path", "domain": ".google.com", "path": "/_/"},
    {"name": "SID", "value": "root", "domain": ".google.com", "path": "/"},
    {"name": "deleted", "value": "old", "domain": "flow.google.com", "hostOnly": True, "path": "/"},
    {"name": "HSID", "value": "accounts-only", "domain": "accounts.google.com", "hostOnly": True, "path": "/"},
]


def rotated_cookies(value):
    return [
        {**cookie, "value": value} if cookie["name"] == "OSID" else cookie
        for cookie in COOKIES if cookie["name"] != "deleted"
    ]


def response(text, cookies):
    jar = _cookie_jar(json.dumps(cookies))
    return types.SimpleNamespace(
        text=text, status_code=200, url="https://flow.google.com/projects", headers={},
        infos={CurlInfo.COOKIELIST: [
            CurlMorsel.from_cookiejar_cookie(cookie).to_curl_format().encode()
            for cookie in jar
        ]},
    )


class _Transport:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def session(self, **session_kwargs):
        transport = self

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def request(self, method, url, **kwargs):
                jar = session_kwargs["cookies"]
                transport.requests.append({
                    "method": method, "url": url, **kwargs,
                    "cookies": serialize_cookie_header_for_url(
                        _export_cookie_jar(jar.jar, ""), url
                    ),
                    "cookie_jar_id": id(jar),
                    "curl_infos": session_kwargs["curl_infos"],
                })
                return next(transport.responses)

            async def get(self, url, **kwargs):
                return await self.request("GET", url, **kwargs)

            async def post(self, url, **kwargs):
                return await self.request("POST", url, **kwargs)

        return Session()


class FlowFrontendTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = FlowClient(None)
        self.client._set_request_fingerprint({
            "user_agent": "Mozilla/5.0 Macintosh Version/18.0 Safari/605.1.15",
            "proxy_url": "http://proxy.invalid:8080",
            "session_cookies": {"OSID": "stale", "HSID": "wrong-scope", "deleted": "stale"},
        })

    async def call(self, transport, stream=False):
        with (
            patch("src.services.flow_frontend.AsyncSession", transport.session),
            patch("src.services.flow_client.AsyncSession", transport.session),
            patch("src.services.flow_client.config", types.SimpleNamespace(debug_enabled=False)),
        ):
            if stream:
                return await self.client._call_flow_stream_chat(
                    project_id=PROJECT_ID, prompt="synthetic", recaptcha_token="synthetic",
                    session_id="synthetic", cookie_header="", timeout=10,
                    cookie_storage=json.dumps(COOKIES),
                )
            return await self.client._call_flow_frontend_rpc(
                rpc_id="maseQ", argument=["synthetic"], cookie_header="", timeout=10,
                project_id=PROJECT_ID, cookie_storage=json.dumps(COOKIES),
            )

    async def test_bootstrap_and_xsrf_rotation_preserve_scoped_authoritative_cookies(self):
        transport = _Transport([
            response(BOOTSTRAP, rotated_cookies("bootstrap")),
            response('[["xsrf","CHALLENGE"]]', rotated_cookies("challenge")),
            response('[["wrb.fr","maseQ","{\\"ok\\":true}"]]', rotated_cookies("challenge")),
        ])
        self.assertEqual(await self.call(transport), {"ok": True})
        bootstrap, first, retry = transport.requests
        self.assertIn("OSID=old", bootstrap["cookies"])
        self.assertEqual(first["cookies"], "SID=path; OSID=bootstrap; SID=root")
        self.assertEqual(retry["cookies"], "SID=path; OSID=challenge; SID=root")
        self.assertEqual(len({request["cookie_jar_id"] for request in transport.requests}), 1)
        for request in transport.requests:
            self.assertNotIn("Cookie", request["headers"])
            self.assertEqual(request["curl_infos"], [CurlInfo.COOKIELIST])
            self.assertEqual(request["proxy"], "http://proxy.invalid:8080")
            self.assertEqual(request["impersonate"], "safari")
            self.assertEqual(request["headers"]["User-Agent"], bootstrap["headers"]["User-Agent"])
        first_fields, retry_fields = parse_qs(first["data"]), parse_qs(retry["data"])
        self.assertEqual(first_fields["at"], ["BOOTSTRAP"])
        self.assertEqual(retry_fields["at"], ["CHALLENGE"])
        self.assertEqual(first_fields["f.req"], retry_fields["f.req"])

    async def test_rpc_auth_rejection_does_not_resubmit(self):
        transport = _Transport([
            response(BOOTSTRAP, rotated_cookies("bootstrap")),
            response('[["er",null,null,null,null,401]]', rotated_cookies("bootstrap")),
        ])
        with self.assertRaises(FlowFrontendAuthError):
            await self.call(transport)
        self.assertEqual([request["method"] for request in transport.requests], ["GET", "POST"])

    async def test_stream_chat_uses_bootstrap_cookie_snapshot(self):
        media_url = f"https://flow-content.google/image/{PROJECT_ID}"
        transport = _Transport([
            response(BOOTSTRAP, rotated_cookies("bootstrap")),
            response(json.dumps([["wrb.fr", "stream", json.dumps([media_url])]]), rotated_cookies("bootstrap")),
        ])
        await self.call(transport, stream=True)
        self.assertEqual(transport.requests[1]["cookies"], "SID=path; OSID=bootstrap; SID=root")
        self.assertNotIn("Cookie", transport.requests[1]["headers"])
        self.assertEqual(transport.requests[1]["impersonate"], "safari")

    async def validate(self, transport):
        with (
            patch("src.services.flow_frontend.AsyncSession", transport.session),
            patch("src.services.flow_client.AsyncSession", transport.session),
            patch("src.services.flow_client.config", types.SimpleNamespace(debug_enabled=False)),
        ):
            return await self.client.validate_session(
                google_cookies=json.dumps(COOKIES), expected_email="ACCOUNT@example.com",
            )

    async def test_session_validation_returns_final_rpc_cookie_snapshot(self):
        transport = _Transport([
            response(BOOTSTRAP + ' "oPEP7c":"account@example.com"', rotated_cookies("bootstrap")),
            response('[["wrb.fr","nzlxg","[42]"]]', rotated_cookies("final")),
        ])
        result = await self.validate(transport)
        self.assertEqual(result["email"], "account@example.com")
        self.assertEqual(result["credits"], 42)
        cookies = {item["name"]: item for item in json.loads(result["google_cookies"])}
        self.assertEqual(cookies["OSID"]["value"], "final")
        self.assertNotIn("deleted", cookies)
        self.assertEqual([item["method"] for item in transport.requests], ["GET", "POST"])

    async def test_session_identity_mismatch_or_missing_stops_before_rpc(self):
        for identity in ('', ' "oPEP7c":"other@example.com"'):
            with self.subTest(identity=identity):
                transport = _Transport([response(BOOTSTRAP + identity, COOKIES)])
                with self.assertRaises(FlowFrontendAuthError):
                    await self.validate(transport)
                self.assertEqual([item["method"] for item in transport.requests], ["GET"])

    async def test_session_malformed_balance_is_not_zero_success(self):
        for payload in ([], [True], [-1], [1.5], ["0"]):
            with self.subTest(payload=payload):
                transport = _Transport([
                    response(BOOTSTRAP + ' "oPEP7c":"account@example.com"', COOKIES),
                    response(json.dumps([["wrb.fr", "nzlxg", json.dumps(payload)]]), COOKIES),
                ])
                with self.assertRaisesRegex(RuntimeError, "некорректный баланс"):
                    await self.validate(transport)


if __name__ == "__main__":
    unittest.main()
