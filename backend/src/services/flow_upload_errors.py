"""Safe local image-upload verification errors; never include upstream details."""

FLOW_UPLOAD_BROWSER_TIMEOUT = "[FLOW_UPLOAD_BROWSER_TIMEOUT] Истекло время ожидания проверки браузера перед загрузкой изображения."
FLOW_UPLOAD_BROWSER_UNAVAILABLE = "[FLOW_UPLOAD_BROWSER_UNAVAILABLE] Компонент проверки браузера перед загрузкой изображения недоступен."
FLOW_UPLOAD_BROWSER_ERROR = "[FLOW_UPLOAD_BROWSER_ERROR] Ошибка проверки браузера перед загрузкой изображения."
FLOW_UPLOAD_VERIFICATION_EMPTY = "[FLOW_UPLOAD_VERIFICATION_EMPTY] Браузер не вернул подтверждение для загрузки изображения."


def is_local_upload_verification_error(error) -> bool:
    error_text = str(error or "")
    return any(f"[{code}]" in error_text for code in (
        "FLOW_UPLOAD_BROWSER_TIMEOUT",
        "FLOW_UPLOAD_BROWSER_UNAVAILABLE",
        "FLOW_UPLOAD_BROWSER_ERROR",
        "FLOW_UPLOAD_VERIFICATION_EMPTY",
    ))


def is_browser_timeout(error) -> bool:
    if isinstance(error, TimeoutError):
        return True
    try:
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    except ImportError:
        return False
    return isinstance(error, PlaywrightTimeoutError)
