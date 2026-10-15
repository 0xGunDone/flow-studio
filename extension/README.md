# Flow Studio Session Sync

Optional Chrome extension for refreshing a Google Flow session in a local Flow Studio installation. This is an original Flow Studio implementation, licensed under MIT; no upstream Token Updater code or assets are included.

1. Start Flow Studio and sign in to Google Flow in the Chrome profile you want to connect.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this `extension` directory.
3. In the local backend management page, open the browser extension settings and obtain the connection token. This is the extension connection token, not the API key or your Google password.
4. Open the extension popup. Enter the Google account email and connection token, then choose **Сохранить и синхронизировать**.

The endpoint is fixed to `http://127.0.0.1:38000/api/plugin/update-token`. Remote servers and incognito profiles are unsupported. The backend checks that the Flow session belongs to the entered email before saving it. For multiple accounts, install/configure the extension separately in each Chrome profile.

The extension opens a temporary inactive tab at `https://flow.google.com/projects`, waits for the page to load, reads cookies matching that URL, and closes the tab. Cookie domain, path, host-only status, security flags, SameSite metadata, expiry, and duplicate names remain intact; partitioned cookies are excluded. It sends cookies only to the fixed loopback endpoint and refuses HTTP redirects. It does not read passwords or execute scripts in web pages.

The connection token and account email are stored in this Chrome profile's local extension storage, which is not encrypted by this extension. They are never written to Chrome sync storage. Cookie values are not persisted by the extension; only a SHA-256 fingerprint and a safe status message are retained. The local backend stores the session. Do not share your browser profile or backend data directory.

Automatic checks run every 10 minutes and on browser startup. Relevant cookie changes schedule a check after 30 seconds; later changes do not move that deadline, and changes during a check do not schedule another check. Loading Flow in a normal tab also schedules a forced upload after 30 seconds, so a new sign-in can refresh the backend even when cookie values are unchanged. An unchanged cookie fingerprint skips a routine automatic upload and does not establish backend session validity. Manual sync and browser startup always upload. Chrome may delay checks while the computer sleeps. A backend restart or failed upload can require manual sync.

Permissions: `cookies` reads the Flow session; Google host access includes `http://google.com/*` because Chrome requires it for non-Secure `.google.com` cookies even when reading the HTTPS Flow URL. No HTTP requests to Google are made. `tabs` manages the temporary Flow tab; `alarms` schedules checks; `storage` keeps local settings; loopback access permits the local upload.

Run offline tests from the repository root:

```sh
node --test extension/tests/*.test.cjs
```

Tests mock Chrome and network APIs. A real Chrome profile with a user-completed Google sign-in is still needed to check live session refresh.
