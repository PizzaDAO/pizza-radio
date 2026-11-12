// Playback controller for /play-url, /pause, /resume, /skip, /status and /stop.
// Everything that touches Discord or the network is injected, so it can be tested with node:test.

const MAX_CLIPS = 8;
const MAX_CLIP_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;
const MAX_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_PAUSE_MAX_MS = 5 * 60 * 1000;
const MAX_PAUSE_MAX_MS = 15 * 60 * 1000;

function parseAllowedHosts(value) {
    return String(value || '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
}

function hostAllowed(host, allowedHosts) {
    const h = String(host || '').toLowerCase();
    // An entry matches the host exactly or as a parent domain ("r2.example.com" matches "acct.r2.example.com").
    return allowedHosts.some((a) => h === a || h.endsWith('.' + a));
}

// Validate a /play-url body. Returns { ok: true, value } or { ok: false, status, error }.
function validatePlayUrl(body, allowedHosts) {
    const b = body || {};
    if (!allowedHosts || allowedHosts.length === 0) {
        return { ok: false, status: 503, error: 'PLAY_URL_ALLOWED_HOSTS is not configured' };
    }
    if (typeof b.channelId !== 'string' || !/^\d{5,25}$/.test(b.channelId)) {
        return { ok: false, status: 400, error: 'channelId is required' };
    }
    if (!Array.isArray(b.clips) || b.clips.length === 0) {
        return { ok: false, status: 400, error: 'clips must be a non-empty array' };
    }
    if (b.clips.length > MAX_CLIPS) {
        return { ok: false, status: 400, error: `at most ${MAX_CLIPS} clips` };
    }
    const clips = [];
    for (const c of b.clips) {
        let u;
        try {
            u = new URL(c && c.url);
        } catch {
            return { ok: false, status: 400, error: 'invalid clip url' };
        }
        if (u.protocol !== 'https:') return { ok: false, status: 400, error: 'clip urls must be https' };
        if (u.username || u.password) return { ok: false, status: 400, error: 'invalid clip url' };
        if (!hostAllowed(u.hostname, allowedHosts)) return { ok: false, status: 400, error: 'clip host not allowed' };
        clips.push({ url: u.toString(), label: String((c && c.label) || '').slice(0, 80) });
    }
    const ifBusy = b.ifBusy === 'skip' ? 'skip' : 'queue';
    const clamp = (n, def, max) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def);
    return {
        ok: true,
        value: {
            channelId: b.channelId,
            clips,
            tag: typeof b.tag === 'string' && b.tag ? b.tag.slice(0, 32) : 'updates',
            ifBusy,
            maxWaitMs: clamp(b.maxWaitMs, DEFAULT_MAX_WAIT_MS, MAX_MAX_WAIT_MS),
            pauseMaxMs: clamp(b.pauseMaxMs, DEFAULT_PAUSE_MAX_MS, MAX_PAUSE_MAX_MS),
        },
    };
}

function currentChannel(state) {
    return state.channelId || (state.connection && state.connection.joinConfig && state.connection.joinConfig.channelId) || null;
}

function isBusy(state) {
    return !!(state.player || state.connection);
}

// What to do with a request for `channelId` given what is playing right now.
// 'start' | 'queue' | 'skipped' | 'busy-elsewhere'
function decideBusy(state, channelId, ifBusy) {
    if (!isBusy(state)) return 'start';
    const ch = currentChannel(state);
    // Another channel, or an older slash command whose channel we can't tell: never hijack.
    if (!ch || ch !== channelId) return 'busy-elsewhere';
    // New clips replace earlier url clips in the same channel.
    if (state.kind === 'url') return 'start';
    return ifBusy === 'skip' ? 'skipped' : 'queue';
}

function createPlayback(deps) {
    const { state, join, createPlayer, createResource, download, setTimer, clearTimer, now, log } = deps;
    const IDLE = deps.idleEvent || 'idle';
    let files = [];
    let pauseTimer = null;
    let pendingTimer = null;

    const cleanupFiles = () => {
        for (const f of files) {
            try {
                f.cleanup();
            } catch {
                /* ignore */
            }
        }
        files = [];
    };

    const clearPending = () => {
        state.pending = null;
        if (pendingTimer) clearTimer(pendingTimer);
        pendingTimer = null;
    };

    const clearPause = () => {
        if (pauseTimer) clearTimer(pauseTimer);
        pauseTimer = null;
        state.paused = false;
    };

    function reset() {
        clearPause();
        state.kind = null;
        state.channelId = null;
        state.tag = null;
        state.clipIndex = 0;
        state.clipCount = 0;
        cleanupFiles();
    }

    function stopPlayer() {
        if (state.player) {
            state.player.removeAllListeners();
            state.player.stop(true);
            state.player = null;
        }
    }

    function destroyConnection() {
        if (state.connection) {
            try {
                state.connection.destroy();
            } catch {
                /* ignore */
            }
            state.connection = null;
        }
    }

    // Stop whatever is playing. With leave, also disconnect. With tag, only acts on url clips of that tag.
    function stop({ leave = false, tag = null } = {}) {
        if (tag && !(state.kind === 'url' && state.tag === tag)) return { stopped: false };
        const had = isBusy(state) || !!state.pending;
        stopPlayer();
        state.queue = [];
        clearPending();
        reset();
        if (leave) destroyConnection();
        return { stopped: had };
    }

    function finish() {
        log('clips finished, leaving');
        stopPlayer();
        reset();
        destroyConnection();
    }

    async function run(req, existingConnection) {
        const downloaded = [];
        try {
            for (const c of req.clips) downloaded.push(await download(c.url, MAX_CLIP_BYTES));
        } catch (err) {
            for (const d of downloaded) d.cleanup();
            throw err;
        }
        // Replace any earlier clips now that the new audio is in hand.
        stopPlayer();
        cleanupFiles();
        files = downloaded;
        state.queue = [];
        const connection = existingConnection || (await join(req.channelId));
        state.connection = connection;
        state.kind = 'url';
        state.channelId = req.channelId;
        state.tag = req.tag;
        state.clipIndex = 0;
        state.clipCount = downloaded.length;
        state.paused = false;
        state.pauseMaxMs = req.pauseMaxMs;
        const player = createPlayer();
        state.player = player;
        const playIndex = (i) => {
            if (state.player !== player) return;
            if (i >= downloaded.length) return finish();
            state.clipIndex = i;
            player.play(createResource(downloaded[i].path));
        };
        player.on(IDLE, () => {
            if (state.paused) return;
            playIndex(state.clipIndex + 1);
        });
        player.on('error', (err) => {
            log('clip playback error: ' + (err && err.message));
            playIndex(state.clipIndex + 1);
        });
        connection.subscribe(player);
        playIndex(0);
    }

    async function start(req) {
        const decision = decideBusy(state, req.channelId, req.ifBusy);
        if (decision === 'busy-elsewhere') return { status: 'busy-elsewhere' };
        if (decision === 'skipped') return { status: 'skipped', reason: 'busy' };
        if (decision === 'queue') {
            // Behind the band / crew song in the same channel. The newest request wins.
            clearPending();
            state.pending = { ...req, expiresAt: now() + req.maxWaitMs };
            pendingTimer = setTimer(() => {
                if (state.pending) log('queued clips expired');
                state.pending = null;
                pendingTimer = null;
            }, req.maxWaitMs);
            return { status: 'queued' };
        }
        await run(req, null);
        return { status: 'playing' };
    }

    // Called when the band or crew song ends in a channel and is about to leave. Returns true if queued
    // clips took over the connection (so the caller must not destroy it).
    function handoff(connection) {
        const p = state.pending;
        if (!p || now() > p.expiresAt) {
            clearPending();
            return false;
        }
        clearPending();
        run(p, connection).catch((err) => {
            log('handoff failed: ' + (err && err.message));
            stop({ leave: true });
        });
        return true;
    }

    function ownsUrl(tag) {
        return state.kind === 'url' && !!state.player && (!tag || state.tag === tag);
    }

    function pause({ tag = null, pauseMaxMs = null } = {}) {
        if (!ownsUrl(tag)) return { ok: false, reason: 'nothing-playing' };
        if (state.paused) return { ok: true, paused: true };
        state.player.pause(true);
        state.paused = true;
        const ms = pauseMaxMs || state.pauseMaxMs || DEFAULT_PAUSE_MAX_MS;
        pauseTimer = setTimer(() => {
            log('pause timed out, stopping');
            stop({ leave: true });
        }, ms);
        return { ok: true, paused: true };
    }

    function resume({ tag = null } = {}) {
        if (!ownsUrl(tag)) return { ok: false, reason: 'nothing-playing' };
        if (!state.paused) return { ok: true, paused: false };
        if (pauseTimer) clearTimer(pauseTimer);
        pauseTimer = null;
        state.paused = false;
        state.player.unpause();
        return { ok: true, paused: false };
    }

    function skip({ tag = null } = {}) {
        if (!ownsUrl(tag)) return { ok: false, reason: 'nothing-playing' };
        if (state.paused) clearPause();
        // Stopping the player raises Idle, which advances to the next clip (or finishes after the last).
        state.player.stop(true);
        return { ok: true };
    }

    function status() {
        const busy = isBusy(state);
        return {
            channelId: busy ? currentChannel(state) : null,
            kind: !busy ? null : state.kind || 'other',
            tag: state.kind === 'url' ? state.tag : null,
            paused: !!state.paused,
            clipIndex: state.clipIndex || 0,
            clipCount: state.clipCount || 0,
            queued: !!state.pending,
        };
    }

    return { start, handoff, pause, resume, skip, stop, status };
}

module.exports = {
    createPlayback,
    validatePlayUrl,
    decideBusy,
    parseAllowedHosts,
    hostAllowed,
    MAX_CLIPS,
    MAX_CLIP_BYTES,
};
