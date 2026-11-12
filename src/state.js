// src/state.js

module.exports = {
    player: null,
    queue: [],
    connection: null,
    // Playback bookkeeping used by the API (src/services/playback.js). Older slash commands
    // leave these unset, which reads as kind "other" in /status.
    kind: null, // 'band' | 'crew' | 'url' | null
    channelId: null,
    tag: null,
    paused: false,
    clipIndex: 0,
    clipCount: 0,
    pending: null,
    starting: false,
    files: [],
    pauseTimer: null,
    pendingTimer: null, // clips queued behind a band / crew song in the same channel
};
