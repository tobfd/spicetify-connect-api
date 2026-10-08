"use strict";

// Loads spicetify-connect-api.js into a sandbox with a fake Spicetify API and a
// fake WebSocket, so the extension can be tested without Spotify or a server.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXTENSION = path.join(__dirname, "..", "spicetify-connect-api.js");

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
    }

    // Test helpers
    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    async receive(message) {
        this.onmessage?.({ data: JSON.stringify(message) });
        // Let asynchronous command handlers (e.g. awaited playUri) finish.
        await new Promise((resolve) => setImmediate(resolve));
    }

    serverClose() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: 1006 });
    }
}

function createElement(tagName) {
    return {
        tagName,
        style: {},
        children: [],
        textContent: "",
        value: "",
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        set innerHTML(_value) {
            throw new Error("innerHTML must not be used");
        }
    };
}

function findAll(node, predicate, found = []) {
    if (predicate(node)) found.push(node);
    for (const child of node.children || []) findAll(child, predicate, found);
    return found;
}

function loadExtension({ playerData = null, settings = {} } = {}) {
    FakeWebSocket.instances = [];
    const calls = [];
    const notifications = [];
    const listeners = {};
    const storage = new Map(Object.entries({
        "spicetify-connect-api:server_url": "ws://127.0.0.1:9090",
        "spicetify-connect-api:api_key": "secret",
        ...settings
    }));
    const player = {
        volume: 0.42,
        heart: true,
        repeat: 0,
        shuffle: false,
        progress: 5000,
        playUriError: null
    };
    const record = (name) => (...args) => calls.push({ name, args });
    const ui = { menuCallback: null, modal: null };

    const Spicetify = {
        Player: {
            data: playerData,
            play: record("play"),
            pause: record("pause"),
            togglePlay: record("togglePlay"),
            next: record("next"),
            back: record("back"),
            seek: record("seek"),
            setVolume: (level) => { player.volume = level; calls.push({ name: "setVolume", args: [level] }); },
            setRepeat: record("setRepeat"),
            setShuffle: record("setShuffle"),
            setMute: record("setMute"),
            setHeart: (value) => { player.heart = value; calls.push({ name: "setHeart", args: [value] }); },
            getHeart: () => player.heart,
            getMute: () => false,
            getProgress: () => player.progress,
            getVolume: () => player.volume,
            isPlaying: () => true,
            getShuffle: () => player.shuffle,
            getRepeat: () => player.repeat,
            playUri: async (uri) => {
                calls.push({ name: "playUri", args: [uri] });
                if (player.playUriError) throw new Error(player.playUriError);
            },
            addEventListener: (type, callback) => {
                (listeners[type] ||= []).push(callback);
            }
        },
        Platform: {
            PlayerAPI: { seekTo: async (ms) => calls.push({ name: "PlayerAPI.seekTo", args: [ms] }) }
        },
        LocalStorage: {
            get: (key) => (storage.has(key) ? storage.get(key) : null),
            set: (key, value) => storage.set(key, String(value))
        },
        Menu: {
            Item: class {
                constructor(_name, _enabled, onClick) { ui.menuCallback = onClick; }
                register() {}
            }
        },
        PopupModal: {
            display: ({ content }) => { ui.modal = content; },
            hide: () => { ui.modal = null; }
        },
        showNotification: (text, isError = false) => notifications.push({ text, isError }),
        React: {},
        ReactDOM: {},
        URI: {}
    };

    const timers = new Set();
    const track = (create, clear) => [
        (...args) => { const id = create(...args); timers.add({ id, clear }); return id; },
        clear
    ];
    const [trackedSetTimeout, trackedClearTimeout] = track(setTimeout, clearTimeout);
    const [trackedSetInterval, trackedClearInterval] = track(setInterval, clearInterval);

    const context = vm.createContext({
        Spicetify,
        window: { Spicetify },
        document: { createElement },
        console: { log() {}, info() {}, warn() {}, error() {} },
        WebSocket: FakeWebSocket,
        URL,
        Blob,
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClearTimeout,
        setInterval: trackedSetInterval,
        clearInterval: trackedClearInterval
    });
    vm.runInContext(fs.readFileSync(EXTENSION, "utf8"), context, { filename: EXTENSION });

    return {
        calls,
        notifications,
        listeners,
        storage,
        player,
        ui,
        sockets: FakeWebSocket.instances,
        latestSocket: () => FakeWebSocket.instances.at(-1),
        callsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
        findAll,
        dispose: () => {
            for (const { id, clear } of timers) clear(id);
        }
    };
}

module.exports = { loadExtension, FakeWebSocket };
