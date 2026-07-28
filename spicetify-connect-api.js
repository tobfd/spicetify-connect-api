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
    // 1. CONFIGURATION
    // -------------------------------------------------------------------------
    const CONFIG = {
        SERVER_URL: "ws://127.0.0.1:9090", // Address of the Python WebSocket server
        RECONNECT_INTERVAL: 3000,          // Reconnect interval in ms on connection loss
        VOLUME_DEBOUNCE_MS: 150,           // Debounce delay for volume events
        VOLUME_CHECK_INTERVAL: 200         // Interval for checking volume changes
    };

    // Internal state variables
    let socket = null;
    let isConnecting = false;
    let reconnectTimer = null;
    let volumeDebounceTimer = null;
    let lastVolume = null;

    // -------------------------------------------------------------------------
    // 2. SPICETIFY INITIALIZATION GUARD
    // -------------------------------------------------------------------------
    if (!window.Spicetify || !Spicetify.Player || !Spicetify.Platform) {
        setTimeout(SpicetifyWebSocketExtension, 100);
        return;
    }

    console.log("[Spicetify-WS] Extension successfully loaded. Starting WebSocket connection...");

    // -------------------------------------------------------------------------
    // 3. HELPER FUNCTIONS
    // -------------------------------------------------------------------------

    /**
     * Converts a Spotify HTTP URL or URI string into a valid Spotify URI format.
     */
    function toSpotifyUri(input) {
        if (!input || typeof input !== "string") return null;

        // Return immediately if it is already a Spotify URI
        if (input.startsWith("spotify:")) return input;

        // Use Spicetify's internal URI parser if available
        if (Spicetify.URI?.from) {
            try {
                const uriObj = Spicetify.URI.from(input);
                if (uriObj && typeof uriObj.toURI === "function") {
                    return uriObj.toURI();
                }
            } catch (e) {
                // Fallback to manual parsing below
            }
        }

        // Handle standard web URLs (e.g., https://open.spotify.com/track/...)
        if (input.includes("spotify.com")) {
            try {
                const url = new URL(input);
                const pathSegments = url.pathname.split("/").filter(Boolean);
                const typeIndex = pathSegments.findIndex(seg => ["track", "album", "playlist", "artist", "episode", "show"].includes(seg));
                if (typeIndex !== -1 && pathSegments[typeIndex + 1]) {
                    const type = pathSegments[typeIndex];
                    const id = pathSegments[typeIndex + 1];
                    return `spotify:${type}:${id}`;
                }
            } catch (e) {
                console.error("[Spicetify-WS] Error parsing Spotify URL:", e);
            }
        }

        return input;
    }

    /**
     * Creates a full snapshot of the current player state with updated live progress.
     */
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

    /**
     * Sends an event as a JSON string to the WebSocket server.
     */
    function sendEvent(eventName, payload = {}) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({ eventName, payload }));
            } catch (err) {
                console.error("[Spicetify-WS] Error sending event:", err);
            }
        }
    }

    /**
     * Sends a response back for a received request.
     */
    function sendResponse(requestId, success, payload = {}, error = null) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                const response = {
                    eventName: "Response",
                    requestId: requestId || null,
                    success: !!success,
                    payload: payload
                };
                if (error) {
                    response.error = error;
                }
                socket.send(JSON.stringify(response));
            } catch (err) {
                console.error("[Spicetify-WS] Error sending response:", err);
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. WEBSOCKET CONNECTION HANDLING & AUTO-RECONNECT
    // -------------------------------------------------------------------------
    function connect() {
        if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
            return;
        }

        isConnecting = true;
        console.log(`[Spicetify-WS] Connecting to server ${CONFIG.SERVER_URL}...`);

        try {
            socket = new WebSocket(CONFIG.SERVER_URL);

            socket.onopen = () => {
                isConnecting = false;
                console.log("[Spicetify-WS] WebSocket connection established!");

                // Send InitialState immediately after establishing connection
                sendEvent("InitialState", getFullPlayerState());

                // Capture initial volume level
                lastVolume = Spicetify.Player.getVolume();
            };

            socket.onmessage = (event) => {
                handleIncomingMessage(event.data);
            };

            socket.onerror = (error) => {
                console.warn("[Spicetify-WS] WebSocket error occurred.");
            };

            socket.onclose = () => {
                isConnecting = false;
                console.warn(`[Spicetify-WS] Connection lost. Reconnecting in ${CONFIG.RECONNECT_INTERVAL}ms...`);
                scheduleReconnect();
            };

        } catch (err) {
            isConnecting = false;
            console.error("[Spicetify-WS] Connection attempt failed:", err);
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            connect();
        }, CONFIG.RECONNECT_INTERVAL);
    }

    // -------------------------------------------------------------------------
    // 5. INCOMING COMMANDS (INCOMING REQUESTS)
    // -------------------------------------------------------------------------
    function handleIncomingMessage(rawData) {
        let request;
        try {
            request = JSON.parse(rawData);
        } catch (err) {
            console.error("[Spicetify-WS] Invalid JSON received:", rawData);
            return;
        }

        const { requestName, requestId, payload = {} } = request;

        if (!requestName) {
            console.warn("[Spicetify-WS] Request received without 'requestName'.");
            return;
        }

        try {
            switch (requestName) {
                // --- PLAYBACK CONTROL ---
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
                        setTimeout(() => {
                            Spicetify.Player.back();
                        }, 50);
                    } else {
                        Spicetify.Player.back();
                    }
                    sendResponse(requestId, true);
                    break;

                // --- VOLUME & MODES ---
                case "SetVolume":
                    if (typeof payload.level === "number" && payload.level >= 0 && payload.level <= 1) {
                        Spicetify.Player.setVolume(payload.level);
                        lastVolume = payload.level;
                        sendResponse(requestId, true, { level: payload.level });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'level' must be a number between 0.0 and 1.0.");
                    }
                    break;

                case "SetRepeat":
                    if (typeof payload.mode === "number" && [0, 1, 2].includes(payload.mode)) {
                        Spicetify.Player.setRepeat(payload.mode);
                        sendResponse(requestId, true, { mode: payload.mode });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'mode' must be 0 (Off), 1 (All), or 2 (One).");
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

                // --- TRACK CONTROL ---
                case "PlayUri":
                    const rawUri = payload.uri || payload.url;
                    const formattedUri = toSpotifyUri(rawUri);

                    if (formattedUri) {
                        Spicetify.Player.playUri(formattedUri);
                        sendResponse(requestId, true, { uri: formattedUri });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'uri' or 'url' is missing or invalid.");
                    }
                    break;

                case "Seek":
                    if (typeof payload.position === "number") {
                        Spicetify.Player.seek(payload.position);
                        sendResponse(requestId, true, { position: payload.position });
                    } else {
                        sendResponse(requestId, false, {}, "Parameter 'position' (in ms) is missing.");
                    }
                    break;

                // --- GET QUERIES (STATUS) ---
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
                    console.warn(`[Spicetify-WS] Unknown command: ${requestName}`);
                    sendResponse(requestId, false, {}, `Unknown command '${requestName}'`);
                    break;

            }
        } catch (err) {
            console.error(`[Spicetify-WS] Error executing '${requestName}':`, err);
            sendResponse(requestId, false, {}, err.message || "Internal error");
        }
    }

    // -------------------------------------------------------------------------
    // 6. OUTGOING EVENTS (PUSH & HOOKS)
    // -------------------------------------------------------------------------
    let lastRepeat = null;
    let lastShuffle = null;
    let lastProgress = 0;
    let lastProgressTime = Date.now();

    function setupEventListeners() {
        // Event: Track changed
        Spicetify.Player.addEventListener("songchange", (event) => {
            lastProgress = 0;
            lastProgressTime = Date.now();
            sendEvent("SongChanged", {
                track: event?.data?.item || Spicetify.Player.data?.item || null,
                playerState: Spicetify.Player.data
            });
        });

        // Event: Play/Pause toggled
        Spicetify.Player.addEventListener("onplaypause", (event) => {
            lastProgress = Spicetify.Player.getProgress();
            lastProgressTime = Date.now();
            sendEvent("PlayPauseChanged", {
                isPlaying: Spicetify.Player.isPlaying(),
                playerState: Spicetify.Player.data
            });
        });

        // Event: Track seeked / Only triggered when manually seeking
        Spicetify.Player.addEventListener("onprogress", (event) => {
            const currentProgress = typeof event?.data === "number" ? event.data : Spicetify.Player.getProgress();
            const now = Date.now();
            const timePassed = now - lastProgressTime;

            // Calculate expected progress during normal playback
            const expectedProgress = Spicetify.Player.isPlaying()
                ? lastProgress + timePassed
                : lastProgress;

            // Only fire SeekChanged if position jumps by more than 1500ms compared to real time
            if (Math.abs(currentProgress - expectedProgress) > 1500) {
                sendEvent("SeekChanged", {
                    position: currentProgress
                });
            }

            lastProgress = currentProgress;
            lastProgressTime = now;
        });

        // Observer: Volume, Repeat, and Shuffle changes (background polling observer)
        setInterval(() => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;

            // 1. Volume Check
            const currentVolume = Spicetify.Player.getVolume();
            if (lastVolume !== null && Math.abs(currentVolume - lastVolume) > 0.001) {
                lastVolume = currentVolume;

                if (volumeDebounceTimer) clearTimeout(volumeDebounceTimer);
                volumeDebounceTimer = setTimeout(() => {
                    sendEvent("VolumeChanged", {
                        level: currentVolume
                    });
                }, CONFIG.VOLUME_DEBOUNCE_MS);
            }

            // 2. Repeat Check
            const currentRepeat = Spicetify.Player.getRepeat();
            if (lastRepeat !== null && currentRepeat !== lastRepeat) {
                lastRepeat = currentRepeat;
                sendEvent("RepeatChanged", {
                    mode: currentRepeat
                });
            } else if (lastRepeat === null) {
                lastRepeat = currentRepeat;
            }

            // 3. Shuffle Check
            const currentShuffle = Spicetify.Player.getShuffle();
            if (lastShuffle !== null && currentShuffle !== lastShuffle) {
                lastShuffle = currentShuffle;
                sendEvent("ShuffleChanged", {
                    state: currentShuffle
                });
            } else if (lastShuffle === null) {
                lastShuffle = currentShuffle;
            }
        }, CONFIG.VOLUME_CHECK_INTERVAL);
    }

    // -------------------------------------------------------------------------
    // 7. STARTUP
    // -------------------------------------------------------------------------
    setupEventListeners();
    connect();

})();