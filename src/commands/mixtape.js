const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const { startMixtape } = require('../services/mixtape-service');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mixtape')
        .setDescription('Plays songs from the PizzaDAO Mixtape folder in random order'),

    async execute(interaction) {
        try {
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.reply('You need to be in a voice channel to play music!');
                return;
            }

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            const result = await startMixtape(connection);

            if (!result.success) {
                await interaction.reply(result.error);
                return;
            }

            await interaction.reply(`🎵 Playing ${result.songCount} songs from the PizzaDAO Mixtape in random order!`);
        } catch (error) {
            console.error('Error executing the mixtape command:', error);
            await interaction.reply('There was an error trying to play the songs.');
        }
    },
};
