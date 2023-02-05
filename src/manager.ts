import { Guild, IntentsBitField, SlashCommandBuilder, Snowflake, User } from 'discord.js';
import { EventEmitter } from 'events';
import { Logger } from 'kisl';
import Bot, { BotType } from './bot';
import { Module, ModuleConstructor, ModuleError, Orchestrator } from './module';
import Server from './server';

/**
 * The bot manager.
 */
export default class Manager {
	public readonly bot: Bot;
	public readonly userBot: Bot;
	public readonly logger: Logger;

	protected emitter: EventEmitter;
	protected servers: Map<Snowflake, Server>;
	protected modulesList: ModuleList;

	private constructor({
		apiBot,
		userBot,
		logger,
		modules,
	}: {
		apiBot: Bot;
		userBot: Bot;
		logger: Logger;
		modules: ModuleList;
	}) {
		this.bot = apiBot;
		this.userBot = userBot;
		this.logger = logger;
		this.modulesList = modules;
		this.servers = new Map();
		this.emitter = new EventEmitter();

		this.userBot.client.on('guildCreate', (guild) => {
			if (!this.servers.has(guild.id)) {
				this.createServerInstance(guild);
				this.logger.info('Added new server.', {
					id: guild.id,
					name: guild.name,
				});
				return;
			}
		});

		this.userBot.client.on('guildDelete', (guild) => {
			const server = this.servers.get(guild.id);
			if (server !== undefined) {
				this.destroyServerInstance(server);
				this.logger.info('Removed from server.', {
					id: server.id,
					name: server.name,
				});
			}
		});
	}

	private async createServerInstance(guild: Guild): Promise<void> {
		if (this.servers.has(guild.id)) {
			throw new Error(`Server already exists: ${guild.id}`);
		}

		// Create the server instance.
		const serverIdHex = BigInt(guild.id).toString(16);
		const serverLogger = this.logger.derive(`${this.logger.name}:${serverIdHex}`);
		const server = new Server(this.bot, guild, serverLogger);
		this.servers.set(guild.id, server);

		// Enable the modules for the server.
		await Promise.all(
			this.modulesList.map((mod) => {
				return server.loadModule(mod.constructor, mod.orchestrator, this).catch((err) => {
					this.emitter.emit('error', err);
				});
			}),
		);
	}

	private async destroyServerInstance(server: Server): Promise<void> {
		if (!this.servers.has(server.id)) {
			throw new Error(`Server does not exist: ${server.id}`);
		}

		// Remove the server.
		this.servers.delete(server.id);

		// Unload the modules for the server.
		await Promise.all(
			server.modules.map((mod) => {
				return server.unloadModule(mod).catch((err: Error) => {
					this.emitter.emit('error', new ModuleError(mod, 'Failed to unload module.', err));
				});
			}),
		);

		// Unload the server instance itself.
		for (const command of server.commands) {
			server.unregisterCommand(command as SlashCommandBuilder);
		}

		const listeners = server.listeners;
		if (listeners.length > 0) {
			if (this.emitter.listenerCount('leak') > 0) {
				this.emitter.emit('leak', server.id);
			} else {
				this.emitter.emit('error', new Error(`Server ${server.id} leaked listeners!`));
			}
		}

		for (const listener of listeners) {
			server.off(listener.event, listener.listener);
		}
	}

	/**
	 * Adds an event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public on<E extends keyof ManagerEvents = keyof ManagerEvents>(event: E, handler: ManagerEvents[E]) {
		this.emitter.on(event, handler);
	}

	/**
	 * Adds a one-time event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public once<E extends keyof ManagerEvents = keyof ManagerEvents>(event: E, handler: ManagerEvents[E]) {
		this.emitter.once(event, handler);
	}

	/**
	 * Removes an event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public off<E extends keyof ManagerEvents = keyof ManagerEvents>(event: E, handler: ManagerEvents[E]) {
		this.emitter.off(event, handler);
	}

	/**
	 * Checks to see if a user is a mutual member of a guild.
	 * This uses the bot user.
	 *
	 * @param user The user.
	 * @param guildId The guild ID.
	 */
	public async isUserMutualMemberOf(user: User, guildId: string): Promise<boolean> {
		const profile = (await this.userBot.client.rest.get(`/users/${user.id}/profile?with_mutual_guilds=true`)) as {
			mutual_guilds: Array<{ id: string; nick: string }>;
		};

		return profile.mutual_guilds.find(({ id }) => id === guildId) !== undefined;
	}

	/**
	 * Creates a new manager instance.
	 */
	public static async create({
		userToken,
		botToken,
		logger,
		modules,
	}: {
		userToken: string;
		botToken: string;
		logger: Logger;
		modules: ModuleConstructor[];
	}): Promise<Manager> {
		// Construct module orchestrators.
		logger.info('Preparing modules...');
		const mods = modules.map((m) => ({
			constructor: m,
			orchestrator: 'Orchestrator' in m ? new m.Orchestrator!() : null,
		}));

		// Start the Discord client.
		logger.info('Starting client instances...');
		const bots = await Promise.all([
			Bot.create(BotType.User, userToken, { logger: logger.derive('client-user') }),
			Bot.create(BotType.Bot, botToken, {
				logger: logger.derive('client-bot'),
				intents: [IntentsBitField.Flags.GuildMembers | IntentsBitField.Flags.Guilds],
			}),
		]);

		const manager = new Manager({
			userBot: bots[0],
			apiBot: bots[1],
			modules: mods,
			logger,
		});

		// Construct server instances.
		const guilds = Array.from(manager.bot.client.guilds.cache.values());
		logger.info('Found servers.', Object.fromEntries(guilds.map((g) => [g.id, g.name])));
		logger.info('Starting...');

		for (const guild of guilds) {
			await manager.createServerInstance(guild);
		}

		logger.info('Ready.');
		return manager;
	}
}

type ModuleList = Array<{
	constructor: ModuleConstructor;
	orchestrator: Orchestrator | null;
}>;

export interface ManagerEvents {
	error(err: Error): void;
}
