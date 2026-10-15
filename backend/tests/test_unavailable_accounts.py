import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from src.services.load_balancer import LoadBalancer

class UnavailableAccountsTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_account_with_credits_reports_session_not_quota(self):
        manager = SimpleNamespace(
            get_active_tokens=AsyncMock(return_value=[]),
            get_all_tokens=AsyncMock(return_value=[SimpleNamespace(is_active=False, credits=1050)]),
        )
        message = await LoadBalancer(manager).get_unavailable_reason(for_video_generation=True)
        self.assertIn('Все подключённые аккаунты отключены', message)
        self.assertIn('Проверить сейчас', message)
        self.assertNotIn('исчерпали', message)

    async def test_no_accounts_reports_connection_needed(self):
        manager = SimpleNamespace(get_active_tokens=AsyncMock(return_value=[]), get_all_tokens=AsyncMock(return_value=[]))
        message = await LoadBalancer(manager).get_unavailable_reason(for_video_generation=True)
        self.assertIn('Нет подключённых аккаунтов', message)

if __name__ == '__main__':
    unittest.main()
