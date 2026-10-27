"""Current flow.google.com RPC implementation.

The public Flow web application exposes protobuf messages through Google
batchexecute.  This mixin overrides every runtime path that previously called
the retired Labs tRPC and AI Sandbox REST endpoints.
"""

import base64
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from ..core.logger import debug_logger
from .browser_cookie_utils import validate_flow_cookie_storage
from .flow_frontend import (
    flow_public_error_code,
    flow_public_error_message,
    is_terminal_flow_public_error,
)

class CurrentFlowClientMixin:
    FRONTEND_ACCESS_TOKEN = "flow-frontend-cookie"
    @staticmethod
    def _frontend_paygate_tier(payload: Any) -> str:
        # GetCredits field 4 is serviceTier; a positive credit balance proves no subscription.
        tier = payload[3] if isinstance(payload, list) and len(payload) > 3 else None
        return {2: "PAYGATE_TIER_ONE", 3: "PAYGATE_TIER_TWO"}.get(tier, "PAYGATE_TIER_NOT_PAID")
    CURRENT_IMAGE_MODELS = frozenset({"BELUGA", "HARBOR_SEAL", "GEM_PIX_2"})

    def _get_runtime_config(self):
        raise NotImplementedError

    async def _frontend_cookie(
        self,
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> str:
        return await self._resolve_flow_frontend_cookie_header(
            google_cookies=google_cookies,
            token_id=token_id,
        )

    @staticmethod
    def _normalize_media_name(media_name: str) -> str:
        normalized = str(media_name or "").strip().rstrip("/")
        if "/" in normalized:
            normalized = normalized.rsplit("/", 1)[-1]
        return normalized

    @classmethod
    def _find_uuid_value(
        cls,
        value: Any,
        excluded: Optional[set[str]] = None,
    ) -> str:
        excluded = excluded or set()
        if isinstance(value, str):
            for candidate in re.findall(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                value,
                re.IGNORECASE,
            ):
                if candidate.lower() not in {item.lower() for item in excluded}:
                    return candidate
            return ""
        if isinstance(value, list):
            for item in value:
                candidate = cls._find_uuid_value(item, excluded)
                if candidate:
                    return candidate
        elif isinstance(value, dict):
            for item in value.values():
                candidate = cls._find_uuid_value(item, excluded)
                if candidate:
                    return candidate
        return ""

    @classmethod
    def _find_media_url(cls, payload: Any) -> str:
        return cls._find_flow_content_url(
            payload, "video"
        ) or cls._find_flow_content_url(payload, "image")

    @classmethod
    def _find_encoded_media(cls, payload: Any) -> str:
        if isinstance(payload, str):
            if payload.startswith("https://"):
                return ""
            if len(payload) >= 512 and re.fullmatch(r"[A-Za-z0-9+/=_-]+", payload):
                return payload
            return ""
        if isinstance(payload, list):
            for item in payload:
                encoded = cls._find_encoded_media(item)
                if encoded:
                    return encoded
        elif isinstance(payload, dict):
            for item in payload.values():
                encoded = cls._find_encoded_media(item)
                if encoded:
                    return encoded
        return ""

    async def _current_rpc(
        self,
        *,
        rpc_id: str,
        argument: List[Any],
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
        project_id: Optional[str] = None,
        source_path: Optional[str] = None,
        timeout: Optional[int] = None,
        session_context: Optional[Dict[str, Any]] = None,
    ) -> Any:
        cookie_storage = await self._resolve_flow_frontend_cookie_storage(
            google_cookies=google_cookies,
            token_id=token_id,
        )
        return await self._call_flow_frontend_rpc(
            rpc_id=rpc_id,
            argument=argument,
            cookie_header="",
            timeout=timeout or self._get_control_plane_timeout(),
            project_id=project_id,
            source_path=source_path,
            cookie_storage=cookie_storage,
            **({"session_context": session_context} if session_context is not None else {}),
        )

    async def validate_session(
        self, *, google_cookies: str, expected_email: str,
        token_id: Optional[int] = None,
    ) -> dict:
        """Validate identity and credits, retaining cookies rotated by either request."""
        from .flow_frontend import FlowFrontendAuthError

        if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", str(expected_email or "").strip()):
            raise FlowFrontendAuthError("Не указан аккаунт для проверки Flow.")
        validate_flow_cookie_storage(google_cookies)
        context = {"expected_email": expected_email}
        payload = await self._current_rpc(
            rpc_id="nzlxg", argument=[], google_cookies=google_cookies,
            token_id=token_id, session_context=context,
        )
        values = payload if isinstance(payload, list) else []
        credits = next((
            value for value in values
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ), None)
        if credits is None or credits < 0 or not float(credits).is_integer():
            raise RuntimeError("Flow вернул некорректный баланс.")
        cookies = context["google_cookies"]
        validate_flow_cookie_storage(cookies)
        return {
            "access_token": self.FRONTEND_ACCESS_TOKEN,
            "expires": (datetime.now(timezone.utc) + timedelta(minutes=55)).isoformat().replace("+00:00", "Z"),
            "email": context["email"], "user": {"email": context["email"]},
            "google_cookies": cookies, "credits": int(credits),
            "userPaygateTier": self._frontend_paygate_tier(payload),
        }

    async def st_to_at(
        self,
        st: str = "",
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> dict:
        if str(google_cookies or "").strip():
            validate_flow_cookie_storage(google_cookies)
        credits = await self.get_credits(
            self.FRONTEND_ACCESS_TOKEN,
            google_cookies=google_cookies,
            token_id=token_id,
        )
        expires = datetime.now(timezone.utc) + timedelta(minutes=55)
        return {
            "access_token": self.FRONTEND_ACCESS_TOKEN,
            "expires": expires.isoformat().replace("+00:00", "Z"),
            "user": {},
            "credits": credits.get("credits", 0),
            "userPaygateTier": credits.get("userPaygateTier"),
        }

    async def create_project(
        self,
        st: str,
        title: str,
        google_cookies: Optional[str] = None,
        session_context: Optional[Dict[str, Any]] = None,
    ) -> str:
        payload = await self._current_rpc(
            rpc_id="jHPbke",
            argument=["projects/*", [None, [title]], [None, 22]],
            google_cookies=google_cookies,
            timeout=max(self._get_control_plane_timeout(), 20),
            session_context=session_context,
        )
        project_id = self._extract_flow_project_id(payload)
        if not project_id:
            raise RuntimeError("Flow frontend createProject response missing projectId")
        return project_id

    async def delete_project(
        self,
        st: str,
        project_id: str,
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> None:
        await self._current_rpc(
            rpc_id="QI2zvc",
            argument=[project_id],
            google_cookies=google_cookies,
            token_id=token_id,
            project_id=project_id,
        )

    async def get_credits(
        self,
        at: str = "",
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> dict:
        payload = await self._current_rpc(
            rpc_id="nzlxg",
            argument=[],
            google_cookies=google_cookies,
            token_id=token_id,
        )
        values = payload if isinstance(payload, list) else []
        credits = next(
            (
                int(value)
                for value in values
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            ),
            0,
        )
        return {
            "credits": credits,
            "userPaygateTier": self._frontend_paygate_tier(payload),
            "frontendRpc": "nzlxg",
        }

    async def get_media(
        self,
        at: str,
        media_name: str,
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
        project_id: Optional[str] = None,
        operation_id: Optional[str] = None,
    ) -> dict:
        normalized_name = self._normalize_media_name(media_name)
        normalized_operation = self._normalize_media_name(operation_id or "")
        payload = await self._current_rpc(
            rpc_id="as29s",
            argument=[normalized_operation or normalized_name],
            google_cookies=google_cookies,
            token_id=token_id,
            project_id=project_id,
            source_path=(
                f"/project/{project_id}/edit/{normalized_name}" if project_id else None
            ),
        )
        media_url = self._find_media_url(payload)
        project_id = (
            str(payload[1] or "")
            if isinstance(payload, list) and len(payload) > 1
            else ""
        )
        return {
            "name": normalized_name,
            "projectId": project_id,
            "video": {
                "fifeUrl": media_url,
                "generatedVideo": {"fifeUrl": media_url},
            },
            "image": {"generatedImage": {"fifeUrl": media_url}},
            "frontendRpc": "as29s",
        }

    async def get_media_url_redirect(
        self,
        st: str,
        media_name: str,
        media_url_type: str = "MEDIA_URL_TYPE_FULL_MEDIA",
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
        project_id: Optional[str] = None,
    ) -> Optional[str]:
        media = await self.get_media(
            self.FRONTEND_ACCESS_TOKEN,
            media_name,
            google_cookies=google_cookies,
            token_id=token_id,
            project_id=project_id,
        )
        return str((media.get("video") or {}).get("fifeUrl") or "").strip() or None

    async def delete_media(
        self,
        st: str,
        media_names: List[str],
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
        project_id: Optional[str] = None,
    ) -> None:
        names = [self._normalize_media_name(name) for name in media_names if name]
        if not names:
            return
        await self._current_rpc(
            rpc_id="cz8Z4b",
            argument=[names, None, project_id],
            google_cookies=google_cookies,
            token_id=token_id,
            project_id=project_id,
        )

    async def upload_image(
        self,
        at: str,
        image_bytes: bytes,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        project_id: Optional[str] = None,
        token_id: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> str:
        normalized_project_id = str(project_id or "").strip()
        if not normalized_project_id:
            raise ValueError("Flow frontend image upload requires project_id")
        mime_type = self._detect_image_mime_type(image_bytes)
        extension = "png" if "png" in mime_type else "jpg"
        filename = f"flow2api_{uuid.uuid4().hex[:12]}.{extension}"
        recaptcha_token, browser_id = await self._get_recaptcha_token(
            normalized_project_id,
            action="UPLOAD_IMAGE",
            token_id=token_id,
            website_url=self._build_flow_frontend_project_page_url(
                normalized_project_id
            ),
        )
        if not recaptcha_token:
            raise RuntimeError("Failed to obtain reCAPTCHA token for image upload")
        try:
            context = self._frontend_project_context(
                normalized_project_id,
                recaptcha_token,
            )
            payload = await self._current_rpc(
                rpc_id="maseQ",
                argument=[
                    context,
                    base64.b64encode(image_bytes).decode("ascii"),
                    mime_type,
                    1,
                    None,
                    None,
                    None,
                    None,
                    filename,
                    None,
                    str(uuid.uuid4()).upper(),
                    str(uuid.uuid4()).upper(),
                ],
                google_cookies=google_cookies,
                token_id=token_id,
                project_id=normalized_project_id,
                timeout=max(self._get_control_plane_timeout(), 90),
            )
            media_url = self._find_flow_content_url(payload, "image")
            media_id = ""
            if media_url:
                match = re.search(r"/image/([0-9a-f-]{36})", media_url, re.I)
                media_id = match.group(1) if match else ""
            media_id = media_id or self._find_uuid_value(
                payload,
                excluded={normalized_project_id},
            )
            if not media_id:
                raise RuntimeError("Flow frontend upload response missing mediaId")
            return media_id
        finally:
            await self._notify_browser_captcha_request_finished(browser_id)

    async def upload_video(
        self, at: str, video_bytes: bytes, filename: str, mime_type: str,
        project_id: str, token_id: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> str:
        if not self._is_uuid(project_id):
            raise ValueError("Flow video upload requires a valid project_id")
        if not isinstance(video_bytes, bytes) or not 0 < len(video_bytes) <= 100 * 1024 * 1024:
            raise ValueError("Видео должно быть не пустым и не больше 100 МБ.")
        extensions = {".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v"}
        extension = "." + str(filename or "").rsplit(".", 1)[-1].lower()
        if (
            not isinstance(filename, str) or not 1 <= len(filename) <= 256
            or re.search(r"[\x00-\x1f\x7f/\\]", filename)
            or extensions.get(extension) != mime_type
        ):
            raise ValueError("Поддерживаются видео MP4, MOV и M4V с корректным именем файла.")
        cookie_storage = await self._resolve_flow_frontend_cookie_storage(
            google_cookies=google_cookies, token_id=token_id,
        )
        context = {}
        if token_id is not None and self.db is not None:
            token = await self.db.get_token(int(token_id))
            if token:
                context["expected_email"] = getattr(token, "login_account", "") or token.email
        media_id = await self._upload_flow_frontend_video(
            project_id=project_id, video_bytes=video_bytes, filename=filename,
            mime_type=mime_type, cookie_storage=cookie_storage,
            timeout=max(self._get_control_plane_timeout(), 300), session_context=context,
        )
        refreshed_cookies = context.get("google_cookies")
        if token_id is not None and self.db is not None and refreshed_cookies:
            await self.db.update_token_if_cookie_matches(
                token_id, cookie_storage, google_cookies=refreshed_cookies,
            )
        return media_id

    async def generate_image(
        self,
        at: str,
        project_id: str,
        prompt: str,
        model_name: str,
        aspect_ratio: str,
        image_inputs: Optional[List[Dict]] = None,
        token_id: Optional[int] = None,
        token_image_concurrency: Optional[int] = None,
        progress_callback: Optional[Callable[[str, int], Awaitable[None]]] = None,
        google_cookies: Optional[str] = None,
    ) -> tuple[dict, str, Dict[str, Any]]:
        # Older internal callers may still use the retired Nano Banana 2 key.
        # Update it before submission; never retry an unavailable current model
        # with a retired upstream field.
        if model_name == "NARWHAL":
            model_name = "BELUGA"
        if model_name not in self.CURRENT_IMAGE_MODELS:
            raise ValueError(f"Unsupported Flow image model: {model_name}")
        await self._frontend_cookie(google_cookies, token_id)
        max_retries = max(1, int(self._get_runtime_config().flow_max_retries or 1))
        trace: Dict[str, Any] = {"max_retries": max_retries, "generation_attempts": []}
        last_error: Optional[Exception] = None
        cookie_storage = await self._resolve_flow_frontend_cookie_storage(
            google_cookies=google_cookies,
            token_id=token_id,
        )
        if not str(cookie_storage or "").strip():
            raise RuntimeError("Flow frontend generation requires Google session cookies")
        for retry_attempt in range(max_retries):
            started_at = time.time()
            browser_id = None
            submission_accepted = False
            attempt = {
                "attempt": retry_attempt + 1, "recaptcha_ok": False,
                "image_model_name": model_name,
            }
            try:
                if progress_callback:
                    await progress_callback("solving_image_captcha", 38)
                # The selected captcha provider supplies a token; the main
                # client always submits explicit model and generation parameters.
                token, browser_id = await self._get_recaptcha_token(
                    project_id,
                    action="IMAGE_GENERATION",
                    token_id=token_id,
                    website_url=self._build_flow_frontend_project_page_url(project_id),
                )
                attempt["recaptcha_ok"] = bool(token)
                if not token:
                    raise RuntimeError("Failed to obtain reCAPTCHA token")
                if progress_callback:
                    await progress_callback("submitting_image", 48)
                session_id = str(uuid.uuid4()).upper()
                payload = await self._current_rpc(
                    rpc_id="ogiZ0b",
                    argument=self._build_frontend_image_generation_argument(
                        project_id=project_id,
                        prompt=prompt,
                        model_name=model_name,
                        aspect_ratio=aspect_ratio,
                        recaptcha_token=token,
                        session_id=session_id,
                        image_inputs=image_inputs,
                    ),
                    google_cookies=google_cookies,
                    token_id=token_id,
                    project_id=project_id,
                    timeout=max(
                        self._get_runtime_config().flow_image_request_timeout, 90
                    ),
                )
                submission_accepted = True
                result = self._normalize_frontend_image_generation_response(payload)
                attempt["success"] = True
                attempt["duration_ms"] = int((time.time() - started_at) * 1000)
                trace["generation_attempts"].append(attempt)
                trace["final_success_attempt"] = retry_attempt + 1
                return result, session_id, trace
            except Exception as error:
                last_error = error
                attempt["success"] = False
                attempt["error"] = str(error)[:240]
                attempt["duration_ms"] = int((time.time() - started_at) * 1000)
                trace["generation_attempts"].append(attempt)
                if is_terminal_flow_public_error(error):
                    raise RuntimeError(
                        flow_public_error_message(error, "изображения")
                    ) from error
                if (
                    submission_accepted
                    or bool(getattr(error, "outcome_unknown", False))
                    or bool(getattr(error, "submission_uncertain", False))
                ):
                    raise
                retry_handler = getattr(
                    self, "_handle_retryable_generation_error", None
                )
                if retry_handler is not None:
                    should_retry = await retry_handler(
                        error,
                        retry_attempt,
                        max_retries,
                        browser_id,
                        project_id,
                        "Personal image generation",
                    )
                    if not should_retry:
                        raise
                if retry_attempt >= max_retries - 1:
                    raise
            finally:
                if isinstance(browser_id, str) and ":lease-" in browser_id:
                    await self._notify_browser_captcha_request_finished(
                        browser_id, success=submission_accepted,
                    )
                else:
                    await self._notify_browser_captcha_request_finished(browser_id)
        raise last_error or RuntimeError("Flow frontend image generation failed")

    async def upsample_image(
        self,
        at: str,
        project_id: str,
        media_id: str,
        target_resolution: str = "UPSAMPLE_IMAGE_RESOLUTION_4K",
        user_paygate_tier: str = "PAYGATE_TIER_NOT_PAID",
        session_id: Optional[str] = None,
        token_id: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> str:
        # Each protected RPC uses the selected provider and its own action token.
        token, browser_id = await self._get_recaptcha_token(
            project_id,
            action="IMAGE_GENERATION",
            token_id=token_id,
            website_url=self._build_flow_frontend_project_page_url(project_id),
        )
        if not token:
            raise RuntimeError("Failed to obtain reCAPTCHA token for image upsample")
        try:
            # The page sends enum values (verified by capturing the real UI request):
            # 1 = 2K, 2 = 4K.
            resolution = 2 if "4K" in str(target_resolution).upper() else 1
            payload = await self._current_rpc(
                rpc_id="SPrCad",
                argument=[
                    self._normalize_media_name(media_id),
                    resolution,
                    self._frontend_project_context(project_id, token),
                ],
                google_cookies=google_cookies,
                token_id=token_id,
                project_id=project_id,
                timeout=max(
                    int(self._get_runtime_config().upsample_timeout or 300), 90
                ),
            )
            return self._find_media_url(payload) or self._find_encoded_media(payload)
        finally:
            await self._notify_browser_captcha_request_finished(browser_id)

    async def _current_generate_video(
        self,
        *,
        project_id: str,
        prompt: str,
        model_key: str,
        aspect_ratio: str,
        mode: str,
        token_id: Optional[int],
        token_video_concurrency: Optional[int],
        google_cookies: Optional[str],
        reference_media_ids: Optional[List[str]] = None,
        start_media_id: Optional[str] = None,
        end_media_id: Optional[str] = None,
        video_media_id: Optional[str] = None,
        start_frame: int = 0,
        end_frame: Optional[int] = None,
        resolution: Optional[str] = None,
    ) -> dict:
        await self._frontend_cookie(google_cookies, token_id)
        max_retries = 1 if mode == "edit" else max(1, int(self._get_runtime_config().flow_max_retries or 1))
        last_error: Optional[Exception] = None
        for retry_attempt in range(max_retries):
            browser_id = None
            try:
                token, browser_id = await self._get_recaptcha_token(
                    project_id,
                    action="VIDEO_GENERATION",
                    token_id=token_id,
                    website_url=self._build_flow_frontend_project_page_url(project_id),
                )
                if not token:
                    raise RuntimeError("Failed to obtain reCAPTCHA token")
                rpc_id, argument = self._build_frontend_video_generation_argument(
                    project_id=project_id,
                    prompt=prompt,
                    model_key=model_key,
                    aspect_ratio=aspect_ratio,
                    recaptcha_token=token,
                    # Protocol requests use an independent session id instead of
                    # a native StreamChat session.
                    session_id=str(uuid.uuid4()).upper(),
                    mode=mode,
                    reference_media_ids=reference_media_ids,
                    start_media_id=start_media_id,
                    end_media_id=end_media_id,
                    video_media_id=video_media_id,
                    start_frame=start_frame,
                    end_frame=end_frame,
                    resolution=resolution,
                )
                payload = await self._current_rpc(
                    rpc_id=rpc_id,
                    argument=argument,
                    google_cookies=google_cookies,
                    token_id=token_id,
                    project_id=project_id,
                    timeout=max(self._get_video_submit_timeout(), 90),
                )
                return self._normalize_frontend_video_submission(
                    payload,
                    project_id=project_id,
                    aspect_ratio=aspect_ratio,
                    model_key=model_key,
                    rpc_id=rpc_id,
                )
            except Exception as error:
                last_error = error
                if is_terminal_flow_public_error(error):
                    raise RuntimeError(flow_public_error_message(error)) from error
                # MODEL_ACCESS_DENIED 为账号权限拒绝，重试不会改变结果
                if "MODEL_ACCESS_DENIED" in str(error):
                    raise
                if retry_attempt >= max_retries - 1:
                    raise
            finally:
                await self._notify_browser_captcha_request_finished(browser_id)
        raise last_error or RuntimeError("Flow frontend video generation failed")

    async def generate_video_text(
        self,
        at: str,
        project_id: str,
        prompt: str,
        model_key: str,
        aspect_ratio: str,
        use_v2_model_config: bool = False,
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        return await self._current_generate_video(
            project_id=project_id,
            prompt=prompt,
            model_key=model_key,
            aspect_ratio=aspect_ratio,
            mode="text",
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def generate_video_reference_images(
        self,
        at: str,
        project_id: str,
        prompt: str,
        model_key: str,
        aspect_ratio: str,
        reference_images: List[Dict],
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        media_ids = [
            str(item.get("mediaId") or item.get("name") or "").strip()
            for item in reference_images or []
            if isinstance(item, dict)
        ]
        return await self._current_generate_video(
            project_id=project_id,
            prompt=prompt,
            model_key=model_key,
            aspect_ratio=aspect_ratio,
            mode="references",
            reference_media_ids=media_ids,
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def generate_video_edit(
        self, at: str, project_id: str, prompt: str, model_key: str,
        aspect_ratio: str, source_video_id: str, start_frame: int = 0,
        end_frame: Optional[int] = None,
        reference_media_ids: Optional[List[str]] = None,
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        references = reference_media_ids or []
        if model_key not in {"abra_edit", "abra_edit_360p"}:
            raise ValueError("Видеореференс поддерживает только модель Omni Edit.")
        if not self._is_uuid(source_video_id) or any(not self._is_uuid(value) for value in references):
            raise ValueError("Укажите корректные ID видеореференса и изображений.")
        if len(references) > 5:
            raise ValueError("Omni Edit принимает не больше пяти изображений.")
        if (
            type(start_frame) is not int or type(end_frame) is not int
            or start_frame < 0 or end_frame <= start_frame or end_frame - start_frame > 300
        ):
            raise ValueError("Укажите сегмент видеореференса длиной до 10 секунд (30 кадров/с).")
        return await self._current_generate_video(
            project_id=project_id, prompt=prompt, model_key=model_key,
            aspect_ratio=aspect_ratio, mode="edit", video_media_id=source_video_id,
            start_frame=start_frame, end_frame=end_frame,
            reference_media_ids=references, token_id=token_id,
            token_video_concurrency=token_video_concurrency, google_cookies=google_cookies,
        )

    async def generate_video_start_end(
        self,
        at: str,
        project_id: str,
        prompt: str,
        model_key: str,
        aspect_ratio: str,
        start_media_id: str,
        end_media_id: str,
        use_v2_model_config: bool = False,
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        return await self._current_generate_video(
            project_id=project_id,
            prompt=prompt,
            model_key=model_key,
            aspect_ratio=aspect_ratio,
            mode="start_end",
            start_media_id=start_media_id,
            end_media_id=end_media_id,
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def generate_video_start_image(
        self,
        at: str,
        project_id: str,
        prompt: str,
        model_key: str,
        aspect_ratio: str,
        start_media_id: str,
        use_v2_model_config: bool = False,
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        return await self._current_generate_video(
            project_id=project_id,
            prompt=prompt,
            model_key=model_key,
            aspect_ratio=aspect_ratio,
            mode="start",
            start_media_id=start_media_id,
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def generate_video_extend(
        self,
        at: str,
        project_id: str,
        prompt: str,
        model_key: str,
        aspect_ratio: str,
        video_media_id: str,
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        return await self._current_generate_video(
            project_id=project_id,
            prompt=prompt,
            model_key=model_key,
            aspect_ratio=aspect_ratio,
            mode="extend",
            video_media_id=video_media_id,
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def generate_omni_reference_video(
        self,
        at: str,
        st: str,
        project_id: str,
        prompt: str,
        aspect_ratio: str,
        reference_media_ids: List[str],
        model_usage_key: str = "abra_r2v_10s",
        model_display_name: str = "Omni Flash",
        duration: int = 10,
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._current_generate_video(
            project_id=project_id,
            prompt=prompt,
            model_key=model_usage_key,
            aspect_ratio=aspect_ratio,
            mode="references",
            reference_media_ids=reference_media_ids,
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def upsample_video(
        self,
        at: str,
        project_id: str,
        video_media_id: str,
        aspect_ratio: str,
        resolution: str,
        model_key: str,
        user_paygate_tier: str = "PAYGATE_TIER_ONE",
        token_id: Optional[int] = None,
        token_video_concurrency: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        return await self._current_generate_video(
            project_id=project_id,
            prompt="",
            model_key=model_key,
            aspect_ratio=aspect_ratio,
            mode="upsample",
            video_media_id=video_media_id,
            resolution=resolution,
            token_id=token_id,
            token_video_concurrency=token_video_concurrency,
            google_cookies=google_cookies,
        )

    async def check_video_status(
        self,
        at: str,
        operations: List[Dict],
        token_id: Optional[int] = None,
        google_cookies: Optional[str] = None,
    ) -> dict:
        operation_ids: List[str] = []
        for operation in operations or []:
            operation_id = str(
                (operation or {}).get("name")
                or ((operation or {}).get("operation") or {}).get("name")
                or ""
            ).strip()
            if operation_id and operation_id not in operation_ids:
                operation_ids.append(operation_id)
        if not operation_ids:
            raise ValueError("视频状态查询缺少 Flow frontend operation ID")
        first_operation = operations[0] if operations else {}
        project_id = str((first_operation or {}).get("projectId") or "").strip()
        try:
            payload = await self._current_rpc(
                rpc_id="jwpduf",
                argument=[None, None, [[operation_id] for operation_id in operation_ids]],
                google_cookies=google_cookies,
                token_id=token_id,
                project_id=project_id or None,
                timeout=max(self._get_video_poll_timeout(), 30),
            )
        except Exception as error:
            if not is_terminal_flow_public_error(error):
                raise
            payload = [flow_public_error_code(error)]
        normalized = self._normalize_frontend_video_status(payload, operations)
        checked_operations = normalized.get("operations") or []
        for operation in checked_operations:
            if operation.get("status") in {
                "MEDIA_GENERATION_STATUS_SUCCESSFUL", "MEDIA_GENERATION_STATUS_FAILED",
            }:
                continue
            operation_body = operation.get("operation") or {}
            metadata = operation_body.get("metadata") or {}
            video_info = (
                metadata.get("video") if isinstance(metadata.get("video"), dict) else {}
            )
            media_name = str(
                operation.get("mediaName")
                or video_info.get("mediaName")
                or operation.get("name")
                or operation_body.get("name")
                or ""
            ).strip()
            if not media_name:
                continue
            try:
                operation_id = str(
                    operation.get("name") or operation_body.get("name") or ""
                ).strip()
                media = await self.get_media(
                    at,
                    media_name,
                    google_cookies=google_cookies,
                    token_id=token_id,
                    project_id=project_id or None,
                    operation_id=operation_id or None,
                )
            except Exception as media_error:
                debug_logger.log_warning(
                    f"[VIDEO POLL] media fallback failed for {media_name}: {media_error}"
                )
                continue
            video_url = str((media.get("video") or {}).get("fifeUrl") or "").strip()
            if "/video/" not in video_url:
                continue
            video_info = dict(video_info or {})
            video_info["fifeUrl"] = video_url
            video_info.setdefault("mediaName", media_name)
            metadata = dict(metadata)
            metadata["video"] = video_info
            operation_body = dict(operation_body)
            operation_body["metadata"] = metadata
            operation["operation"] = operation_body
            operation["status"] = "MEDIA_GENERATION_STATUS_SUCCESSFUL"
            operation["progress"] = 100
        return normalized

    async def run_concatenation(
        self,
        at: str,
        original_media_id: str,
        extend_media_id: str,
        **_: Any,
    ) -> dict:
        raise RuntimeError(
            "Current Flow frontend does not expose a media concatenation RPC"
        )

    async def poll_concatenation_status(
        self,
        at: str,
        operation_name: str,
        timeout: int = 300,
        poll_interval: int = 3,
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> dict:
        raise RuntimeError(
            "Current Flow frontend does not expose a media concatenation RPC"
        )

    async def get_flow_creation_agent_session(
        self,
        at: str,
        project_id: str,
        *,
        account_id: Optional[str] = None,
        allow_global_fallback: bool = True,
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> Optional[str]:
        payload = await self._current_rpc(
            rpc_id="mrlkwd",
            argument=[project_id],
            google_cookies=google_cookies,
            token_id=token_id,
            project_id=project_id,
        )
        return self._find_uuid_value(payload, excluded={project_id}) or None

    async def get_flow_creation_agent_session_detail(
        self,
        at: str,
        agent_session_id: str,
        *,
        account_id: Optional[str] = None,
        google_cookies: Optional[str] = None,
        token_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        payload = await self._current_rpc(
            rpc_id="GN0Bre",
            argument=[agent_session_id],
            google_cookies=google_cookies,
            token_id=token_id,
        )
        return {"session": payload, "frontendRpc": "GN0Bre"}

    async def create_flow_entity(self, *args: Any, **kwargs: Any) -> str:
        raise RuntimeError(
            "Flow entities are submitted through the current reference-media RPC"
        )

    async def copy_project_media_to_character_slot(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        raise RuntimeError(
            "Character media is submitted through the current reference-media RPC"
        )

    async def stream_flow_creation_agent(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> List[Dict[str, Any]]:
        raise RuntimeError(
            "Direct AI Sandbox agent streaming is retired; use current generation RPCs"
        )

    async def _warmup_flow_video_frontend_context(
        self, *args: Any, **kwargs: Any
    ) -> None:
        return None

    async def _labs_trpc_get_with_st(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        raise RuntimeError("The retired Labs tRPC transport is disabled")

    async def _labs_trpc_post_with_st(
        self, *args: Any, **kwargs: Any
    ) -> Dict[str, Any]:
        raise RuntimeError("The retired Labs tRPC transport is disabled")

    async def _aisandbox_request(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        raise RuntimeError("The retired AI Sandbox REST transport is disabled")
