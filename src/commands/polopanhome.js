const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const state = require('../state');

const targetFolder = path.join(__dirname, '../../songs/polopanhome');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('polopanhome')
        .setDescription('Plays POLO & PAN — Home Sweet Home (the mixtape)'),

    async execute(interaction) {
        try {
            state.cleanup();

            const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
            const allFiles = fs.readdirSync(targetFolder).filter(file =>
                supportedExtensions.includes(path.extname(file).toLowerCase())
            );

            if (allFiles.length === 0) {
                await interaction.reply('No songs found.');
                return;
            }

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.reply('You need to be in a voice channel to play music!');
                return;
            }

            state.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            state.player = createAudioPlayer();

            const songFile = allFiles[0];
            const resource = createAudioResource(path.join(targetFolder, songFile));
            const songName = path.parse(songFile).name;

            state.player.on(AudioPlayerStatus.Idle, () => {
                console.log('POLO & PAN mixtape finished, disconnecting.');
                state.connection.destroy();
            });

            state.player.on('error', (error) => {
                console.error('Error playing POLO & PAN:', error);
                state.connection.destroy();
            });

            state.connection.subscribe(state.player);
            state.player.play(resource);

            await interaction.reply(`🎧 Now playing **${songName}**`);
        } catch (error) {
            console.error('Error executing the polopanhome command:', error);
            await interaction.reply('There was an error trying to play POLO & PAN.');
        }
    },
};
