"""Read app-staged local video references; never fetch a supplied URL/path."""
import asyncio
import json
import math
import os
import re
import stat
from pathlib import Path

INPUT_DIR = Path(os.environ.get("FLOW_STUDIO_INPUT_DIR", "/app/tmp/flow-studio-inputs"))
MIMES = {"mp4": "video/mp4", "mov": "video/quicktime", "m4v": "video/x-m4v"}


async def read_video_reference(reference: dict) -> dict:
    identifier = str(reference.get("file_id") or "")
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|m4v)", identifier):
        raise ValueError("Некорректный локальный видеофайл.")
    location = INPUT_DIR / identifier
    extension = identifier.rsplit(".", 1)[1]
    if reference.get("mime_type") != MIMES[extension]:
        raise ValueError("Формат видео не совпадает с расширением файла.")
    fd = os.open(location, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        attributes = os.fstat(fd)
        if not stat.S_ISREG(attributes.st_mode):
            raise ValueError("Видео должно быть обычным файлом.")
        size = attributes.st_size
        if not 0 < size <= 100 * 1024 * 1024:
            raise ValueError("Видео должно быть не больше 100 МБ.")
        process = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
            "-show_entries", "format=duration:stream=codec_type,duration",
            "-of", "json", f"/proc/self/fd/{fd}", pass_fds=(fd,),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout=15)
        except BaseException:
            process.kill()
            await process.wait()
            raise
        if process.returncode or len(output) > 65536:
            raise ValueError("Не удалось прочитать видео. Используйте MP4, MOV или M4V.")
        metadata = json.loads(output)
        videos = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"]
        duration = float(metadata.get("format", {}).get("duration") or (videos[0].get("duration") if videos else 0) or 0)
        if not videos or not math.isfinite(duration) or not 0 < duration <= 10.02:
            raise ValueError("Omni Edit принимает видео длительностью до 10 секунд. Обрежьте исходный файл.")
        with os.fdopen(os.dup(fd), "rb") as source:
            source.seek(0)
            data = source.read(100 * 1024 * 1024 + 1)
        if len(data) != size:
            raise ValueError("Видеофайл изменился во время чтения.")
        return {"bytes": data, "mime_type": MIMES[extension],
                "filename": str(reference.get("filename") or identifier)[:256],
                "duration_seconds": duration, "end_frame": min(300, max(1, round(duration * 30)))}
    finally:
        os.close(fd)
