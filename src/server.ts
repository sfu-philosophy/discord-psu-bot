import {
	ChannelType,
	ChatInputCommandInteraction,
	ClientApplication,
	Collection,
	Guild,
	GuildBasedChannel,
	GuildChannelResolvable,
	GuildMember,
	Interaction,
	Message,
	MessageContextMenuCommandInteraction,
	Role,
	Routes,
	SlashCommandBuilder,
	Snowflake,
} from 'discord.js';
import EventEmitter = require('events');
import { Logger } from 'kisl/types';
import { parse } from 'yaml';
import Bot, { BotEvents } from './bot';
import { BOT_CONFIG_CHANNEL } from './constants';
import Manager from './manager';
import { Module, ModuleConstructor, ModuleError, Orchestrator } from './module';

export type CommandHandler = (
	interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
) => Promise<void>;

export default class Server {
	public readonly bot: Bot;
	public readonly guild: Guild;
	public readonly logger: Logger;

	private readonly loadedModules: Map<string, Module>;
	private readonly loadedCommands: Map<string, [SlashCommandBuilder, CommandHandler]>;
	private readonly eventMapper: EventMapper;
	private readonly onInteractionHandler: (interaction: Interaction) => void;

	public constructor(bot: Bot, guild: Guild, logger: Logger) {
		this.guild = guild;
		this.bot = bot;
		this.logger = logger.derive(this.guild.id);

		this.loadedModules = new Map();
		this.loadedCommands = new Map();
		this.eventMapper = new EventMapper(bot, guild);

		this.onInteractionHandler = (interaction: Interaction) => {
			if (!interaction.isChatInputCommand()) {
				return;
			}

			const command = this.loadedCommands.get(interaction.commandName);
			if (command != null) {
				command[1](interaction);
				// TODO(eth-p): Handle errors from the Promise.
			}
		};
	}

	/**
	 * The server name.
	 */
	public get name(): string {
		return this.guild.name;
	}

	/**
	 * The server ID snowflake.
	 */
	public get id(): Snowflake {
		return this.guild.id;
	}

	public get modules(): Module[] {
		return Array.from(this.loadedModules.values());
	}

	public get commands(): Pick<SlashCommandBuilder, 'name' | 'name_localizations'>[] {
		return Array.from(this.loadedCommands.values()).map((b) => b[0]);
	}

	public get listeners(): Array<{ event: keyof ServerEvents; listener: ServerEvents[keyof ServerEvents] }> {
		return this.eventMapper.getListeners();
	}

	/**
	 * Gets a module.
	 *
	 * @param moduleId The module ID.
	 *
	 * @returns The module instance, or undefined if not found.
	 */
	public getModule<M extends Module>(id: string): M | undefined {
		return this.loadedModules.get(id) as M | undefined;
	}

	/**
	 * Creates a new module.
	 *
	 * @param module The module constructor.
	 * @param orchestrator The module orchestrator.
	 * @param manager The manager instance.
	 */
	public async loadModule(
		module: ModuleConstructor,
		orchestrator: Orchestrator | null,
		manager: Manager,
	): Promise<void> {
		const instance = new module({
			bot: this.bot,
			logger: this.logger,
			server: this,
			manager,
		});

		try {
			// Add the instance to the list of modules.
			if (this.loadedModules.has(instance.getId())) {
				throw new Error('Module already loaded.');
			}

			this.loadedModules.set(instance.getId(), instance);

			// Fetch the config for the module.
			let config = null;
			try {
				config = await this.getYamlConfiguration(BOT_CONFIG_CHANNEL, instance.getId());
			} catch (ex) {
				instance.logger.warn('No configuration found.', ex);
			}

			// Initialize the module.
			await instance.initialize(config);
			await this.refreshCommands();
			instance.logger.info('Enabled.');

			if (orchestrator != null) {
				orchestrator.onModuleInitialize(instance);
			}
		} catch (ex) {
			throw new ModuleError(instance, 'Failed to enable module.', ex as Error);
		}
	}

	/**
	 * Unloads a module.
	 *
	 * @param module The module instance.
	 * @param server The server.
	 */
	public async unloadModule(module: Module): Promise<void> {
		if (!this.loadedModules.delete(module.getId())) {
			throw new Error('Module not loaded.');
		}

		try {
			await module.unload();
		} catch (ex) {
			throw new ModuleError(module, 'Failed to disable module.', ex as Error);
		}

		await this.refreshCommands();
	}

	/**
	 * Adds an event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public on<E extends keyof ServerEvents = keyof ServerEvents>(event: E, handler: ServerEvents[E]) {
		this.eventMapper.on(event, handler);
	}

	/**
	 * Removes an event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public off<E extends keyof ServerEvents = keyof ServerEvents>(event: E, handler: ServerEvents[E]) {
		this.eventMapper.off(event, handler);
	}

	public registerCommand(command: SlashCommandBuilder, handler: CommandHandler): void {
		this.loadedCommands.set(command.name, [command, handler]);
		this.logger.debug('Registered command', { name: command.name });

		if (this.loadedCommands.size === 1) {
			this.logger.debug('Enabling user interaction listener', { name: command.name });
			this.on('userInteraction', this.onInteractionHandler);
		}
	}

	public unregisterCommand(command: SlashCommandBuilder) {
		this.loadedCommands.delete(command.name);
		this.logger.debug('Unregistered command', { name: command.name });

		if (this.loadedCommands.size === 0) {
			this.logger.debug('Disabling user interaction listener', { name: command.name });
			this.off('userInteraction', this.onInteractionHandler);
		}
	}

	public async refreshCommands(): Promise<void> {
		this.logger.debug('Refreshing commands.', { commands: this.commands.map((c) => c.name) });
		const data = await this.guild.client.rest.put(
			Routes.applicationGuildCommands((this.guild.client.application as ClientApplication).id, this.guild.id),
			{ body: Array.from(this.loadedCommands.values()).map(([builder]) => builder.toJSON()) },
		);
	}

	/**
	 * Gets a channel instance from either its name or its snowflake.
	 *
	 * @param name The channel name.
	 * @returns The channel instance, or undefined if not found.
	 */
	public async getChannel(name: string): Promise<GuildBasedChannel | undefined> {
		const channels = Array.from(this.guild.channels.cache.values());
		return channels.find((c) => c.id === name || c.name === name || `#${c.name}` === name);
	}

	/**
	 * Gets a role instance from either its name or its snowflake.
	 *
	 * @param name The role name.
	 * @returns The channel instance, or undefined if not found.
	 */
	public async getRole(name: string): Promise<Role | undefined> {
		const roles = Array.from(this.guild.roles.cache.values());
		return roles.find((r) => r.id === name || r.name === name || r.name.toLowerCase() === name.toLowerCase());
	}

	/**
	 * Searches for a message in a channel.
	 *
	 * @param channel The channel to search through.
	 * @param predicate The predicate.
	 * @returns The message if found, or undefined otherwise.
	 */
	public async findMessage(
		channel: GuildBasedChannel,
		predicate: (message: Message<true>) => boolean,
	): Promise<Message | undefined> {
		if (channel.type !== ChannelType.GuildText) {
			throw new Error(`Channel '${channel.name}' (${channel.id}) is not a text channel.`);
		}

		// Step 1: Search through the cache.
		for (const message of channel.messages.cache.values()) {
			if (predicate(message)) {
				return message;
			}
		}

		// Step 2: Search backwards through the channel.
		// Pro tip: Don't do this on long-historied channels, it'll take forever.
		let lastMessageId = undefined;
		let lastMessageTimestamp = Date.now();
		let page = 1;
		while (true) {
			this.logger.debug('Searching for message.', { page });
			page++;

			// Fetch the messages.
			const response: Collection<string, Message> = await channel.messages.fetch({
				before: lastMessageId,
				limit: 100,
			});

			if (response.size === 0) {
				return undefined;
			}

			// Check to see if any fetched messages are relevant.
			for (const message of response.values()) {
				if (predicate(message as Message<true>)) {
					return await channel.messages.fetch(message);
				}

				// Update the oldest message found (to page through all messages).
				if (message.createdTimestamp < lastMessageTimestamp) {
					lastMessageTimestamp = message.createdTimestamp;
					lastMessageId = message.id;
				}
			}
		}
	}

	/**
	 * Find a YAML configuration declaration block from within a channel.
	 * A declaration block is in the format of:
	 *     [@bot-user]:{id}
	 *     ```yaml
	 *     ...
	 *     ```
	 *
	 * @param channel The channel to look through.
	 * @param id The ID to look for.
	 */
	public async getYamlConfiguration<C>(channel: GuildChannelResolvable, id: string): Promise<C> {
		const channelInstance = typeof channel === 'string' ? await this.getChannel(channel) : channel;
		if (channelInstance == null) {
			throw new Error(`Could not find channel: ${channel}`);
		}

		// Search for a configuration message.
		const configMessage = await this.findMessage(channelInstance, (message) =>
			message.content.startsWith(`[<@${this.bot.client.user.id}>]:${id}\n`),
		);

		if (configMessage == null) {
			throw new Error(`Could not find config message for '${id}' within channel '${channel}'.`);
		}

		// Parse the message.
		const firstIndex = configMessage.content.indexOf('```yaml\n');
		const lastIndex = configMessage.content.lastIndexOf('```');
		if (firstIndex === -1 || lastIndex === -1 || firstIndex === lastIndex) {
			throw new Error(`Could not parse config message for '${id}' within channel '${channel}'.`);
		}

		return parse(configMessage.content.slice(firstIndex + 8, lastIndex));
	}
}

export interface ServerEvents {
	userJoined(member: GuildMember): void;
	userInteraction(interaction: Interaction): void;
}

/**
 * Maps bot events to guild events.
 */
class EventMapper {
	public readonly emitter: EventEmitter;
	public readonly bot: Bot;
	public readonly guild: Guild;
	public readonly eventMap: Map<keyof ServerEvents, [keyof BotEvents, BotEvents[keyof BotEvents]]>;

	public constructor(bot: Bot, guild: Guild) {
		this.bot = bot;
		this.guild = guild;
		this.emitter = new EventEmitter();
		this.eventMap = new Map(
			Object.entries(EventMapper.MAP).map(([event, [onto, listener]]) => [
				event as keyof ServerEvents,
				[onto, listener.bind(this)],
			]),
		);
	}

	protected attachToBotEmitter(event: keyof ServerEvents) {
		const mapped = this.eventMap.get(event)!;
		this.bot.on(mapped[0], mapped[1]);
	}

	protected detachFromBotEmitter(event: keyof ServerEvents) {
		const mapped = this.eventMap.get(event)!;
		this.bot.off(mapped[0], mapped[1]);
	}

	public on<E extends keyof ServerEvents = keyof ServerEvents>(event: E, handler: ServerEvents[E]) {
		const listeners = this.emitter.listenerCount(event);
		this.emitter.on(event, handler);
		if (listeners === 0) {
			this.attachToBotEmitter(event);
		}
	}

	public off<E extends keyof ServerEvents = keyof ServerEvents>(event: E, handler: ServerEvents[E]) {
		const listeners = this.emitter.listenerCount(event);
		this.emitter.off(event, handler);
		if (listeners === 1) {
			this.detachFromBotEmitter(event);
		}
	}

	public getListeners(): Array<{ event: keyof ServerEvents; listener: ServerEvents[keyof ServerEvents] }> {
		const listeners: ReturnType<typeof this.getListeners> = [];

		for (const event of this.emitter.eventNames()) {
			listeners.splice(
				listeners.length,
				0,
				...this.emitter.rawListeners(event).map((listener) => ({
					event: event as keyof ServerEvents,
					listener: listener as unknown as ServerEvents[keyof ServerEvents],
				})),
			);
		}

		return listeners;
	}

	public static MAP: { [key in keyof ServerEvents]: [keyof BotEvents, BotEvents[keyof BotEvents]] } = {
		userJoined: [
			'userJoined',
			function (this: EventMapper, guild: Guild, member: GuildMember) {
				if (guild?.id === this.guild.id) {
					return this.emitter.emit('userJoined', member);
				}
			},
		],

		userInteraction: [
			'userInteraction',
			function (this: EventMapper, interaction: Interaction) {
				if (interaction.guild?.id === this.guild.id) {
					return this.emitter.emit('userInteraction', interaction);
				}
			},
		],
	};
}
