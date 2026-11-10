"""Offline session continuity across separate upload and generation RPCs."""

import asyncio
import json
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

from src.services.flow_client import FlowClient
from src.services.flow_frontend import FlowFrontendAuthError
from src.services.protocol_login import _export_cookie_jar


PROJECT = "11111111-1111-1111-1111-111111111111"
MEDIA = "22222222-2222-2222-2222-222222222222"
OPERATION = "33333333-3333-3333-3333-333333333333"


def storage(value, obsolete=False):
    cookies = [
        {"name": "SID", "value": value, "domain": ".google.com", "path": "/"},
        {"name": "OSID", "value": "synthetic", "domain": "flow.google.com", "hostOnly": True, "path": "/"},
    ]
    if obsolete:
        cookies.append({"name": "obsolete", "value": "deleted-by-server", "domain": ".google.com", "path": "/"})
    return json.dumps(cookies)


def sid(raw):
    return next(cookie["value"] for cookie in json.loads(raw) if cookie["name"] == "SID")


@asynccontextmanager
async def generation_scope(client):
    # Older clients have no scope API; they still exercise the stale-cookie bug.
    begin = getattr(client, "begin_flow_cookie_scope", None)
    clear = getattr(client, "clear_flow_cookie_scope", None)
    if begin:
        begin()
    try:
        yield
    finally:
        if clear:
            clear()


class MemoryAccount:
    def __init__(self, cookies):
        self.account = SimpleNamespace(
            id=1, email="a@example.com", login_account="a@example.com",
            google_cookies=cookies, is_active=True, generation_cooldown_remaining_seconds=0,
        )
        self.saved = []

    async def get_token(self, token_id):
        return self.account

    async def update_token_if_cookie_matches(self, token_id, baseline, **values):
        self.saved.append((token_id, baseline, values))
        if self.account.google_cookies != baseline:
            return False
        self.account.google_cookies = values["google_cookies"]
        return True


class FlowCookieContinuityTests(unittest.IsolatedAsyncioTestCase):
    def make_client(self, db=None):
        client = FlowClient(None, db=db)
        client._get_runtime_config = lambda: SimpleNamespace(flow_max_retries=1)
        client._get_recaptcha_token = AsyncMock(return_value=("offline", None))
        client._notify_browser_captcha_request_finished = AsyncMock()
        requests = []

        async def bootstrap(url, header, timeout, cookie_jar):
            value = sid(_export_cookie_jar(cookie_jar.jar, ""))
            email = value.split("-", 1)[0] + "@example.com"
            return (
                'boq_labs-ai-sandbox-frontend_20261007.14_p0 '
                '{"FdrFJe":"123","SNlM0e":"offline","oPEP7c":'
                + json.dumps(email) + "}"
            )

        async def post(*, url, cookie_jar, **kwargs):
            rpc = parse_qs(urlparse(url).query)["rpcids"][0]
            before = _export_cookie_jar(cookie_jar.jar, "")
            requests.append((rpc, before))
            await asyncio.sleep(0)  # Interleave independent accounts on one client.
            if rpc == "maseQ":
                cookie_jar.set("SID", sid(before) + "-rotated", domain=".google.com", path="/")
                if any(cookie.name == "obsolete" for cookie in cookie_jar.jar):
                    cookie_jar.jar.clear(".google.com", "/", "obsolete")
                payload = [MEDIA]
            elif rpc == "MZZa6b":
                payload = [[OPERATION, PROJECT, MEDIA]]
            else:
                payload = [42]
            return json.dumps([["wrb.fr", rpc, json.dumps(payload)]])

        client._load_flow_frontend_bootstrap = bootstrap
        client._make_text_request = post
        return client, requests

    async def upload(self, client, cookies, token_id=1):
        return await client.upload_image(
            "unused", b"\x89PNG\r\n\x1a\n", project_id=PROJECT,
            token_id=token_id, google_cookies=cookies,
        )

    async def submit(self, client, cookies, token_id=1):
        return await client.generate_video_reference_images(
            "unused", PROJECT, "offline", "macaron_cookie_r2v_10s",
            "VIDEO_ASPECT_RATIO_PORTRAIT", [{"mediaId": MEDIA}],
            token_id=token_id, google_cookies=cookies,
        )

    async def test_upload_then_submit_uses_rotated_cookie_and_keeps_server_deletion(self):
        client, requests = self.make_client()
        original = storage("a-old", obsolete=True)
        async with generation_scope(client):
            self.assertEqual(await self.upload(client, original), MEDIA)
            result = await self.submit(client, original)
        self.assertEqual(result["operations"][0]["name"], OPERATION)
        self.assertEqual([sid(raw) for _, raw in requests], ["a-old", "a-old-rotated"])
        self.assertNotIn("obsolete", {cookie["name"] for cookie in json.loads(requests[1][1])})

    async def test_scope_cleanup_does_not_reuse_cookies_in_next_independent_call(self):
        client, requests = self.make_client()
        original = storage("a-old")
        async with generation_scope(client):
            await self.upload(client, original)
        await client._current_rpc(rpc_id="nzlxg", argument=[], google_cookies=original, token_id=1)
        self.assertEqual(sid(requests[-1][1]), "a-old")

    async def test_concurrent_accounts_keep_their_own_rotated_sessions(self):
        client, requests = self.make_client()

        async def run(account, token_id):
            original = storage(account + "-old")
            async with generation_scope(client):
                await self.upload(client, original, token_id)
                await self.submit(client, original, token_id)

        await asyncio.gather(run("a", 1), run("b", 2))
        submitted = [sid(raw) for rpc, raw in requests if rpc == "MZZa6b"]
        self.assertCountEqual(submitted, ["a-old-rotated", "b-old-rotated"])

    async def test_child_task_does_not_inherit_parent_session_snapshot(self):
        client, requests = self.make_client()
        original = storage("a-old")
        async with generation_scope(client):
            await self.upload(client, original)
            await asyncio.create_task(client._current_rpc(
                rpc_id="nzlxg", argument=[], google_cookies=original, token_id=1,
            ))
            await self.submit(client, original)
        self.assertEqual([sid(raw) for _, raw in requests], ["a-old", "a-old", "a-old-rotated"])

    async def test_new_explicit_cookie_replaces_old_snapshot_for_same_account(self):
        client, requests = self.make_client()
        async with generation_scope(client):
            await self.upload(client, storage("a-old"))
            await self.submit(client, storage("a-new-session"))
        self.assertEqual(sid(requests[-1][1]), "a-new-session")

    async def test_changed_identity_fails_before_generation_rpc(self):
        client, requests = self.make_client()
        async with generation_scope(client):
            await self.upload(client, storage("a-old"))
            with self.assertRaises(FlowFrontendAuthError):
                await self.submit(client, storage("b-new-session"))
        self.assertEqual([rpc for rpc, _ in requests], ["maseQ"])

    async def test_successful_cookie_rotation_persists_with_expected_baseline_only(self):
        original = storage("a-old", obsolete=True)
        db = MemoryAccount(original)
        client, requests = self.make_client(db)
        async with generation_scope(client):
            await self.upload(client, original)
            await self.submit(client, original)
        self.assertEqual(sid(db.account.google_cookies), "a-old-rotated")
        self.assertEqual(db.saved[0][:2], (1, original))
        self.assertEqual(set(db.saved[0][2]), {"google_cookies"})
        self.assertTrue(db.account.is_active)
        self.assertEqual(sid(requests[-1][1]), "a-old-rotated")

    async def test_plugin_session_update_wins_cas_and_next_rpc(self):
        original = storage("a-old")
        db = MemoryAccount(original)
        client, requests = self.make_client(db)
        save = db.update_token_if_cookie_matches

        async def concurrent_update(*args, **kwargs):
            db.account.google_cookies = storage("a-plugin-session")
            return await save(*args, **kwargs)

        db.update_token_if_cookie_matches = concurrent_update
        async with generation_scope(client):
            await self.upload(client, original)
            await self.submit(client, original)
        self.assertEqual(sid(db.account.google_cookies), "a-plugin-session")
        self.assertEqual(sid(requests[-1][1]), "a-plugin-session")

    async def test_current_database_session_wins_stale_caller_at_first_rpc(self):
        db = MemoryAccount(storage("a-plugin-session"))
        client, requests = self.make_client(db)
        async with generation_scope(client):
            await self.upload(client, storage("a-old"))
        self.assertEqual(sid(requests[0][1]), "a-plugin-session")

    async def test_selected_account_identity_is_pinned_before_first_rpc(self):
        db = MemoryAccount(storage("b-new-session"))
        db.account.login_account = "b@example.com"
        client, requests = self.make_client(db)
        client.begin_flow_cookie_scope(token_id=1, expected_email="a@example.com")
        try:
            with self.assertRaises(FlowFrontendAuthError):
                await self.upload(client, storage("a-old"))
        finally:
            client.clear_flow_cookie_scope()
        self.assertEqual(requests, [])

    async def test_cookie_save_error_keeps_accepted_generation_and_avoids_resubmission(self):
        original = storage("a-old")
        db = MemoryAccount(original)
        client, requests = self.make_client(db)
        post = client._make_text_request

        async def rotate_during_submission(**kwargs):
            result = await post(**kwargs)
            if "MZZa6b" in kwargs["url"]:
                kwargs["cookie_jar"].set("SID", "a-generated", domain=".google.com", path="/")
            return result

        client._make_text_request = rotate_during_submission
        db.update_token_if_cookie_matches = AsyncMock(side_effect=OSError("synthetic save failure"))
        async with generation_scope(client):
            result = await self.submit(client, original)
            await client._current_rpc(rpc_id="nzlxg", argument=[], google_cookies=original, token_id=1)
        self.assertEqual(result["operations"][0]["name"], OPERATION)
        self.assertEqual([rpc for rpc, _ in requests], ["MZZa6b", "nzlxg"])
        self.assertEqual(sid(requests[-1][1]), "a-generated")

    async def test_revoked_database_session_is_not_restored_from_snapshot(self):
        for revoked in ("cookies", "active", "identity"):
            with self.subTest(revoked=revoked):
                original = storage("a-old")
                db = MemoryAccount(original)
                client, requests = self.make_client(db)
                async with generation_scope(client):
                    await self.upload(client, original)
                    if revoked == "cookies":
                        db.account.google_cookies = ""
                    elif revoked == "active":
                        db.account.is_active = False
                    else:
                        db.account.login_account = "b@example.com"
                        db.account.google_cookies = storage("b-new-session")
                    with self.assertRaises(RuntimeError):
                        await self.submit(client, original)
                self.assertEqual([rpc for rpc, _ in requests], ["maseQ"])

    async def test_explicit_session_validation_keeps_persistence_with_its_caller(self):
        original = storage("a-old")
        db = MemoryAccount(original)
        client, _ = self.make_client(db)
        post = client._make_text_request

        async def rotate_during_validation(**kwargs):
            result = await post(**kwargs)
            kwargs["cookie_jar"].set("SID", "a-validated", domain=".google.com", path="/")
            return result

        client._make_text_request = rotate_during_validation
        async with generation_scope(client):
            result = await client.validate_session(
                google_cookies=original, expected_email="a@example.com", token_id=1,
            )
        self.assertEqual(sid(result["google_cookies"]), "a-validated")
        self.assertEqual(db.account.google_cookies, original)
        self.assertEqual(db.saved, [])


if __name__ == "__main__":
    unittest.main()
