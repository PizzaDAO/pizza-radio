const express = require('express');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const state = require('./state');
const { startMixtape } = require('./services/mixtape-service');
const { CREWS, crewFolder } = require('./commands/crew');
const os = require('os');
const { createPlayback, validatePlayUrl, parseAllowedHosts } = require('./services/playback');

// Download a clip to a temp file (size-capped) so a slow stream can't stall playback.
async function downloadClip(url, maxBytes) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!res.ok) throw new Error(`clip download failed: ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('clip too large');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('clip too large');
        chunks.push(Buffer.from(chunk));
    }
    const file = path.join(os.tmpdir(), `clip-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    return { path: file, cleanup: () => fs.rmSync(file, { force: true }) };
}

function createApiServer(client) {
    const app = express();
    app.use(express.json());

    const API_KEY = process.env.PIZZA_RADIO_API_KEY;
    const PORT = process.env.PORT || process.env.API_PORT || 3000;
    const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
    const GUILD_ID = process.env.DISCORD_GUILD_ID;
    const allowedHosts = parseAllowedHosts(process.env.PLAY_URL_ALLOWED_HOSTS);

    const playback = createPlayback({
        state,
        join: async (channelId) => {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error('Guild not found');
            const connection = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
            if (connection.state.status !== VoiceConnectionStatus.Ready) {
                await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
            }
            return connection;
        },
        createPlayer: () => createAudioPlayer(),
        createResource: (file) => createAudioResource(file, { inputType: StreamType.OggOpus }),
        download: downloadClip,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        now: Date.now,
        idleEvent: AudioPlayerStatus.Idle,
        log: (m) => console.log(`[play-url] ${m}`),
    });

    // Health check (no auth required)
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    // Auth middleware for all other routes
    app.use((req, res, next) => {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${API_KEY}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });

    // Start mixtape
    app.post('/start-mixtape', async (req, res) => {
        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) {
                return res.status(500).json({ error: 'Guild not found' });
            }

            const channelId = req.body.channelId || VOICE_CHANNEL_ID;
            const voiceChannel = guild.channels.cache.get(channelId);
            if (!voiceChannel) {
                return res.status(400).json({ error: 'Voice channel not found' });
            }

            const connection = joinVoiceChannel({
                channelId: channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });

            const result = await startMixtape(connection);
            res.json(result);
        } catch (err) {
            console.error('API /start-mixtape error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Play crew theme song
    app.post('/play-crew', async (req, res) => {
        try {
            const { crew } = req.body;
            if (!crew) {
                return res.status(400).json({ error: 'Missing "crew" field in request body', validCrews: CREWS });
            }
            // The end-of-call song comes from the call recorder, which always names the call's voice channel.
            // Requests without one (the old Apps Script song timer) are ignored so the song never plays twice.
            if (!req.body.channelId && process.env.PLAY_CREW_REQUIRE_CHANNEL !== 'off') {
                console.log(`Ignored /play-crew for "${crew}" without a channelId`);
                return res.status(409).json({ error: 'channelId is required' });
            }

            // Case-insensitive crew lookup
            const matchedCrew = CREWS.find(c => c.toLowerCase() === crew.toLowerCase());
            if (!matchedCrew) {
                return res.status(400).json({ error: `Invalid crew "${crew}"`, validCrews: CREWS });
            }

            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) {
                return res.status(500).json({ error: 'Guild not found' });
            }

            const channelId = req.body.channelId || VOICE_CHANNEL_ID;
            const voiceChannel = guild.channels.cache.get(channelId);
            if (!voiceChannel) {
                return res.status(400).json({ error: 'Voice channel not found' });
            }

            // Resolve crew song folder and find audio files
            const targetFolder = path.join(crewFolder, matchedCrew);
            if (!fs.existsSync(targetFolder)) {
                return res.status(404).json({ error: `No song folder found for crew "${matchedCrew}"` });
            }

            const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
            const allFiles = fs.readdirSync(targetFolder).filter(file =>
                supportedExtensions.includes(path.extname(file).toLowerCase())
            );

            if (allFiles.length === 0) {
                return res.status(404).json({ error: `No audio files found for crew "${matchedCrew}"` });
            }

            // Stop any existing playback
            if (state.player) {
                state.player.removeAllListeners();
                state.player.stop();
                state.player = null;
            }
            state.queue = [];

            // Join voice channel
            const connection = joinVoiceChannel({
                channelId: channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });
            state.connection = connection;

            // Wait for connection to be ready
            if (connection.state.status !== VoiceConnectionStatus.Ready) {
                await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
            }

            // Create player and play crew theme
            const player = createAudioPlayer();
            state.player = player;
            state.kind = 'crew';
            state.channelId = channelId;
            state.tag = null;

            const songFile = allFiles[0];
            const songName = path.parse(songFile).name;
            const resource = createAudioResource(path.join(targetFolder, songFile));

            // Auto-stop and disconnect when song finishes
            player.once(AudioPlayerStatus.Idle, () => {
                console.log(`Crew theme for "${matchedCrew}" finished, disconnecting.`);
                player.stop();
                state.player = null;
                state.kind = null;
                state.channelId = null;
                if (playback.handoff(connection)) return;
                if (state.connection) {
                    state.connection.destroy();
                    state.connection = null;
                }
            });

            // Error handler also cleans up
            player.once('error', (error) => {
                console.error(`Error playing crew theme for "${matchedCrew}":`, error);
                player.stop();
                state.player = null;
                if (state.connection) {
                    state.connection.destroy();
                    state.connection = null;
                }
            });

            connection.subscribe(player);
            player.play(resource);

            res.json({
                success: true,
                crew: matchedCrew,
                song: songName,
                message: `Now playing ${matchedCrew} crew theme: ${songName}`,
            });
        } catch (err) {
            console.error('API /play-crew error:', err);
            // Clean up on unexpected error
            if (state.player) {
                state.player.removeAllListeners();
                state.player.stop();
                state.player = null;
            }
            if (state.connection) {
                state.connection.destroy();
                state.connection = null;
            }
            res.status(500).json({ error: err.message });
        }
    });

    // Play the house band folder in random order, like /band. Keeps reshuffling until /stop,
    // or with { maxSongs: n } leaves the channel after n songs.
    app.post('/play-band', async (req, res) => {
        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) {
                return res.status(500).json({ error: 'Guild not found' });
            }

            const channelId = req.body.channelId || VOICE_CHANNEL_ID;
            const voiceChannel = guild.channels.cache.get(channelId);
            if (!voiceChannel) {
                return res.status(400).json({ error: 'Voice channel not found' });
            }

            const bandFolder = path.join(__dirname, '../songs/band');
            if (!fs.existsSync(bandFolder)) {
                return res.status(404).json({ error: 'No band song folder found' });
            }

            const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
            const allFiles = fs.readdirSync(bandFolder).filter(file =>
                supportedExtensions.includes(path.extname(file).toLowerCase())
            );
            if (allFiles.length === 0) {
                return res.status(404).json({ error: 'No audio files found for the band' });
            }

            const shuffle = (array) => {
                for (let i = array.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [array[i], array[j]] = [array[j], array[i]];
                }
                return array;
            };

            // Stop any existing playback
            if (state.player) {
                state.player.removeAllListeners();
                state.player.stop();
                state.player = null;
            }
            state.queue = shuffle([...allFiles]);

            const connection = joinVoiceChannel({
                channelId: channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });
            state.connection = connection;

            if (connection.state.status !== VoiceConnectionStatus.Ready) {
                await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
            }

            const player = createAudioPlayer();
            state.player = player;
            state.kind = 'band';
            state.channelId = channelId;
            state.tag = null;

            const maxSongs = Number.isInteger(req.body.maxSongs) && req.body.maxSongs > 0 ? req.body.maxSongs : null;
            let played = 0;

            const playNextSong = () => {
                if (maxSongs !== null && played >= maxSongs) {
                    console.log(`Band played ${played} song(s), disconnecting.`);
                    player.removeAllListeners();
                    player.stop();
                    if (state.player === player) {
                        state.player = null;
                        state.kind = null;
                        state.channelId = null;
                        // Queued updates in this channel take over the connection instead of leaving.
                        if (playback.handoff(connection)) return;
                    }
                    if (state.connection === connection) {
                        connection.destroy();
                        state.connection = null;
                    }
                    return;
                }
                played++;
                if (state.queue.length === 0) {
                    state.queue = shuffle([...allFiles]);
                }
                const nextSong = state.queue.shift();
                console.log(`Playing: ${nextSong}`);
                player.play(createAudioResource(path.join(bandFolder, nextSong)));
            };

            player.on(AudioPlayerStatus.Idle, playNextSong);
            player.on('error', (error) => {
                console.error('Error during band playback:', error);
                playNextSong();
            });

            connection.subscribe(player);
            playNextSong();

            res.json({ success: true, maxSongs, message: 'Playing the PizzaDAO House Band in random order' });
        } catch (err) {
            console.error('API /play-band error:', err);
            if (state.player) {
                state.player.removeAllListeners();
                state.player.stop();
                state.player = null;
            }
            if (state.connection) {
                state.connection.destroy();
                state.connection = null;
            }
            res.status(500).json({ error: err.message });
        }
    });

    // Stop playback. Default: stop the player and stay (as before). With { leave: true } (body or ?leave=1)
    // also disconnect. With { tag } only stop url clips of that tag.
    app.post('/stop', async (req, res) => {
        try {
            const body = req.body || {};
            const leave = body.leave === true || req.query.leave === '1';
            const tag = typeof body.tag === 'string' && body.tag ? body.tag : null;
            const result = playback.stop({ leave, tag });
            res.json({ success: true, stopped: result.stopped, left: leave && !state.connection, message: 'Playback stopped' });
        } catch (err) {
            console.error('API /stop error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Play pre-rendered audio clips (Ogg/Opus) from allowed hosts, e.g. spoken call updates.
    app.post('/play-url', async (req, res) => {
        try {
            const v = validatePlayUrl(req.body, allowedHosts);
            if (!v.ok) return res.status(v.status).json({ error: v.error });
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(500).json({ error: 'Guild not found' });
            if (!guild.channels.cache.get(v.value.channelId)) {
                return res.status(400).json({ error: 'Voice channel not found' });
            }
            const result = await playback.start(v.value);
            if (result.status === 'busy-elsewhere') {
                return res.status(409).json({ error: 'busy-elsewhere' });
            }
            res.json({ success: true, ...result, clips: v.value.clips.length });
        } catch (err) {
            console.error('API /play-url error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    const controlOpts = (req) => ({
        tag: typeof (req.body || {}).tag === 'string' && req.body.tag ? req.body.tag : null,
        pauseMaxMs: Number((req.body || {}).pauseMaxMs) > 0 ? Number(req.body.pauseMaxMs) : null,
    });
    for (const action of ['pause', 'resume', 'skip']) {
        app.post(`/${action}`, (req, res) => {
            try {
                const result = playback[action](controlOpts(req));
                if (!result.ok) return res.status(409).json({ error: result.reason });
                res.json({ success: true, ...result });
            } catch (err) {
                console.error(`API /${action} error:`, err);
                res.status(500).json({ error: err.message });
            }
        });
    }

    app.get('/status', (req, res) => {
        res.json(playback.status());
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Pizza Radio API listening on port ${PORT}`);
    });

    return app;
}

module.exports = { createApiServer };
