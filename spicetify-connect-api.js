/**
 * spicetify-connect-api
 * Bridge between Spotify Desktop Client (Spicetify) and Python WebSocket Server.
 *
 * Installation:
 * 1. Save this file as 'spicetify-connect-api.js' in the Spicetify Extensions folder:
 * - Windows: C:\Users\%username%\AppData\Roaming\spicetify\Extensions\
 * - Linux/macOS: ~/.config/spicetify/Extensions/
 * 2. Enable and apply the extension:
 * spicetify config extensions spicetify-connect-api.js
 * spicetify apply
 */

(function SpicetifyWebSocketExtension() {
    // -------------------------------------------------------------------------
    // 1. CONFIGURATION & LOCAL STORAGE
    // -------------------------------------------------------------------------

    const APP_VERSION = "0.2.2";

    const STORAGE_KEYS = {
        SERVER_URL: "spicetify-connect-api:server_url",
        RECONNECT_INTERVAL: "spicetify-connect-api:reconnect_interval",
        API_KEY: "spicetify-connect-api:api_key"
    };

    const DEFAULT_CONFIG = {
        SERVER_URL: "ws://127.0.0.1:9090",
        RECONNECT_INTERVAL: 3000,
        API_KEY: "",
        VOLUME_DEBOUNCE_MS: 150,
        VOLUME_CHECK_INTERVAL: 200
    };

    function getConfig() {
        const rawInterval = parseInt(Spicetify.LocalStorage.get(STORAGE_KEYS.RECONNECT_INTERVAL), 10);
        const validInterval = !isNaN(rawInterval) ? Math.max(1000, rawInterval) : DEFAULT_CONFIG.RECONNECT_INTERVAL;

        return {
            SERVER_URL: Spicetify.LocalStorage.get(STORAGE_KEYS.SERVER_URL) || DEFAULT_CONFIG.SERVER_URL,
            RECONNECT_INTERVAL: validInterval,
            API_KEY: Spicetify.LocalStorage.get(STORAGE_KEYS.API_KEY) || DEFAULT_CONFIG.API_KEY,
            VOLUME_DEBOUNCE_MS: DEFAULT_CONFIG.VOLUME_DEBOUNCE_MS,
            VOLUME_CHECK_INTERVAL: DEFAULT_CONFIG.VOLUME_CHECK_INTERVAL
        };
    }

    // Internal state variables
    let socket = null;
    let reconnectTimer = null;
    let volumeDebounceTimer = null;
    let pingTimer = null;
    let lastVolume = null;

    // -------------------------------------------------------------------------
    // 2. SPICETIFY INITIALIZATION GUARD
    // -------------------------------------------------------------------------

    if (
        !window.Spicetify ||
        !Spicetify.Player ||
        !Spicetify.Platform ||
        !Spicetify.LocalStorage ||
        !Spicetify.Menu ||
        !Spicetify.React ||
        !Spicetify.ReactDOM
    ) {
        setTimeout(SpicetifyWebSocketExtension, 200);
        return;
    }

    console.log(`[Spicetify-WS] Extension v${APP_VERSION} successfully loaded.`);

    // -------------------------------------------------------------------------
    // 3. HELPER FUNCTIONS
    // -------------------------------------------------------------------------

    function toSpotifyUri(input) {
        if (!input || typeof input !== "string") return null;
        if (input.startsWith("spotify:")) return input;

        if (Spicetify.URI?.from) {
            try {
                const uriObj = Spicetify.URI.from(input);
                if (uriObj && typeof uriObj.toURI === "function") {
                    return uriObj.toURI();
                }
            } catch (e) {}
        }

        if (input.startsWith("http://") || input.startsWith("https://")) {
            try {
                const url = new URL(input);
                const host = url.hostname.toLowerCase();
                const isSpotifyHost = host === "spotify.com" || host.endsWith(".spotify.com");

                if (isSpotifyHost) {
                    const pathSegments = url.pathname.split("/").filter(Boolean);
                    const typeIndex = pathSegments.findIndex(seg =>
                        ["track", "album", "playlist", "artist", "episode", "show"].includes(seg)
                    );
                    if (typeIndex !== -1 && pathSegments[typeIndex + 1]) {
                        return `spotify:${pathSegments[typeIndex]}:${pathSegments[typeIndex + 1]}`;
                    }
                }
            } catch (e) {
                console.warn("[Spicetify-WS] Error parsing Spotify URL:", e);
            }
        }

        return input;
    }

    function getFullPlayerState() {
        let patchedPlayerData = null;

        if (Spicetify.Player.data) {
            const currentProgress = Spicetify.Player.getProgress();
            patchedPlayerData = {
                ...Spicetify.Player.data,
                position_as_of_timestamp: currentProgress,
                positionAsOfTimestamp: currentProgress,
                timestamp: Date.now()
            };
        }

        return {
            playerData: patchedPlayerData,
            isPlaying: Spicetify.Player.isPlaying(),
            volume: Spicetify.Player.getVolume(),
            isMuted: typeof Spicetify.Player.getMute === "function" ? Spicetify.Player.getMute() : false,
            shuffle: Spicetify.Player.getShuffle(),
            repeat: Spicetify.Player.getRepeat(),
            progress: Spicetify.Player.getProgress()
        };
    }

    function sendEvent(eventName, payload = {}) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                const config = getConfig();
                const msg = { eventName, payload };
                if (config.API_KEY) {
                    msg.token = config.API_KEY;
                }
                socket.send(JSON.stringify(msg));
            } catch (err) {
                console.warn("[Spicetify-WS] Error sending event:", err);
            }
        }
    }

    function sendResponse(requestId, success, payload = {}, error = null) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                const config = getConfig();
                const response = {
                    eventName: "Response",
                    requestId: requestId || null,
                    success: !!success,
                    payload: payload
                };
                if (config.API_KEY) {
                    response.token = config.API_KEY;
                }
                if (error) response.error = error;
                socket.send(JSON.stringify(response));
            } catch (err) {
                console.warn("[Spicetify-WS] Error sending response:", err);
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. WEBSOCKET CONNECTION HANDLING & CLEAN AUTO-RECONNECT
    // -------------------------------------------------------------------------

    function connect() {
        const currentConfig = getConfig();

        if (socket) {
            if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
                return;
            }
            try {
                socket.onopen = null;
                socket.onmessage = null;
                socket.onerror = null;
                socket.onclose = null;
                socket.close();
            } catch (e) {}
            socket = null;
        }

        console.info("[Spicetify-WS] Connecting to %s...", currentConfig.SERVER_URL);

        try {
            socket = new WebSocket(currentConfig.SERVER_URL);

            socket.onopen = () => {
                console.log("[Spicetify-WS] WebSocket connection established!");
                startHeartbeat();
                Spicetify.showNotification("Connect API: Server connected!");
                sendEvent("InitialState", getFullPlayerState());
                lastVolume = Spicetify.Player.getVolume();
            };

            socket.onmessage = (event) => {
                handleIncomingMessage(event.data);
            };

            socket.onerror = () => {
                console.warn("[Spicetify-WS] WebSocket connection attempt failed.");
            };

            socket.onclose = () => {
                stopHeartbeat();
                console.info("[Spicetify-WS] Connection closed. Reconnecting in %dms...", currentConfig.RECONNECT_INTERVAL);
                scheduleReconnect();
            };

        } catch (err) {
            console.warn("[Spicetify-WS] Could not initiate WebSocket to %s:", currentConfig.SERVER_URL, err.message || err);
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const currentConfig = getConfig();
        reconnectTimer = setTimeout(() => {
            connect();
        }, currentConfig.RECONNECT_INTERVAL);
    }

    function startHeartbeat() {
        stopHeartbeat();
        pingTimer = setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                sendEvent("Ping", { timestamp: Date.now() });
            }
        }, 30000);
    }

    function stopHeartbeat() {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
    }

    // -------------------------------------------------------------------------
    // 5. INCOMING COMMANDS
    // -------------------------------------------------------------------------

    function handleIncomingMessage(rawData) {
        let request;
        try {
            request = JSON.parse(rawData);
        } catch (err) {
            console.warn("[Spicetify-WS] Invalid JSON received:", rawData);
            return;
        }

        const { requestName, requestId, token, payload = {} } = request;
        if (!requestName) return;

        // Token authentication check if API_KEY is set
        const currentConfig = getConfig();
        if (currentConfig.API_KEY && token !== currentConfig.API_KEY) {
            console.warn("[Spicetify-WS] Unauthorized request attempt for '%s'. Token mismatch.", requestName);
            sendResponse(requestId, false, {}, "Unauthorized: Invalid or missing API key.");
            return;
        }

        try {
            switch (requestName) {
                case "Ping":
                    sendResponse(requestId, true, { message: "Pong", timestamp: Date.now() });
                    break;
                case "Play":
                    Spicetify.Player.play();
                    sendResponse(requestId, true, { isPlaying: true });
                    break;
                case "Pause":
                    Spicetify.Player.pause();
                    sendResponse(requestId, true, { isPlaying: false });
                    break;
                case "TogglePlay":
                    Spicetify.Player.togglePlay();
                    sendResponse(requestId, true, { isPlaying: Spicetify.Player.isPlaying() });
                    break;
                case "NextSong":
                    Spicetify.Player.next();
                    sendResponse(requestId, true);
                    break;
                case "PreviousSong":
                case "Back":
                    Spicetify.Player.back();
                    sendResponse(requestId, true);
                    break;
                case "ForcePreviousSong":
                case "ForceBack":
                    if (Spicetify.Player.getProgress() > 2000) {
                        Spicetify.Player.seek(0);
                        setTimeout(() => Spicetify.Player.back(), 50);
                    } else {
                        Spicetify.Player.back();
                    }
                    sendResponse(requestId, true);
                    break;
                case "SetVolume":
                    if (typeof payload.level === "number" && payload.level >= 0 && payload.level <= 1) {
                        Spicetify.Player.setVolume(payload.level);
                        lastVolume = payload.level;
                        sendResponse(requestId, true, { level: payload.level });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'level' must be between 0.0 and 1.0.");
                    }
                    break;
                case "SetRepeat":
                    if (typeof payload.mode === "number" && [0, 1, 2].includes(payload.mode)) {
                        Spicetify.Player.setRepeat(payload.mode);
                        sendResponse(requestId, true, { mode: payload.mode });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'mode' must be 0, 1, or 2.");
                    }
                    break;
                case "SetShuffle":
                    if (typeof payload.state === "boolean") {
                        Spicetify.Player.setShuffle(payload.state);
                        sendResponse(requestId, true, { state: payload.state });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'state' must be a boolean.");
                    }
                    break;
                case "SetMute":
                    if (typeof payload.state === "boolean") {
                        if (typeof Spicetify.Player.setMute === "function") {
                            Spicetify.Player.setMute(payload.state);
                        } else {
                            Spicetify.Player.setVolume(payload.state ? 0 : (lastVolume || 0.5));
                        }
                        sendResponse(requestId, true, { isMuted: payload.state });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'state' must be a boolean.");
                    }
                    break;
                case "PlayUri":
                    const rawUri = payload.uri || payload.url;
                    const formattedUri = toSpotifyUri(rawUri);
                    if (formattedUri) {
                        Spicetify.Player.playUri(formattedUri);
                        sendResponse(requestId, true, { uri: formattedUri });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'uri' or 'url' is missing/invalid.");
                    }
                    break;
                case "Seek":
                    if (typeof payload.position === "number") {
                        Spicetify.Player.seek(payload.position);
                        sendResponse(requestId, true, { position: payload.position });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'position' (ms) is missing.");
                    }
                    break;
                case "GetPlayerState":
                    sendResponse(requestId, true, getFullPlayerState());
                    break;
                case "GetCurrentTrack":
                    sendResponse(requestId, true, { track: Spicetify.Player.data?.item || null });
                    break;
                case "GetVolume":
                    sendResponse(requestId, true, { level: Spicetify.Player.getVolume() });
                    break;
                case "GetPlayPause":
                    sendResponse(requestId, true, { isPlaying: Spicetify.Player.isPlaying() });
                    break;
                default:
                    sendResponse(requestId, false, {}, `Unknown command '${requestName}'`);
                    break;
            }
        } catch (err) {
            console.warn("[Spicetify-WS] Error executing '%s':", requestName, err);
            sendResponse(requestId, false, {}, err.message || "Internal error");
        }
    }

    // -------------------------------------------------------------------------
    // 6. EVENT LISTENERS
    // -------------------------------------------------------------------------

    let lastRepeat = null;
    let lastShuffle = null;
    let lastProgress = 0;
    let lastProgressTime = Date.now();

    function setupEventListeners() {
        Spicetify.Player.addEventListener("songchange", (event) => {
            lastProgress = 0;
            lastProgressTime = Date.now();
            sendEvent("SongChanged", {
                track: event?.data?.item || Spicetify.Player.data?.item || null,
                playerState: Spicetify.Player.data
            });
        });

        Spicetify.Player.addEventListener("onplaypause", () => {
            lastProgress = Spicetify.Player.getProgress();
            lastProgressTime = Date.now();
            sendEvent("PlayPauseChanged", {
                isPlaying: Spicetify.Player.isPlaying(),
                playerState: Spicetify.Player.data
            });
        });

        Spicetify.Player.addEventListener("onprogress", (event) => {
            const currentProgress = typeof event?.data === "number" ? event.data : Spicetify.Player.getProgress();
            const now = Date.now();
            const timePassed = now - lastProgressTime;
            const expectedProgress = Spicetify.Player.isPlaying() ? lastProgress + timePassed : lastProgress;

            if (Math.abs(currentProgress - expectedProgress) > 1500) {
                sendEvent("SeekChanged", { position: currentProgress });
            }

            lastProgress = currentProgress;
            lastProgressTime = now;
        });

        setInterval(() => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            const currentConfig = getConfig();

            const currentVolume = Spicetify.Player.getVolume();
            if (lastVolume !== null && Math.abs(currentVolume - lastVolume) > 0.001) {
                lastVolume = currentVolume;
                if (volumeDebounceTimer) clearTimeout(volumeDebounceTimer);
                volumeDebounceTimer = setTimeout(() => {
                    sendEvent("VolumeChanged", { level: currentVolume });
                }, currentConfig.VOLUME_DEBOUNCE_MS);
            }

            const currentRepeat = Spicetify.Player.getRepeat();
            if (lastRepeat !== null && currentRepeat !== lastRepeat) {
                lastRepeat = currentRepeat;
                sendEvent("RepeatChanged", { mode: currentRepeat });
            } else if (lastRepeat === null) {
                lastRepeat = currentRepeat;
            }

            const currentShuffle = Spicetify.Player.getShuffle();
            if (lastShuffle !== null && currentShuffle !== lastShuffle) {
                lastShuffle = currentShuffle;
                sendEvent("ShuffleChanged", { state: currentShuffle });
            } else if (lastShuffle === null) {
                lastShuffle = currentShuffle;
            }
        }, DEFAULT_CONFIG.VOLUME_CHECK_INTERVAL);
    }

    // -------------------------------------------------------------------------
    // 7. UI SETTINGS INTEGRATION (PROFILE MENU)
    // -------------------------------------------------------------------------

    function openSettingsModal() {
        const currentConfig = getConfig();

        const content = document.createElement("div");
        content.style.display = "flex";
        content.style.flexDirection = "column";
        content.style.gap = "15px";
        content.style.padding = "10px";

        content.innerHTML = `
            <div>
                <label style="display:block; margin-bottom:5px; font-weight:bold;">WebSocket Server URL</label>
                <input type="text" id="ws-server-url" value="${currentConfig.SERVER_URL}" style="width:100%; padding:8px; border-radius:4px; border:1px solid #444; background:#222; color:#fff;" />
                <small style="color:#aaa;">Use <code>ws://127.0.0.1:9090</code> for local or <code>wss://IP:PORT</code> (or domain) for encrypted remote connections.</small>
            </div>
            <div>
                <label style="display:block; margin-bottom:5px; font-weight:bold;">API Key / Secret Token (Optional)</label>
                <input type="password" id="ws-api-key" value="${currentConfig.API_KEY}" placeholder="Leave empty if authentication is disabled" style="width:100%; padding:8px; border-radius:4px; border:1px solid #444; background:#222; color:#fff;" />
                <small style="color:#aaa;">Optional security token sent with outbound events and required for incoming commands.</small>
            </div>
            <div>
                <label style="display:block; margin-bottom:5px; font-weight:bold;">Reconnect Interval (ms)</label>
                <input type="number" id="ws-reconnect-interval" value="${currentConfig.RECONNECT_INTERVAL}" style="width:100%; padding:8px; border-radius:4px; border:1px solid #444; background:#222; color:#fff;" />
            </div>
            <button id="ws-save-btn" style="padding:10px; border-radius:20px; border:none; background:#1db954; color:#000; font-weight:bold; cursor:pointer; margin-top:10px;">Save & Reconnect</button>
            
            <div style="text-align:right; font-size:11px; color:#666; margin-top:5px;">
                Installed Version: v${APP_VERSION}
            </div>
        `;

        Spicetify.PopupModal.display({
            title: "Connect API Settings",
            content: content
        });

        setTimeout(() => {
            const saveBtn = document.getElementById("ws-save-btn");
            if (saveBtn) {
                saveBtn.onclick = () => {
                    const newUrl = document.getElementById("ws-server-url").value.trim();
                    const newApiKey = document.getElementById("ws-api-key").value.trim();
                    const newInterval = document.getElementById("ws-reconnect-interval").value.trim();

                    if (newUrl) Spicetify.LocalStorage.set(STORAGE_KEYS.SERVER_URL, newUrl);
                    Spicetify.LocalStorage.set(STORAGE_KEYS.API_KEY, newApiKey);
                    if (newInterval) Spicetify.LocalStorage.set(STORAGE_KEYS.RECONNECT_INTERVAL, newInterval);

                    Spicetify.PopupModal.hide();
                    Spicetify.showNotification("Settings saved! Reconnecting...");

                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    connect();
                };
            }
        }, 100);
    }

    function setupSettingsUI() {
        try {
            if (!Spicetify.Menu?.Item || !Spicetify.PopupModal) return;

            const menuItem = new Spicetify.Menu.Item(
                "Connect API Settings",
                false,
                () => {
                    openSettingsModal();
                }
            );

            menuItem.register();
        } catch (err) {
            console.warn("[Spicetify-WS] Failed to register menu UI item:", err);
        }
    }

    // -------------------------------------------------------------------------
    // 8. STARTUP
    // -------------------------------------------------------------------------

    setupEventListeners();
    setupSettingsUI();
    connect();

})();
