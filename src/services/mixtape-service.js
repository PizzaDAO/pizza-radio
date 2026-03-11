const { createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const state = require('../state');

const defaultMixtapeFolder = path.join(__dirname, '../../songs/mixtape');

const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

async function startMixtape(connection, options = {}) {
    const folder = options.folder || defaultMixtapeFolder;

    if (!fs.existsSync(folder)) {
        return { success: false, error: 'Mixtape folder does not exist' };
    }

    const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
    const allFiles = fs.readdirSync(folder).filter(file =>
        supportedExtensions.includes(path.extname(file).toLowerCase())
    );

    if (allFiles.length === 0) {
        return { success: false, error: 'No songs found in mixtape folder' };
    }

    // Stop existing player if any
    if (state.player) {
        state.player.removeAllListeners();
        state.player.stop();
        state.player = null;
    }

    const allFilesCopy = [...allFiles];
    state.queue = shuffleArray([...allFiles]);
    state.connection = connection;
    state.player = createAudioPlayer();

    const playNextSong = () => {
        if (state.queue.length === 0) {
            // Reshuffle and loop
            state.queue = shuffleArray([...allFilesCopy]);
        }

        const nextSong = state.queue.shift();
        const resource = createAudioResource(path.join(folder, nextSong));
        console.log(`Playing: ${nextSong}`);
        state.player.play(resource);
    };

    state.player.on(AudioPlayerStatus.Idle, playNextSong);
    state.player.on('error', (error) => {
        console.error('Error during playback:', error);
        playNextSong();
    });

    connection.subscribe(state.player);
    playNextSong();

    return { success: true, songCount: allFiles.length, message: `Playing ${allFiles.length} songs from mixtape` };
}

module.exports = { startMixtape, shuffleArray };
