/**
 * spicetify-connect-api (v0.3.2)
 * Bridge between Spotify Desktop Client (Spicetify) and a WebSocket server (e.g. Python / Home Assistant).
 *
 * Installation:
 * 1. Save this file as 'spicetify-connect-api.js' in the Spicetify Extensions folder:
 * - Windows: %appdata%\spicetify\Extensions\
 * - Linux/macOS: ~/.config/spicetify/Extensions/
 * 2. Enable and apply the extension:
 * spicetify config extensions spicetify-connect-api.js
 * spicetify apply
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

    // Volume used when unmuting without a remembered volume (e.g. muted in Spotify).
    const DEFAULT_UNMUTE_VOLUME = 0.5;

    const DEFAULT_CONFIG = {
        SERVER_URL: "ws://127.0.0.1:9090",
        RECONNECT_INTERVAL: 3000,
        RECONNECT_MAX_INTERVAL: 30000,
        API_KEY: "",
        VOLUME_DEBOUNCE_MS: 150,
        VOLUME_CHECK_INTERVAL: 200,
        HEARTBEAT_INTERVAL: 30000,
        // Upcoming/previous tracks sent with each event. The full queue (50 tracks)
        // made every event about 128 KB.
        MAX_QUEUE_ITEMS: 5
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
    let lastVolume = null;
    let volumeBeforeMute = null;
    let reconnectAttempts = 0;
    let notifyOnNextConnect = true;

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

    function isWebSocketUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === "ws:" || parsed.protocol === "wss:";
        } catch (e) {
            return false;
        }
    }

    function isSecureOrLocalWs(url) {
        try {
            const parsed = new URL(url);
            const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
            return parsed.protocol === "wss:" || isLocal;
        } catch (e) {
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
        let playerData = null;
        const currentProgress = Spicetify.Player.getProgress();
        const data = Spicetify.Player.data;

        if (data) {
            const maxItems = DEFAULT_CONFIG.MAX_QUEUE_ITEMS;
            playerData = {
                ...data,
                positionAsOfTimestamp: currentProgress,
                timestamp: Date.now(),
                nextItems: Array.isArray(data.nextItems) ? data.nextItems.slice(0, maxItems) : [],
                previousItems: Array.isArray(data.previousItems) ? data.previousItems.slice(-maxItems) : []
            };
        }

        return {
            playerData,
            isPlaying: Spicetify.Player.isPlaying(),
            volume: Spicetify.Player.getVolume(),
            isMuted: typeof Spicetify.Player.getMute === "function" ? Spicetify.Player.getMute() : false,
            isHearted: typeof Spicetify.Player.getHeart === "function" ? Spicetify.Player.getHeart() : false,
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

    function sendResponse(requestId, success, payload = {}, error = null, includeToken = true) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                const config = getConfig();
                const response = {
                    eventName: "Response",
                    requestId: requestId || null,
                    success: !!success,
                    payload: payload
                };
                if (config.API_KEY && includeToken) {
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

    function detachSocket() {
        if (!socket) return;
        try {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close(1000, "Reconnecting");
        } catch (e) {}
        socket = null;
    }

    function connect() {
        const currentConfig = getConfig();

        if (socket) {
            if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
                return;
            }
            detachSocket();
        }

        if (!isSecureOrLocalWs(currentConfig.SERVER_URL)) {
            console.warn("[Spicetify-WS] Spotify blocks unencrypted ws:// connections to other devices. Use wss:// for remote servers.");
        }
        console.info("[Spicetify-WS] Connecting to %s...", currentConfig.SERVER_URL);

        try {
            socket = new WebSocket(currentConfig.SERVER_URL);

            socket.onopen = () => {
                console.log("[Spicetify-WS] WebSocket connection established!");
                reconnectAttempts = 0;
                startHeartbeat();
                if (notifyOnNextConnect) {
                    Spicetify.showNotification("Connect API: Server connected!");
                    notifyOnNextConnect = false;
                }
                sendStateEvent("InitialState");
            };

            socket.onmessage = (event) => {
                // Incoming messages are not throttled in the background, so they
                // also serve as a chance to detect polled state changes.
                handleIncomingMessage(event.data).finally(pollPlayerState);
            };

            // Per spec an "error" is always followed by "close", but some runtimes only
            // fire "error" for a failed handshake. React to whichever comes first, once.
            const thisSocket = socket;
            let closeHandled = false;
            const handleClosed = () => {
                if (closeHandled || socket !== thisSocket) return;
                closeHandled = true;
                stopHeartbeat();
                detachSocket();
                scheduleReconnect();
            };

            socket.onerror = () => {
                console.warn("[Spicetify-WS] WebSocket connection attempt failed.");
                handleClosed();
            };

            socket.onclose = handleClosed;

        } catch (err) {
            console.warn("[Spicetify-WS] Could not initiate WebSocket to %s:", currentConfig.SERVER_URL, err.message || err);
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const currentConfig = getConfig();
        // Exponential backoff: base interval, doubled per failed attempt, capped.
        const delay = Math.min(
            currentConfig.RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts),
            Math.max(currentConfig.RECONNECT_INTERVAL, DEFAULT_CONFIG.RECONNECT_MAX_INTERVAL)
        );
        reconnectAttempts += 1;
        console.info("[Spicetify-WS] Connection closed. Reconnecting in %dms...", delay);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function reconnectNow() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        stopHeartbeat();
        detachSocket();
        reconnectAttempts = 0;
        notifyOnNextConnect = true;
        connect();
    }

    let lastPingAt = 0;

    function startHeartbeat() {
        lastPingAt = Date.now();
    }

    function stopHeartbeat() {
        lastPingAt = 0;
    }

    function sendHeartbeatIfDue(now) {
        if (lastPingAt && now - lastPingAt >= DEFAULT_CONFIG.HEARTBEAT_INTERVAL) {
            lastPingAt = now;
            sendEvent("Ping", { timestamp: now });
        }
    }

    // -------------------------------------------------------------------------
    // 5. INCOMING COMMANDS
    // -------------------------------------------------------------------------

    function setMuted(muted) {
        // Spicetify defines "muted" as volume 0, but Player.setMute() only clicks
        // the mute button in the UI and silently does nothing if that button is
        // not found. Set the volume directly and remember it for unmuting.
        const current = Spicetify.Player.getVolume();
        if (muted) {
            if (current > 0) {
                volumeBeforeMute = current;
                Spicetify.Player.setVolume(0);
            }
        } else if (current === 0) {
            Spicetify.Player.setVolume(volumeBeforeMute || DEFAULT_UNMUTE_VOLUME);
            volumeBeforeMute = null;
        }
    }

    async function seekTo(positionMs) {
        // PlayerAPI.seekTo always takes milliseconds. Player.seek() treats values
        // between 0 and 1 as a percentage, so it is only used as a fallback.
        const playerApi = Spicetify.Platform && Spicetify.Platform.PlayerAPI;
        if (playerApi && typeof playerApi.seekTo === "function") {
            await playerApi.seekTo(positionMs);
        } else {
            Spicetify.Player.seek(positionMs <= 1 ? 0 : positionMs);
        }
    }

    async function handleIncomingMessage(rawData) {
        let request;
        try {
            request = JSON.parse(rawData);
        } catch (err) {
            console.warn("[Spicetify-WS] Invalid JSON received.");
            return;
        }
        if (!request || typeof request !== "object" || Array.isArray(request)) return;

        const { requestName, requestId, token } = request;
        const payload = request.payload && typeof request.payload === "object" ? request.payload : {};
        if (!requestName || typeof requestName !== "string") return;

        // Token authentication check if API_KEY is set
        const currentConfig = getConfig();
        if (currentConfig.API_KEY && token !== currentConfig.API_KEY) {
            console.warn("[Spicetify-WS] Unauthorized request attempt for '%s'. Token mismatch.", requestName);
            // Never send our own key to a server that does not know it.
            sendResponse(requestId, false, {}, "Unauthorized: Invalid or missing API key.", false);
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
                case "SetVolume": {
                    const level = payload.level;
                    if (typeof level === "number" && Number.isFinite(level) && level >= 0 && level <= 1) {
                        Spicetify.Player.setVolume(level);
                        sendResponse(requestId, true, { level });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'level' must be between 0.0 and 1.0.");
                    }
                    break;
                }
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
                        setMuted(payload.state);
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
                case "ToggleHeart": {
                    if (typeof Spicetify.Player.getHeart === "function" && typeof Spicetify.Player.setHeart === "function") {
                        const newHeartState = !Spicetify.Player.getHeart();
                        Spicetify.Player.setHeart(newHeartState);
                        sendResponse(requestId, true, { isHearted: newHeartState });
                    } else {
                        sendResponse(requestId, false, {}, "Spicetify Heart API is not available.");
                    }
                    break;
                }
                case "PlayUri": {
                    const formattedUri = toSpotifyUri(payload.uri || payload.url);
                    if (formattedUri) {
                        // playUri returns a promise; report failures instead of a false success.
                        await Spicetify.Player.playUri(formattedUri);
                        sendResponse(requestId, true, { uri: formattedUri });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'uri' or 'url' is missing/invalid.");
                    }
                    break;
                }
                case "Seek": {
                    const position = payload.position;
                    if (typeof position === "number" && Number.isFinite(position) && position >= 0) {
                        const targetMs = Math.round(position);
                        await seekTo(targetMs);
                        sendResponse(requestId, true, { position: targetMs });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'position' must be a non-negative number (ms).");
                    }
                    break;
                }
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
            sendResponse(requestId, false, {}, (err && err.message) || "Internal error");
        }
    }

    // -------------------------------------------------------------------------
    // 6. EVENT LISTENERS (Full State Architecture)
    // -------------------------------------------------------------------------

    let lastRepeat = null;
    let lastShuffle = null;
    let lastHeart = null;
    let lastBuffering = null;
    let lastProgress = 0;
    let lastProgressTime = Date.now();
    let lastPollAt = 0;

    function readHeart() {
        return typeof Spicetify.Player.getHeart === "function" ? Spicetify.Player.getHeart() : null;
    }

    function readBuffering() {
        const data = Spicetify.Player.data;
        return data ? data.isBuffering === true : null;
    }

    // Every event carries the full state, so after sending one, the polled
    // values are up to date. This avoids extra RepeatChanged/HeartChanged/...
    // events right after a song change.
    function syncPolledBaselines() {
        lastVolume = Spicetify.Player.getVolume();
        lastRepeat = Spicetify.Player.getRepeat();
        lastShuffle = Spicetify.Player.getShuffle();
        lastHeart = readHeart();
        lastBuffering = readBuffering();
        if (volumeDebounceTimer) {
            clearTimeout(volumeDebounceTimer);
            volumeDebounceTimer = null;
        }
    }

    function sendStateEvent(eventName) {
        sendEvent(eventName, getFullPlayerState());
        syncPolledBaselines();
    }

    function pollPlayerState() {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        // Several tick sources may fire; the checks are idempotent, so just rate-limit.
        if (now - lastPollAt < DEFAULT_CONFIG.VOLUME_CHECK_INTERVAL / 2) return;
        lastPollAt = now;

        sendHeartbeatIfDue(now);

        const currentVolume = Spicetify.Player.getVolume();
        if (lastVolume !== null && Math.abs(currentVolume - lastVolume) > 0.001) {
            lastVolume = currentVolume;
            if (volumeDebounceTimer) clearTimeout(volumeDebounceTimer);
            volumeDebounceTimer = setTimeout(() => {
                volumeDebounceTimer = null;
                sendStateEvent("VolumeChanged");
            }, DEFAULT_CONFIG.VOLUME_DEBOUNCE_MS);
        } else if (lastVolume === null) {
            lastVolume = currentVolume;
        }

        const currentRepeat = Spicetify.Player.getRepeat();
        if (lastRepeat !== null && currentRepeat !== lastRepeat) {
            sendStateEvent("RepeatChanged");
        } else if (lastRepeat === null) {
            lastRepeat = currentRepeat;
        }

        const currentShuffle = Spicetify.Player.getShuffle();
        if (lastShuffle !== null && currentShuffle !== lastShuffle) {
            sendStateEvent("ShuffleChanged");
        } else if (lastShuffle === null) {
            lastShuffle = currentShuffle;
        }

        const currentHeart = readHeart();
        if (currentHeart !== null) {
            if (lastHeart !== null && currentHeart !== lastHeart) {
                sendStateEvent("HeartChanged");
            } else if (lastHeart === null) {
                lastHeart = currentHeart;
            }
        }

        // Song changes and seeks are reported while Spotify is still buffering.
        // Report the end of buffering so the receiver gets the playing state and
        // an exact position. The start needs no event of its own.
        const currentBuffering = readBuffering();
        if (currentBuffering !== null) {
            if (lastBuffering === true && currentBuffering === false) {
                sendStateEvent("BufferingChanged");
            } else {
                lastBuffering = currentBuffering;
            }
        }
    }

    // Chromium throttles timers in pages hidden for more than 5 minutes to one
    // wake-up per minute, which delayed volume/repeat/shuffle/like updates (and
    // the heartbeat) while Spotify was minimized. A timer inside a dedicated
    // worker is added as a second tick source; the main-thread interval stays as
    // a fallback in case workers are unavailable or throttled as well.
    function startPolling() {
        setInterval(pollPlayerState, DEFAULT_CONFIG.VOLUME_CHECK_INTERVAL);
        try {
            const source = `setInterval(() => postMessage(0), ${DEFAULT_CONFIG.VOLUME_CHECK_INTERVAL});`;
            const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            const worker = new Worker(url);
            URL.revokeObjectURL(url);
            worker.onmessage = pollPlayerState;
        } catch (err) {
            console.info("[Spicetify-WS] Worker ticker unavailable, using the main-thread timer only.");
        }
    }

    function setupEventListeners() {
        Spicetify.Player.addEventListener("songchange", () => {
            lastProgress = 0;
            lastProgressTime = Date.now();
            sendStateEvent("SongChanged");
        });

        Spicetify.Player.addEventListener("onplaypause", () => {
            lastProgress = Spicetify.Player.getProgress();
            lastProgressTime = Date.now();
            sendStateEvent("PlayPauseChanged");
        });

        Spicetify.Player.addEventListener("onprogress", (event) => {
            const currentProgress = typeof event?.data === "number" ? event.data : Spicetify.Player.getProgress();
            const now = Date.now();
            const timePassed = now - lastProgressTime;
            const expectedProgress = Spicetify.Player.isPlaying() ? lastProgress + timePassed : lastProgress;

            if (Math.abs(currentProgress - expectedProgress) > 1500) {
                sendStateEvent("SeekChanged");
            }

            lastProgress = currentProgress;
            lastProgressTime = now;
        });

        startPolling();
    }

    // -------------------------------------------------------------------------
    // 7. UI SETTINGS INTEGRATION (PROFILE MENU)
    // -------------------------------------------------------------------------

    function createField(labelText, input, helpText) {
        const group = document.createElement("div");

        const label = document.createElement("label");
        label.textContent = labelText;
        label.style.display = "block";
        label.style.marginBottom = "5px";
        label.style.fontWeight = "bold";

        input.style.width = "100%";
        input.style.padding = "8px";
        input.style.borderRadius = "4px";
        input.style.border = "1px solid #444";
        input.style.background = "#222";
        input.style.color = "#fff";

        group.appendChild(label);
        group.appendChild(input);

        if (helpText) {
            const help = document.createElement("small");
            help.style.color = "#aaa";
            help.textContent = helpText;
            group.appendChild(help);
        }
        return group;
    }

    function createInput(type, value, placeholder) {
        const input = document.createElement("input");
        input.type = type;
        // Values are assigned as properties, never interpolated into HTML.
        input.value = value;
        if (placeholder) input.placeholder = placeholder;
        return input;
    }

    function openSettingsModal() {
        const currentConfig = getConfig();

        const content = document.createElement("div");
        content.style.display = "flex";
        content.style.flexDirection = "column";
        content.style.gap = "8px";
        content.style.padding = "10px";

        const urlInput = createInput("text", currentConfig.SERVER_URL);
        const keyInput = createInput("password", currentConfig.API_KEY, "Leave empty if authentication is disabled");
        const intervalInput = createInput("number", String(currentConfig.RECONNECT_INTERVAL));
        intervalInput.min = "1000";

        content.appendChild(createField(
            "WebSocket Server URL",
            urlInput,
            "Use ws://127.0.0.1:9090 if the server runs on this PC, or wss://SERVER_IP:9090 (or wss://your-domain) for a server on another device."
        ));
        content.appendChild(createField(
            "API Key / Secret Token (Optional)",
            keyInput,
            "Must match the API key of the server. Sent with every message and required for incoming commands."
        ));
        content.appendChild(createField(
            "Reconnect Interval (ms)",
            intervalInput,
            "Initial delay before reconnecting (minimum 1000). Doubles after each failed attempt, up to 30 seconds."
        ));

        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save & Reconnect";
        saveBtn.style.padding = "10px";
        saveBtn.style.borderRadius = "20px";
        saveBtn.style.border = "none";
        saveBtn.style.background = "#1db954";
        saveBtn.style.color = "#000";
        saveBtn.style.fontWeight = "bold";
        saveBtn.style.cursor = "pointer";
        saveBtn.style.marginTop = "10px";
        saveBtn.onclick = () => {
            const newUrl = urlInput.value.trim();
            const newApiKey = keyInput.value.trim();
            const newInterval = intervalInput.value.trim();

            if (newUrl && !isWebSocketUrl(newUrl)) {
                Spicetify.showNotification("Invalid server URL. It must start with ws:// or wss://", true);
                return;
            }

            if (newUrl) Spicetify.LocalStorage.set(STORAGE_KEYS.SERVER_URL, newUrl);
            Spicetify.LocalStorage.set(STORAGE_KEYS.API_KEY, newApiKey);
            if (newInterval) Spicetify.LocalStorage.set(STORAGE_KEYS.RECONNECT_INTERVAL, newInterval);

            Spicetify.PopupModal.hide();
            Spicetify.showNotification("Settings saved! Reconnecting...");
            // Close the current connection so a changed URL takes effect immediately.
            reconnectNow();
        };
        content.appendChild(saveBtn);

        const version = document.createElement("div");
        version.style.textAlign = "right";
        version.style.fontSize = "11px";
        version.style.color = "#666";
        version.style.marginTop = "5px";
        version.textContent = `Installed Version: v${APP_VERSION}`;
        content.appendChild(version);

        Spicetify.PopupModal.display({
            title: "Connect API Settings",
            content: content
        });
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
