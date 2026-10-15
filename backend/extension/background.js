let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;

const DEFAULT_SETTINGS = {
    serverUrl: "ws://127.0.0.1:8000/captcha_ws",
    apiKey: "",
    routeKey: "",
    clientLabel: ""
};

function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
            resolve({
                serverUrl: (stored.serverUrl || DEFAULT_SETTINGS.serverUrl).trim(),
                apiKey: (stored.apiKey || "").trim(),
                routeKey: (stored.routeKey || "").trim(),
                clientLabel: (stored.clientLabel || "").trim()
            });
        });
    });
}

function closeSocket() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (ws) {
        try {
            ws.close();
        } catch (e) {
            console.log("[Flow2API] Close socket error", e);
        }
        ws = null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForTabReady(tabId, timeoutMs = 12000) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            resolve();
        };
        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                finish();
            }
        };
        const timer = setTimeout(finish, timeoutMs);

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                finish();
                return;
            }
            if (tab && tab.status === "complete") {
                finish();
            }
        });
    });
}

async function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const settings = await getSettings();
    const url = new URL(settings.serverUrl || DEFAULT_SETTINGS.serverUrl);
    if (settings.apiKey) {
        url.searchParams.set("key", settings.apiKey);
    }
    if (settings.routeKey) {
        url.searchParams.set("route_key", settings.routeKey);
    }
    if (settings.clientLabel) {
        url.searchParams.set("client_label", settings.clientLabel);
    }

    ws = new WebSocket(url.toString());

    ws.onopen = () => {
        console.log("[Flow2API] Background connected to WebSocket", url.toString());
        ws.send(JSON.stringify({
            type: "register",
            route_key: settings.routeKey,
            client_label: settings.clientLabel
        }));
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    };

    let tokenQueue = Promise.resolve();

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (data.type === "register_ack") {
            console.log("[Flow2API] Registered route key:", data.route_key || "(empty)");
            return;
        }

        if (data.type === "get_token") {
            tokenQueue = tokenQueue.then(() => handleGetToken(data)).catch(err => {
                console.error("[Flow2API] Queue Error:", err);
            });
        }
    };

    ws.onclose = () => {
        console.log("[Flow2API] WebSocket Closed. Reconnecting in 2s...");
        ws = null;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWS, 2000);
    };

    ws.onerror = (e) => {
        console.log("[Flow2API] WebSocket Error", e);
    };
}

async function handleGetToken(data) {
    let newTabId = null;
    try {
        console.log("[Flow2API] Auto-opening fresh Google Labs tab to avoid token expiry...");
        const newTab = await chrome.tabs.create({ url: "https://labs.google/fx/tools/flow", active: false });
        newTabId = newTab.id;

        await waitForTabReady(newTabId);
        await sleep(1200);

        let successResponse = null;
        let lastErrorMsg = "No response from tab.";
        const scriptTimeoutMs = data.action === "VIDEO_GENERATION" ? 30000 : 20000;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: newTabId },
                world: "MAIN",
                func: async (action, timeoutMs) => {
                    return new Promise((resolve, reject) => {
                        let settled = false;
                        const finish = (fn, value) => {
                            if (settled) return;
                            settled = true;
                            fn(value);
                        };
                        try {
                            function run() {
                                grecaptcha.enterprise.ready(function() {
                                    grecaptcha.enterprise.execute("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", { action: action })
                                        .then(token => finish(resolve, token))
                                        .catch(err => finish(reject, err.message || "reCAPTCHA evaluation failed internally"));
                                });
                            }

                            if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
                                run();
                            } else {
                                const s = document.createElement("script");
                                s.src = "https://www.google.com/recaptcha/enterprise.js?render=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
                                s.onload = run;
                                s.onerror = () => finish(reject, "Failed to load enterprise.js via network");
                                document.head.appendChild(s);
                            }

                            setTimeout(() => finish(reject, "Timeout generating reCAPTCHA locally"), timeoutMs);
                        } catch (e) {
                            finish(reject, e.message);
                        }
                    });
                },
                args: [data.action || "IMAGE_GENERATION", scriptTimeoutMs]
            });

            if (results && results[0] && results[0].result) {
                successResponse = { status: "success", token: results[0].result };
            }
        } catch (e) {
            lastErrorMsg = e.message || "Script execution failed";
        }

        if (successResponse) {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: successResponse.status,
                token: successResponse.token
            }));
        } else {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: "error",
                error: "Extension script failed: " + lastErrorMsg
            }));
        }
    } catch (err) {
        ws.send(JSON.stringify({
            req_id: data.req_id,
            status: "error",
            error: err.message
        }));
    } finally {
        if (newTabId) {
            try {
                await chrome.tabs.remove(newTabId);
                console.log("[Flow2API] Closed temporary token tab.");
            } catch (e) {
                console.log("[Flow2API] Error closing tab:", e);
            }
        }
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.routeKey || changes.serverUrl || changes.apiKey || changes.clientLabel) {
        console.log("[Flow2API] Extension settings changed, reconnecting WebSocket...");
        closeSocket();
        connectWS();
    }
});

connectWS();
