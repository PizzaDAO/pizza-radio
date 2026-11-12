const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { validatePlayUrl, decideBusy, createPlayback, parseAllowedHosts } = require('../src/services/playback');

const HOSTS = parseAllowedHosts('r2.example.com, Files.Example.org');
const base = () => ({ channelId: '123456789', clips: [{ url: 'https://acct.r2.example.com/a.ogg', label: 'one' }] });

test('parseAllowedHosts lowercases and trims', () => {
    assert.deepStrictEqual(HOSTS, ['r2.example.com', 'files.example.org']);
});

test('validatePlayUrl accepts allowed https hosts (exact and subdomain)', () => {
    const r = validatePlayUrl(base(), HOSTS);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.tag, 'updates');
    assert.strictEqual(r.value.ifBusy, 'queue');
    assert.strictEqual(r.value.maxWaitMs, 300000);
});

test('validatePlayUrl rejects when the allowlist is empty', () => {
    assert.strictEqual(validatePlayUrl(base(), []).status, 503);
});

test('validatePlayUrl rejects bad hosts, schemes and lookalikes', () => {
    for (const url of [
        'http://acct.r2.example.com/a.ogg',
        'https://evil.com/a.ogg',
        'https://r2.example.com.evil.com/a.ogg',
        'https://notr2.example.com/a.ogg',
        'https://user:pw@r2.example.com/a.ogg',
        'not a url',
    ]) {
        const r = validatePlayUrl({ ...base(), clips: [{ url }] }, HOSTS);
        assert.strictEqual(r.ok, false, url);
        assert.strictEqual(r.status, 400, url);
    }
});

test('validatePlayUrl enforces channelId and clip count', () => {
    assert.strictEqual(validatePlayUrl({ ...base(), channelId: undefined }, HOSTS).ok, false);
    assert.strictEqual(validatePlayUrl({ ...base(), clips: [] }, HOSTS).ok, false);
    const many = Array.from({ length: 9 }, () => base().clips[0]);
    assert.strictEqual(validatePlayUrl({ ...base(), clips: many }, HOSTS).ok, false);
});

test('validatePlayUrl clamps maxWaitMs and normalizes ifBusy', () => {
    const r = validatePlayUrl({ ...base(), maxWaitMs: 99999999, ifBusy: 'skip' }, HOSTS);
    assert.strictEqual(r.value.maxWaitMs, 15 * 60 * 1000);
    assert.strictEqual(r.value.ifBusy, 'skip');
});

test('decideBusy: idle starts, same channel queues, other channel is busy-elsewhere', () => {
    assert.strictEqual(decideBusy({ player: null, connection: null }, 'A', 'queue'), 'start');
    const band = { player: {}, connection: {}, kind: 'band', channelId: 'A' };
    assert.strictEqual(decideBusy(band, 'A', 'queue'), 'queue');
    assert.strictEqual(decideBusy(band, 'A', 'skip'), 'skipped');
    assert.strictEqual(decideBusy(band, 'B', 'queue'), 'busy-elsewhere');
    assert.strictEqual(decideBusy({ player: {}, connection: {}, kind: null }, 'A', 'queue'), 'busy-elsewhere');
    assert.strictEqual(decideBusy({ player: {}, connection: {}, kind: 'url', channelId: 'A' }, 'A', 'queue'), 'start');
});

function harness() {
    const state = { player: null, queue: [], connection: null, kind: null, channelId: null, tag: null, paused: false, clipIndex: 0, clipCount: 0, pending: null };
    const timers = [];
    const log = [];
    let clock = 1000;
    const players = [];
    const mkPlayer = () => {
        const p = new EventEmitter();
        p.played = [];
        p.play = (r) => p.played.push(r);
        p.paused = false;
        p.pause = () => (p.paused = true);
        p.unpause = () => (p.paused = false);
        p.stop = () => p.emit('idle');
        players.push(p);
        return p;
    };
    const mkConn = () => ({ destroyed: false, subscribe() {}, destroy() { this.destroyed = true; }, joinConfig: { channelId: 'A' } });
    const pb = createPlayback({
        state,
        join: async () => mkConn(),
        createPlayer: mkPlayer,
        createResource: (f) => f,
        download: async (url) => ({ path: url, cleanup() { log.push('cleanup ' + url); } }),
        setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimer: (t) => { t.cleared = true; },
        now: () => clock,
        log: () => {},
    });
    return { state, pb, timers, players, log, mkConn, tick: (ms) => (clock += ms) };
}
const req = (n = 3, extra = {}) => ({
    channelId: 'A', tag: 'updates', ifBusy: 'queue', maxWaitMs: 300000, pauseMaxMs: 300000,
    clips: Array.from({ length: n }, (_, i) => ({ url: `c${i}`, label: '' })), ...extra,
});

test('plays clips in order and leaves after the last', async () => {
    const h = harness();
    assert.deepStrictEqual(await h.pb.start(req(2)), { status: 'playing' });
    const p = h.players[0];
    assert.deepStrictEqual(p.played, ['c0']);
    p.emit('idle');
    assert.deepStrictEqual(p.played, ['c0', 'c1']);
    const conn = h.state.connection;
    p.emit('idle');
    assert.strictEqual(conn.destroyed, true);
    assert.strictEqual(h.state.connection, null);
    assert.strictEqual(h.pb.status().kind, null);
});

test('pause, resume and skip act on the url clips and honor the tag', async () => {
    const h = harness();
    await h.pb.start(req(3));
    const p = h.players[0];
    assert.strictEqual(h.pb.pause({ tag: 'other' }).ok, false);
    assert.strictEqual(h.pb.pause({ tag: 'updates' }).ok, true);
    assert.strictEqual(p.paused, true);
    assert.strictEqual(h.pb.status().paused, true);
    p.emit('idle'); // idle while paused must not advance
    assert.deepStrictEqual(p.played, ['c0']);
    assert.strictEqual(h.pb.resume({}).ok, true);
    assert.strictEqual(p.paused, false);
    assert.strictEqual(h.pb.skip({}).ok, true);
    assert.deepStrictEqual(p.played, ['c0', 'c1']);
    assert.strictEqual(h.pb.status().clipIndex, 1);
});

test('pause times out into stop with leave', async () => {
    const h = harness();
    await h.pb.start(req(2));
    const conn = h.state.connection;
    h.pb.pause({});
    const t = h.timers[h.timers.length - 1];
    t.fn();
    assert.strictEqual(conn.destroyed, true);
    assert.strictEqual(h.state.player, null);
});

test('stop with leave disconnects; without leave keeps the connection', async () => {
    const h = harness();
    await h.pb.start(req(2));
    const conn = h.state.connection;
    h.pb.stop({});
    assert.strictEqual(conn.destroyed, false);
    assert.strictEqual(h.state.player, null);
    h.pb.stop({ leave: true });
    assert.strictEqual(conn.destroyed, true);
});

test('stop with a tag does nothing when a band is playing', () => {
    const h = harness();
    const player = Object.assign(new EventEmitter(), { stop() { this.stopped = true; } });
    h.state.player = player;
    h.state.kind = 'band';
    h.state.channelId = 'A';
    assert.deepStrictEqual(h.pb.stop({ tag: 'updates' }), { stopped: false });
    assert.notStrictEqual(h.state.player, null);
    assert.strictEqual(h.pb.stop({}).stopped, true);
});

test('queues behind a band in the same channel and hands off the connection', async () => {
    const h = harness();
    const conn = h.mkConn();
    h.state.player = new EventEmitter();
    h.state.connection = conn;
    h.state.kind = 'band';
    h.state.channelId = 'A';
    assert.deepStrictEqual(await h.pb.start(req(1)), { status: 'queued' });
    assert.strictEqual(h.pb.status().queued, true);
    h.state.player = null; // band finished
    assert.strictEqual(h.pb.handoff(conn), true);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.state.connection, conn);
    assert.deepStrictEqual(h.players[0].played, ['c0']);
    assert.strictEqual(conn.destroyed, false);
});

test('queued clips expire after maxWaitMs', async () => {
    const h = harness();
    h.state.player = new EventEmitter();
    h.state.connection = h.mkConn();
    h.state.kind = 'band';
    h.state.channelId = 'A';
    await h.pb.start(req(1, { maxWaitMs: 1000 }));
    h.tick(2000);
    assert.strictEqual(h.pb.handoff(h.state.connection), false);
    assert.strictEqual(h.state.pending, null);
});

test('busy in another channel is never hijacked', async () => {
    const h = harness();
    h.state.player = new EventEmitter();
    h.state.connection = h.mkConn();
    h.state.kind = 'band';
    h.state.channelId = 'B';
    assert.deepStrictEqual(await h.pb.start(req(1)), { status: 'busy-elsewhere' });
    assert.strictEqual(h.state.kind, 'band');
});

test('ifBusy skip does not queue', async () => {
    const h = harness();
    h.state.player = new EventEmitter();
    h.state.connection = h.mkConn();
    h.state.kind = 'band';
    h.state.channelId = 'A';
    const r = await h.pb.start(req(1, { ifBusy: 'skip' }));
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(h.state.pending, null);
});

test('a failed download leaves existing playback alone and cleans up', async () => {
    const h = harness();
    const pb = createPlayback({
        state: h.state, join: async () => h.mkConn(), createPlayer: () => new EventEmitter(), createResource: (f) => f,
        download: async (u) => { if (u === 'c1') throw new Error('too large'); return { path: u, cleanup() { h.log.push('cleanup ' + u); } }; },
        setTimer: () => ({}), clearTimer() {}, now: () => 0, log() {},
    });
    await assert.rejects(pb.start(req(2)), /too large/);
    assert.deepStrictEqual(h.log, ['cleanup c0']);
    assert.strictEqual(h.state.player, null);
});
