'use strict';
const form = document.querySelector('#settings');
const email = document.querySelector('#email');
const token = document.querySelector('#token');
const status = document.querySelector('#status');
const button = form.querySelector('button');
const failure = 'Не удалось связаться с расширением. Закройте окно и откройте снова.';

chrome.runtime.sendMessage({type: 'status'}).then(state => {
  email.value = state.loginAccount || '';
  token.required = !state.hasToken;
  if (state.hasToken) document.querySelector('#token-hint').textContent = 'Токен сохранён в этом профиле. Оставьте поле пустым, чтобы сохранить его.';
  status.textContent = state.status?.message || 'Войдите в Flow в этом профиле и укажите настройки.';
}).catch(() => { status.textContent = failure; });

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Проверяем вход в Google Flow…';
  try {
    const result = await chrome.runtime.sendMessage({type: 'saveAndSync', loginAccount: email.value, connectionToken: token.value});
    status.textContent = result?.message || failure;
    token.value = '';
    token.required = false;
  } catch { status.textContent = failure; }
  finally { button.disabled = false; }
});
