const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const state = require('../state'); // Import shared state
const { takeOver } = require('../services/playback');

const targetFolder = path.join(__dirname, '../../songs/band');

// Function to shuffle an array
const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('band')
        .setDescription('Plays songs from the Pizza Collection PizzaDAO House Band folder in random order'),

    async execute(interaction) {
        try {
            // Check if the folder exists
            if (!fs.existsSync(targetFolder)) {
                await interaction.reply('The folder does not exist. Please make sure the songs are in the correct location.');
                return;
            }

            // Get the list of supported audio files
            const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
            const allFiles = fs.readdirSync(targetFolder).filter(file =>
                supportedExtensions.includes(path.extname(file).toLowerCase())
            );

            if (allFiles.length === 0) {
                await interaction.reply('The folder is empty or contains unsupported file types. Add some songs to the folder first.');
                return;
            }

            // Shuffle the songs and store them in the queue
            state.queue = shuffleArray([...allFiles]);

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
                // If the queue is empty, reshuffle and replay
                if (state.queue.length === 0) {
                    console.log('Reshuffling the playlist...');
                    state.queue = shuffleArray([...allFiles]); // Reshuffle all songs
                }

                const nextSong = state.queue.shift(); // Get the next song
                const resource = createAudioResource(path.join(targetFolder, nextSong));

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
            await interaction.reply('🎵 Playing songs from the Pizza Collection PizzaDAO House Band folder in random order!');
        } catch (error) {
            console.error('Error executing the band command:', error);
            await interaction.reply('There was an error trying to play the songs.');
        }
    },
};
