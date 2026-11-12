const { SlashCommandBuilder } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const state = require('../state');
const { takeOver } = require('../services/playback');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stops the current song and disconnects the bot from the voice channel'),

    async execute(interaction) {
        console.log(`Executing /stop command for user ${interaction.user.tag}`);

        try {
            const guildId = interaction.guild.id;

            // Get the existing voice connection
            const connection = getVoiceConnection(guildId);
            if (!connection) {
                await interaction.reply('I am not currently connected to a voice channel in this server.');
                return;
            }

            // Destroy the connection
            connection.destroy();

            // Keep the shared state consistent: nothing is playing or connected any more.
            if (state.player) {
                state.player.removeAllListeners();
                state.player.stop();
                state.player = null;
            }
            state.connection = null;
            state.queue = [];
            takeOver(state);

            // If there's a player associated with this guild, stop it (this assumes you're using a shared audioPlayers Map)
            if (interaction.client.audioPlayers && interaction.client.audioPlayers.has(guildId)) {
                const player = interaction.client.audioPlayers.get(guildId);
                player.stop();
                interaction.client.audioPlayers.delete(guildId); // Remove player from the Map
            }

            await interaction.reply('🛑 Stopped the music and disconnected from the voice channel.');
            console.log(`Stopped music and disconnected from guild ${guildId}.`);
        } catch (error) {
            console.error('Error executing /stop command:', error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp('There was an error trying to stop the music.');
            } else {
                await interaction.reply('There was an error trying to stop the music.');
            }
        }
    },
};
