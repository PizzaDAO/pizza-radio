require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const { SlashCommandBuilder } = require('discord.js');
const { createApiServer } = require('./api');

// Create a new Discord client with necessary intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // If you plan to handle message-based commands
    ]
});

// Load environment variables
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // Ensure this is set in your .env

// Initialize a Collection (map) to store commands
client.commands = new Collection();

// Path to the commands directory
const commandsPath = path.join(__dirname, 'commands');

// Read all command files
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

// Dynamically set commands in the Collection
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    // Ensure the command has 'data' and 'execute' properties
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        console.log(`Loaded command: ${command.data.name}`);
    } else {
        console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
}

// Function to join the voice channel
const joinVoiceChannelHandler = () => {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.error('The specified guild was not found. Please check GUILD_ID.');
        return;
    }

    const voiceChannel = guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!voiceChannel || voiceChannel.type !== 2) { // Type 2 is for voice channels in discord.js v14
        console.error('The specified voice channel ID is invalid or not a voice channel.');
        return;
    }

    joinVoiceChannel({
        channelId: VOICE_CHANNEL_ID,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator
    });

    console.log(`Joined voice channel: ${voiceChannel.name}`);
};

// When the bot is ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Join the voice channel upon connecting
    joinVoiceChannelHandler();

    // Start HTTP API server
    createApiServer(client);
});

// Handle reconnections if disconnected
client.on('voiceStateUpdate', (oldState, newState) => {
    const wasDisconnected =
        oldState.channelId === VOICE_CHANNEL_ID &&
        newState.channelId !== VOICE_CHANNEL_ID;

    if (wasDisconnected) {
        console.log('Bot was disconnected. Attempting to rejoin...');
        // disabled the automatic rejoin for now
        // joinVoiceChannelHandler();
    }
});

// Handle interaction events (e.g., slash commands)
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute(interaction);
        console.log(`Executed command: ${interaction.commandName}`);
    } catch (error) {
        console.error(`Error executing command ${interaction.commandName}:`, error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error executing that command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error executing that command!', ephemeral: true });
        }
    }
});

// Log in to Discord
client.login(TOKEN).catch((error) => {
    console.error('Failed to log in:', error);
});
