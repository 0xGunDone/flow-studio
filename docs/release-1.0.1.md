# Flow Studio 1.0.1 — Alpha

Исправление упаковки после уведомления GitHub secret scanning №1.

- Удалены унаследованная константа Google API key и использовавший её отключённый запрос к устаревшему API.
- Добавлена проверка литералов ключей в исходниках и содержимом сборки. Она останавливает упаковку, не выводя найденное значение.
- Пересобраны DMG/ZIP для Apple Silicon и Intel; отдельные MCP и Chrome extension архивы включены в релиз.

Найденное значение совпало с публичным кодом Google Labs и исходным upstream. Пользовательские Google-сессии, пароли и локальные ключи Flow Studio этим уведомлением не затронуты. Значение не использовалось для проверки API и не отзывалось нами. [Происхождение и границы проверки](https://github.com/0xGunDone/flow-studio/blob/main/SECURITY.md).

Скачайте `mac-arm64` для Apple Silicon или `mac-x64` для Intel. Нужны Google Chrome и Docker Desktop либо Colima с Docker CLI/Compose. Сборки имеют ad-hoc подпись, без Apple Developer ID/notarization. Intel-версия упакована на Apple Silicon; отдельная проверка на физическом Intel Mac не проводилась.

История и предыдущий выпуск 1.0.0 сохранены. Новые файлы 1.0.1 не содержат унаследованной константы. Функциональность генерации не менялась; платная генерация при проверке выпуска не запускалась.

GitHub Actions отключён для аккаунта владельца; сборки проверены локально. Контрольные суммы — `SHA256SUMS.txt`.

[Установка](https://github.com/0xGunDone/flow-studio/blob/main/docs/getting-started.md) · [MCP](https://github.com/0xGunDone/flow-studio/blob/main/docs/mcp.md)
