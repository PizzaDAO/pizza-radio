const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const state = require('../state');
const { takeOver } = require('../services/playback'); // Import shared state

const targetFolder = path.join(__dirname, '../../songs/lobo');

// Function to get audio files from a folder recursively
const getAudioFilesRecursively = (folder, supportedExtensions) => {
    let files = [];
    fs.readdirSync(folder, { withFileTypes: true }).forEach((entry) => {
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(getAudioFilesRecursively(fullPath, supportedExtensions));
        } else if (supportedExtensions.includes(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    });
    return files;
};

// Function to get subfolders and their names
const getSubfolders = () => {
    return fs.readdirSync(targetFolder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
            name: entry.name,
            path: path.join(targetFolder, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lobo')
        .setDescription('Plays songs from the lobo folder randomly or by specific album')
        .addIntegerOption((option) =>
            option
                .setName('album')
                .setDescription('Specify the album number (1, 2, or 3)')
                .setMinValue(1)
                .setMaxValue(3)
        ),

    async execute(interaction) {
        try {
            // Check if the folder exists
            if (!fs.existsSync(targetFolder)) {
                await interaction.reply('The folder does not exist. Please make sure the songs are in the correct location.');
                return;
            }

            // Get subfolders and album info
            const subfolders = getSubfolders();

            // Determine album folder and playback order
            const albumId = interaction.options.getInteger('album');
            let playFolder = targetFolder;
            let playOrder = 'random';
            let albumName = 'all songs';

            if (albumId) {
                const album = subfolders[albumId - 1];
                if (!album) {
                    await interaction.reply(`Album ${albumId} does not exist. Please choose a valid album number (1, 2, or 3).`);
                    return;
                }
                playFolder = album.path;
                albumName = album.name;
                playOrder = 'ordered';
            }

            // Get the list of supported audio files
            const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
            let allFiles = getAudioFilesRecursively(playFolder, supportedExtensions);

            if (allFiles.length === 0) {
                await interaction.reply('The folder is empty or contains unsupported file types. Add some songs to the folder first.');
                return;
            }

            // Handle playback order
            if (playOrder === 'random') {
                allFiles = allFiles.sort(() => Math.random() - 0.5); // Shuffle for random playback
            }

            // Store the files in the queue
            state.queue = [...allFiles];

            // Check if the user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.reply('You need to be in a voice channel to play music!');
                return;
            }

            // Join the voice channel
            takeOver(state, { kind: null, channelId: voiceChannel.id });
            state.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            // Create an audio player
            state.player = createAudioPlayer();

            // Function to play the next song in the queue
            const playNextSong = () => {
                if (state.queue.length === 0) {
                    console.log('Finished all songs.');
                    return;
                }

                const nextSong = state.queue.shift();
                const resource = createAudioResource(nextSong);

                console.log(`Playing: ${nextSong}`);
                state.player.play(resource);
            };

            // Handle the player when it goes idle
            state.player.on(AudioPlayerStatus.Idle, playNextSong);

            // Handle errors during playback
            state.player.on('error', (error) => {
                console.error('Error during playback:', error);
                playNextSong(); // Skip to the next song
            });

            // Subscribe the player to the voice connection
            state.connection.subscribe(state.player);

            // Start playing the first song
            playNextSong();

            // Inform the user that playback has started
            const playbackMessage = albumId
                ? `🎵 Playing Album ${albumId} (${albumName}) from the songs/lobo folder in order!`
                : '🎵 Playing all songs from the songs/lobo folder in random order!';
            await interaction.reply(playbackMessage);
        } catch (error) {
            console.error('Error executing the lobo command:', error);
            await interaction.reply('There was an error trying to play the songs.');
        }
    },
};
