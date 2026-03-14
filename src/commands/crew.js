const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const state = require('../state');

const crewFolder = path.join(__dirname, '../../songs/Crew');

const CREWS = [
    'Amore', 'Art', 'Biz Dev', 'Comms', 'Events', 'Finance',
    'Governance', 'Mafia', 'Merch', 'Ops', 'Real Estate', 'Tech',
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crew')
        .setDescription('Plays a crew theme song')
        .addStringOption(option =>
            option
                .setName('name')
                .setDescription('Which crew?')
                .setRequired(true)
                .addChoices(...CREWS.map(c => ({ name: c, value: c })))
        ),

    async execute(interaction) {
        try {
            const crewName = interaction.options.getString('name');
            const targetFolder = path.join(crewFolder, crewName);

            if (!fs.existsSync(targetFolder)) {
                await interaction.reply(`No songs found for crew "${crewName}".`);
                return;
            }

            const supportedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];
            const allFiles = fs.readdirSync(targetFolder).filter(file =>
                supportedExtensions.includes(path.extname(file).toLowerCase())
            );

            if (allFiles.length === 0) {
                await interaction.reply(`No audio files found for crew "${crewName}".`);
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

            state.player.on('error', (error) => {
                console.error(`Error playing crew song:`, error);
            });

            state.connection.subscribe(state.player);
            state.player.play(resource);

            await interaction.reply(`🎵 Now playing **${crewName}** crew theme: **${songName}**`);
        } catch (error) {
            console.error('Error executing the crew command:', error);
            await interaction.reply('There was an error trying to play the crew song.');
        }
    },
};
