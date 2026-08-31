/**
 * spicetify-connect-api (v0.3.2)
 * Bridge between Spotify Desktop Client (Spicetify) and WebSocket Server (e.g., Python / Home Assistant).
 *
 * Installation:
 * 1. Save this file as 'spicetify-connect-api.js' in the Spicetify Extensions folder:
 *    - Windows: %appdata%\spicetify\Extensions\
 *    - Linux/macOS: ~/.config/spicetify/Extensions/
 * 2. Enable and apply the extension:
 *    spicetify config extensions spicetify-connect-api.js
 *    spicetify apply
 */

(function SpicetifyWebSocketExtension() {
    // -------------------------------------------------------------------------
    // 1. CONFIGURATION & LOCAL STORAGE
    // -------------------------------------------------------------------------

    const APP_VERSION = "0.3.2";

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
    let statePollInterval = null;
    let lastVolume = null;
    let preMuteVolume = 0.5;
    let isInitialized = false;

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

    function isSecureOrLocalWs(url) {
        try {
            const u = new URL(url);
            const isLocal = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
            return u.protocol === "wss:" || (u.protocol === "ws:" && isLocal);
        } catch {
            return false;
        }
    }

    function toSpotifyUri(input) {
        if (!input || typeof input !== "string") return null;
        if (input.startsWith("spotify:")) return input;

        if (Spicetify.URI?.from) {
            try {
                const uriObj = Spicetify.URI.from(input);
                if (uriObj && typeof uriObj.toURI === "function") {
                    const resolved = uriObj.toURI();
                    if (resolved && resolved.startsWith("spotify:")) {
                        return resolved;
                    }
                }
            } catch (e) {}
        }

        if (input.startsWith("http://") || input.startsWith("https://")) {
            try {
                const url = new URL(input);
                const host = url.hostname.toLowerCase();

                const isSpotifyHost =
                    host === "open.spotify.com" ||
                    host.endsWith(".open.spotify.com") ||
                    host === "spotify.com" ||
                    host.endsWith(".spotify.com") ||
                    host === "spotify.link" ||
                    host.endsWith(".spotify.link");

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
            return null;
        }

        return null;
    }

    function getFullPlayerState() {
        let patchedPlayerData = null;
        const currentProgress = Spicetify.Player.getProgress();
        const currentVolume = Spicetify.Player.getVolume();
        const currentMute = typeof Spicetify.Player.getMute === "function" ? Spicetify.Player.getMute() : false;
        const currentHeart = typeof Spicetify.Player.getHeart === "function" ? Spicetify.Player.getHeart() : false;

        if (Spicetify.Player.data) {
            patchedPlayerData = {
                ...Spicetify.Player.data,
                position_as_of_timestamp: currentProgress,
                positionAsOfTimestamp: currentProgress,
                volume: currentVolume,
                is_muted: currentMute,
                isMuted: currentMute,
                is_hearted: currentHeart,
                isHearted: currentHeart,
                timestamp: Date.now()
            };
        }

        return {
            playerData: patchedPlayerData,
            isPlaying: Spicetify.Player.isPlaying(),
            volume: currentVolume,
            isMuted: currentMute,
            isHearted: currentHeart,
            shuffle: Spicetify.Player.getShuffle(),
            repeat: Spicetify.Player.getRepeat(),
            progress: currentProgress
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

        if (!isSecureOrLocalWs(currentConfig.SERVER_URL)) {
            console.warn(
                "[Spicetify-WS] Warning: Spotify's internal CEF browser blocks unencrypted remote ws:// endpoints. Use wss:// for remote connections."
            );
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
                if (lastVolume > 0) preMuteVolume = lastVolume;
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
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            sendEvent("Ping", { timestamp: Date.now() });
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

        if (!request || typeof request !== "object" || Array.isArray(request)) return;

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
                    if (typeof payload.level === "number" && Number.isFinite(payload.level) && payload.level >= 0 && payload.level <= 1) {
                        Spicetify.Player.setVolume(payload.level);
                        if (payload.level > 0) preMuteVolume = payload.level;
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
                            if (payload.state) {
                                const currentVol = Spicetify.Player.getVolume();
                                if (currentVol > 0) preMuteVolume = currentVol;
                                Spicetify.Player.setVolume(0);
                            } else {
                                Spicetify.Player.setVolume(preMuteVolume || 0.5);
                            }
                        }
                        sendResponse(requestId, true, { isMuted: payload.state });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'state' must be a boolean.");
                    }
                    break;
                case "SetHeart":
                    if (typeof payload.status === "boolean") {
                        if (typeof Spicetify.Player.setHeart === "function") {
                            Spicetify.Player.setHeart(payload.status);
                            sendResponse(requestId, true, { isHearted: payload.status });
                        } else {
                            sendResponse(requestId, false, {}, "Spicetify Heart API is not available.");
                        }
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'status' must be a boolean.");
                    }
                    break;
                case "ToggleHeart":
                    if (typeof Spicetify.Player.getHeart === "function" && typeof Spicetify.Player.setHeart === "function") {
                        const newHeartState = !Spicetify.Player.getHeart();
                        Spicetify.Player.setHeart(newHeartState);
                        sendResponse(requestId, true, { isHearted: newHeartState });
                    } else {
                        sendResponse(requestId, false, {}, "Spicetify Heart API is not available.");
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
                    if (typeof payload.position === "number" && Number.isFinite(payload.position) && payload.position >= 0) {
                        const targetPos = Math.round(payload.position);
                        Spicetify.Player.seek(targetPos);
                        sendResponse(requestId, true, { position: targetPos });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'position' must be a non-negative number (ms).");
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
                case "GetHeart":
                    if (typeof Spicetify.Player.getHeart === "function") {
                        sendResponse(requestId, true, { isHearted: Spicetify.Player.getHeart() });
                    } else {
                        sendResponse(requestId, false, { isHearted: false }, "Spicetify Heart API is not available.");
                    }
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
    // 6. EVENT LISTENERS (v0.3.0+ Full State Architecture)
    // -------------------------------------------------------------------------

    let lastRepeat = null;
    let lastShuffle = null;
    let lastHeart = null;
    let lastProgress = 0;
    let lastProgressTime = Date.now();

    function setupEventListeners() {
        if (isInitialized) return;
        isInitialized = true;

        Spicetify.Player.addEventListener("songchange", () => {
            lastProgress = 0;
            lastProgressTime = Date.now();
            sendEvent("SongChanged", getFullPlayerState());
        });

        Spicetify.Player.addEventListener("onplaypause", () => {
            lastProgress = Spicetify.Player.getProgress();
            lastProgressTime = Date.now();
            sendEvent("PlayPauseChanged", getFullPlayerState());
        });

        Spicetify.Player.addEventListener("onprogress", (event) => {
            const currentProgress = typeof event?.data === "number" ? event.data : Spicetify.Player.getProgress();
            const now = Date.now();
            const timePassed = now - lastProgressTime;
            const expectedProgress = Spicetify.Player.isPlaying() ? lastProgress + timePassed : lastProgress;

            if (Math.abs(currentProgress - expectedProgress) > 1500) {
                sendEvent("SeekChanged", getFullPlayerState());
            }

            lastProgress = currentProgress;
            lastProgressTime = now;
        });

        statePollInterval = setInterval(() => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            const currentConfig = getConfig();

            const currentVolume = Spicetify.Player.getVolume();
            if (lastVolume !== null && Math.abs(currentVolume - lastVolume) > 0.001) {
                lastVolume = currentVolume;
                if (currentVolume > 0) preMuteVolume = currentVolume;
                if (volumeDebounceTimer) clearTimeout(volumeDebounceTimer);
                volumeDebounceTimer = setTimeout(() => {
                    sendEvent("VolumeChanged", getFullPlayerState());
                }, currentConfig.VOLUME_DEBOUNCE_MS);
            } else if (lastVolume === null) {
                lastVolume = currentVolume;
                if (currentVolume > 0) preMuteVolume = currentVolume;
            }

            const currentRepeat = Spicetify.Player.getRepeat();
            if (lastRepeat !== null && currentRepeat !== lastRepeat) {
                lastRepeat = currentRepeat;
                sendEvent("RepeatChanged", getFullPlayerState());
            } else if (lastRepeat === null) {
                lastRepeat = currentRepeat;
            }

            const currentShuffle = Spicetify.Player.getShuffle();
            if (lastShuffle !== null && currentShuffle !== lastShuffle) {
                lastShuffle = currentShuffle;
                sendEvent("ShuffleChanged", getFullPlayerState());
            } else if (lastShuffle === null) {
                lastShuffle = currentShuffle;
            }

            if (typeof Spicetify.Player.getHeart === "function") {
                const currentHeart = Spicetify.Player.getHeart();
                if (lastHeart !== null && currentHeart !== lastHeart) {
                    lastHeart = currentHeart;
                    sendEvent("HeartChanged", getFullPlayerState());
                } else if (lastHeart === null) {
                    lastHeart = currentHeart;
                }
            }
        }, DEFAULT_CONFIG.VOLUME_CHECK_INTERVAL);
    }

    function teardown() {
        if (statePollInterval) {
            clearInterval(statePollInterval);
            statePollInterval = null;
        }
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (volumeDebounceTimer) {
            clearTimeout(volumeDebounceTimer);
            volumeDebounceTimer = null;
        }
        stopHeartbeat();
        isInitialized = false;
    }

    // -------------------------------------------------------------------------
    // 7. UI SETTINGS INTEGRATION (PROFILE MENU)
    // -------------------------------------------------------------------------

    function openSettingsModal() {
        const currentConfig = getConfig();

        const container = document.createElement("div");
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.gap = "8px";
        container.style.padding = "10px";

        // Server URL Section
        const urlGroup = document.createElement("div");
        const urlLabel = document.createElement("label");
        urlLabel.textContent = "WebSocket Server URL";
        urlLabel.style.display = "block";
        urlLabel.style.marginBottom = "4px";
        urlLabel.style.fontWeight = "bold";

        const urlInput = document.createElement("input");
        urlInput.type = "text";
        urlInput.id = "ws-server-url";
        urlInput.value = currentConfig.SERVER_URL;
        urlInput.style.width = "100%";
        urlInput.style.padding = "8px";
        urlInput.style.borderRadius = "4px";
        urlInput.style.border = "1px solid #444";
        urlInput.style.background = "#222";
        urlInput.style.color = "#fff";

        const urlHelp = document.createElement("small");
        urlHelp.style.color = "#aaa";
        urlHelp.innerHTML = "Use <code>ws://127.0.0.1:9090</code> for local, <code>wss://IP:PORT:9090</code> for encrypted connections or <code>wss://DOMAIN:PORT</code> for remote connections.";

        urlGroup.appendChild(urlLabel);
        urlGroup.appendChild(urlInput);
        urlGroup.appendChild(urlHelp);

        // API Key Section
        const keyGroup = document.createElement("div");
        const keyLabel = document.createElement("label");
        keyLabel.textContent = "API Key / Secret Token (Optional)";
        keyLabel.style.display = "block";
        keyLabel.style.marginBottom = "4px";
        keyLabel.style.fontWeight = "bold";

        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.id = "ws-api-key";
        keyInput.value = currentConfig.API_KEY;
        keyInput.placeholder = "Leave empty if authentication is disabled";
        keyInput.style.width = "100%";
        keyInput.style.padding = "8px";
        keyInput.style.borderRadius = "4px";
        keyInput.style.border = "1px solid #444";
        keyInput.style.background = "#222";
        keyInput.style.color = "#fff";

        const keyHelp = document.createElement("small");
        keyHelp.style.color = "#aaa";
        keyHelp.textContent = "Optional security token sent with outbound events and required for incoming commands.";

        keyGroup.appendChild(keyLabel);
        keyGroup.appendChild(keyInput);
        keyGroup.appendChild(keyHelp);

        // Reconnect Interval Section
        const intervalGroup = document.createElement("div");
        const intervalLabel = document.createElement("label");
        intervalLabel.textContent = "Reconnect Interval (ms)";
        intervalLabel.style.display = "block";
        intervalLabel.style.marginBottom = "4px";
        intervalLabel.style.fontWeight = "bold";

        const intervalInput = document.createElement("input");
        intervalInput.type = "number";
        intervalInput.id = "ws-reconnect-interval";
        intervalInput.value = String(currentConfig.RECONNECT_INTERVAL);
        intervalInput.style.width = "100%";
        intervalInput.style.padding = "8px";
        intervalInput.style.borderRadius = "4px";
        intervalInput.style.border = "1px solid #444";
        intervalInput.style.background = "#222";
        intervalInput.style.color = "#fff";

        intervalGroup.appendChild(intervalLabel);
        intervalGroup.appendChild(intervalInput);

        // Save Button
        const saveBtn = document.createElement("button");
        saveBtn.id = "ws-save-btn";
        saveBtn.textContent = "Save & Reconnect";
        saveBtn.style.padding = "10px";
        saveBtn.style.borderRadius = "20px";
        saveBtn.style.border = "none";
        saveBtn.style.background = "#1db954";
        saveBtn.style.color = "#000";
        saveBtn.style.fontWeight = "bold";
        saveBtn.style.cursor = "pointer";
        saveBtn.style.marginTop = "8px";

        saveBtn.onclick = () => {
            const newUrl = urlInput.value.trim();
            const newApiKey = keyInput.value.trim();
            const newInterval = intervalInput.value.trim();

            if (newUrl) Spicetify.LocalStorage.set(STORAGE_KEYS.SERVER_URL, newUrl);
            Spicetify.LocalStorage.set(STORAGE_KEYS.API_KEY, newApiKey);
            if (newInterval) Spicetify.LocalStorage.set(STORAGE_KEYS.RECONNECT_INTERVAL, newInterval);

            Spicetify.PopupModal.hide();
            Spicetify.showNotification("Settings saved! Reconnecting...");

            if (reconnectTimer) clearTimeout(reconnectTimer);
            connect();
        };

        // Version Footer
        const versionFooter = document.createElement("div");
        versionFooter.style.textAlign = "right";
        versionFooter.style.fontSize = "11px";
        versionFooter.style.color = "#666";
        versionFooter.style.marginTop = "4px";
        versionFooter.textContent = `Installed Version: v${APP_VERSION}`;

        container.appendChild(urlGroup);
        container.appendChild(keyGroup);
        container.appendChild(intervalGroup);
        container.appendChild(saveBtn);
        container.appendChild(versionFooter);

        Spicetify.PopupModal.display({
            title: "Connect API Settings",
            content: container
        });

        // Style the close button inside the modal cleanly
        setTimeout(() => {
            const modalRoot = document.querySelector("#spicetify-modal-root, .GenericModal__overlay, [data-testid='modal-container']");
            if (!modalRoot) return;

            const modalDialog = modalRoot.querySelector("div[role='dialog'], .GenericModal, [class*='modal-container']");
            if (modalDialog) {
                modalDialog.style.position = "relative";
            }

            const closeBtn = modalRoot.querySelector("button[aria-label*='Close'], button[aria-label*='Schließen'], button.main-trackCreditsModal-closeBtn");
            if (closeBtn) {
                closeBtn.style.position = "absolute";
                closeBtn.style.top = "20px";
                closeBtn.style.right = "20px";
                closeBtn.style.background = "transparent";
                closeBtn.style.border = "none";
                closeBtn.style.color = "#b3b3b3";
                closeBtn.style.cursor = "pointer";
                closeBtn.style.width = "32px";
                closeBtn.style.height = "32px";
                closeBtn.style.display = "flex";
                closeBtn.style.alignItems = "center";
                closeBtn.style.justifyContent = "center";
                closeBtn.style.borderRadius = "50%";
                closeBtn.style.zIndex = "1000";

                closeBtn.onmouseenter = () => {
                    closeBtn.style.color = "#fff";
                    closeBtn.style.background = "rgba(255, 255, 255, 0.1)";
                };
                closeBtn.onmouseleave = () => {
                    closeBtn.style.color = "#b3b3b3";
                    closeBtn.style.background = "transparent";
                };
            }
        }, 50);
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
    // 8. STARTUP & LIFECYCLE
    // -------------------------------------------------------------------------

    window.addEventListener("beforeunload", teardown);
    setupEventListeners();
    setupSettingsUI();
    connect();

})();
