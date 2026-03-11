const express = require('express');
const { joinVoiceChannel } = require('@discordjs/voice');
const { startMixtape } = require('./services/mixtape-service');

function createApiServer(client) {
    const app = express();
    app.use(express.json());

    const API_KEY = process.env.PIZZA_RADIO_API_KEY;
    const PORT = process.env.API_PORT || 3000;
    const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
    const GUILD_ID = process.env.DISCORD_GUILD_ID;

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

    // Stop playback
    app.post('/stop', async (req, res) => {
        try {
            const state = require('./state');
            if (state.player) {
                state.player.removeAllListeners();
                state.player.stop();
                state.player = null;
            }
            state.queue = [];
            res.json({ success: true, message: 'Playback stopped' });
        } catch (err) {
            console.error('API /stop error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Pizza Radio API listening on port ${PORT}`);
    });

    return app;
}

module.exports = { createApiServer };
