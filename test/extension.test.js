"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, FakeWebSocket } = require("./helpers");

let ext;

afterEach(() => {
    ext?.dispose();
    assert.deepEqual(ext?.schemaErrors ?? [], [], "sent messages must match protocol/messages.schema.json");
});

function connected(options) {
    ext = loadExtension(options);
    const socket = ext.latestSocket();
    socket.open();
    return socket;
}

function lastResponse(socket) {
    return socket.sent.filter((m) => m.eventName === "Response").at(-1);
}

const PLAYER_DATA = {
    item: { uri: "spotify:track:1", name: "Track" },
    nextItems: Array.from({ length: 50 }, (_, i) => ({ uri: `spotify:track:n${i}` })),
    previousItems: [{ uri: "spotify:track:p1" }],
    positionAsOfTimestamp: 0
};

test("connects to the configured URL and authenticates with InitialState", () => {
    const socket = connected();

    assert.equal(socket.url, "ws://127.0.0.1:9090");
    const [first] = socket.sent;
    assert.equal(first.eventName, "InitialState");
    assert.equal(first.token, "secret");
    assert.equal(first.payload.protocolVersion, 1);
    assert.equal(first.payload.extensionVersion, "0.4.0");
    assert.equal(ext.notifications.length, 1);
});

test("failed requests carry a machine-readable error code", async () => {
    const socket = connected();

    await socket.receive({ requestName: "SetVolume", requestId: "1", token: "secret", payload: { level: 2 } });
    assert.equal(lastResponse(socket).code, "invalid_params");

    await socket.receive({ requestName: "Teleport", requestId: "2", token: "secret" });
    assert.equal(lastResponse(socket).code, "unknown_request");

    await socket.receive({ requestName: "Play", requestId: "3", token: "wrong" });
    assert.equal(lastResponse(socket).code, "unauthorized");

    ext.player.playUriError = "Track unavailable";
    await socket.receive({ requestName: "PlayUri", requestId: "4", token: "secret", payload: { uri: "spotify:track:x" } });
    assert.equal(lastResponse(socket).code, "command_failed");
});

test("executes authorized commands", async () => {
    const socket = connected();

    await socket.receive({ requestName: "Play", requestId: "1", token: "secret" });
    await socket.receive({ requestName: "SetVolume", requestId: "2", token: "secret", payload: { level: 0.5 } });

    assert.deepEqual(ext.callsOf("play"), [[]]);
    assert.deepEqual(ext.callsOf("setVolume"), [[0.5]]);
    assert.equal(lastResponse(socket).success, true);
});

test("rejects requests with a wrong token without revealing the key", async () => {
    const socket = connected();

    await socket.receive({ requestName: "Play", requestId: "1", token: "wrong" });

    const response = lastResponse(socket);
    assert.equal(response.success, false);
    assert.equal(response.token, undefined);
    assert.deepEqual(ext.callsOf("play"), []);
});

test("ignores malformed messages", async () => {
    const socket = connected();
    const before = socket.sent.length;

    for (const raw of ["[]", "null", "\"text\"", "{not json"]) {
        socket.onmessage({ data: raw });
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(socket.sent.length, before);
});

test("validates command parameters", async () => {
    const socket = connected();

    for (const level of [-0.1, 1.5, Number.NaN, "0.5"]) {
        await socket.receive({ requestName: "SetVolume", requestId: "v", token: "secret", payload: { level } });
        assert.equal(lastResponse(socket).success, false, `level ${level}`);
    }
    await socket.receive({ requestName: "Seek", requestId: "s", token: "secret", payload: { position: -1 } });
    assert.equal(lastResponse(socket).success, false);
    assert.deepEqual(ext.callsOf("setVolume"), []);
});

test("seeks in milliseconds via PlayerAPI.seekTo", async () => {
    const socket = connected();

    await socket.receive({ requestName: "Seek", requestId: "1", token: "secret", payload: { position: 61000.4 } });
    await socket.receive({ requestName: "Seek", requestId: "2", token: "secret", payload: { position: 1 } });

    // Player.seek() would treat 1 as 100 %, PlayerAPI.seekTo() always takes milliseconds.
    assert.deepEqual(ext.callsOf("PlayerAPI.seekTo"), [[61000], [1]]);
    assert.deepEqual(ext.callsOf("seek"), []);
});

test("SetMute sets the volume to 0 and restores it on unmute", async () => {
    const socket = connected();

    await socket.receive({ requestName: "SetMute", requestId: "1", token: "secret", payload: { state: true } });
    assert.equal(ext.player.volume, 0);
    assert.equal(lastResponse(socket).success, true);

    await socket.receive({ requestName: "SetMute", requestId: "2", token: "secret", payload: { state: false } });
    assert.equal(ext.player.volume, 0.42);
    // Player.setMute() only clicks a UI button that may not exist.
    assert.deepEqual(ext.callsOf("setMute"), []);
});

test("SetMute unmutes to a default volume if nothing was remembered", async () => {
    const socket = connected();
    ext.player.volume = 0;

    await socket.receive({ requestName: "SetMute", requestId: "1", token: "secret", payload: { state: false } });
    assert.equal(ext.player.volume, 0.5);

    // Muting twice must not overwrite the remembered volume with 0.
    await socket.receive({ requestName: "SetMute", requestId: "2", token: "secret", payload: { state: true } });
    await socket.receive({ requestName: "SetMute", requestId: "3", token: "secret", payload: { state: true } });
    await socket.receive({ requestName: "SetMute", requestId: "4", token: "secret", payload: { state: false } });
    assert.equal(ext.player.volume, 0.5);
});

test("PlayUri converts web URLs and reports playback failures", async () => {
    const socket = connected();

    await socket.receive({
        requestName: "PlayUri", requestId: "1", token: "secret",
        payload: { url: "https://open.spotify.com/intl-de/track/55pBIZO1cqoldeqpp5WR7H?si=x" }
    });
    assert.deepEqual(ext.callsOf("playUri"), [["spotify:track:55pBIZO1cqoldeqpp5WR7H"]]);
    assert.equal(lastResponse(socket).success, true);

    ext.player.playUriError = "Track unavailable";
    await socket.receive({ requestName: "PlayUri", requestId: "2", token: "secret", payload: { uri: "spotify:track:x" } });
    const response = lastResponse(socket);
    assert.equal(response.success, false);
    assert.equal(response.error, "Track unavailable");

    await socket.receive({
        requestName: "PlayUri", requestId: "3", token: "secret", payload: { url: "https://evil.example/track/1" }
    });
    assert.equal(lastResponse(socket).success, false);
});

test("events carry a trimmed queue and no duplicated fields", () => {
    const socket = connected({ playerData: PLAYER_DATA });

    const { payload } = socket.sent[0];
    assert.equal(payload.playerData.nextItems.length, 5);
    assert.equal(payload.playerData.previousItems.length, 1);
    assert.equal(payload.playerData.position_as_of_timestamp, undefined);
    assert.equal(payload.playerData.is_hearted, undefined);
    assert.equal(payload.volume, 0.42);
    assert.equal(payload.isHearted, true);
});

test("a song change sends a single event", async () => {
    const socket = connected({ playerData: PLAYER_DATA });
    // Let the polling loop record its baselines first.
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.sent.length = 0;

    // A new track with a different liked state and repeat mode.
    ext.player.heart = false;
    ext.player.repeat = 1;
    ext.listeners.songchange.forEach((callback) => callback());
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(socket.sent.map((m) => m.eventName), ["SongChanged"]);
});

test("polled changes are reported", async () => {
    const socket = connected();
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.sent.length = 0;

    ext.player.shuffle = true;
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(socket.sent.map((m) => m.eventName), ["ShuffleChanged"]);
});

test("Save & Reconnect switches to the new server immediately", () => {
    const first = connected();

    ext.ui.menuCallback();
    const [urlInput, keyInput] = ext.findAll(ext.ui.modal, (n) => n.tagName === "input");
    assert.equal(urlInput.value, "ws://127.0.0.1:9090");
    urlInput.value = "wss://192.168.178.201:9090";
    keyInput.value = "new-secret";
    ext.findAll(ext.ui.modal, (n) => n.tagName === "button")[0].onclick();

    assert.equal(first.readyState, FakeWebSocket.CLOSED);
    assert.equal(ext.latestSocket().url, "wss://192.168.178.201:9090");
    assert.equal(ext.storage.get("spicetify-connect-api:api_key"), "new-secret");
});

test("Save rejects URLs that are not WebSocket URLs", () => {
    connected();

    ext.ui.menuCallback();
    const [urlInput] = ext.findAll(ext.ui.modal, (n) => n.tagName === "input");
    urlInput.value = "http://example.com";
    ext.findAll(ext.ui.modal, (n) => n.tagName === "button")[0].onclick();

    assert.equal(ext.storage.get("spicetify-connect-api:server_url"), "ws://127.0.0.1:9090");
    assert.ok(ext.notifications.at(-1).isError);
    assert.equal(ext.sockets.length, 1);
});

test("reconnects with exponential backoff after the connection drops", async () => {
    const socket = connected({ settings: { "spicetify-connect-api:reconnect_interval": "1000" } });

    socket.serverClose();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(ext.sockets.length, 2);

    ext.latestSocket().serverClose();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(ext.sockets.length, 2, "second retry waits 2 s");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(ext.sockets.length, 3);
});

test("the end of buffering is reported once", async () => {
    const playerData = { ...PLAYER_DATA, isBuffering: true };
    const socket = connected({ playerData });
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.sent.length = 0;

    playerData.isBuffering = false;
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(socket.sent.map((m) => m.eventName), ["BufferingChanged"]);
    assert.equal(socket.sent[0].payload.playerData.isBuffering, false);
});
