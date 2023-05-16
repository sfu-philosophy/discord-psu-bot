import { Client, Events, GatewayIntentBits, Guild, GuildMember, Interaction } from 'discord.js';
import EventEmitter = require('events');
import createLogger, { Logger } from 'kisl';
import userbot from './userbot';

/**
 * A class and main container for a bot connection.
 */
export default class Bot {
	public readonly client: Client<true>;
	public readonly logger: Logger;
	protected readonly emitter: EventEmitter;

	private constructor({ client, logger }: { client: Client; logger: Logger }) {
		this.client = client;
		this.logger = logger;
		this.emitter = new EventEmitter();

		// Add event listeners.
		this.client.on(Events.GuildMemberAdd, (member) => {
			this.emitter.emit('userJoined', member.guild, member);
		});

		this.client.on(Events.InteractionCreate, (interaction) => {
			this.emitter.emit('userInteraction', interaction);
		});
	}

	/**
	 * Adds an event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public on<E extends keyof BotEvents = keyof BotEvents>(event: E, handler: BotEvents[E]) {
		this.emitter.on(event, handler);
	}

	/**
	 * Adds a one-time event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public once<E extends keyof BotEvents = keyof BotEvents>(event: E, handler: BotEvents[E]) {
		this.emitter.once(event, handler);
	}

	/**
	 * Removes an event listener.
	 *
	 * @param event The event to listen for.
	 * @param handler The event handler.
	 */
	public off<E extends keyof BotEvents = keyof BotEvents>(event: E, handler: BotEvents[E]) {
		this.emitter.off(event, handler);
	}

	public static create(
		type: BotType,
		token: string,
		options?: {
			intents?: GatewayIntentBits[];
			logger?: Logger;
		},
	): Promise<Bot> {
		const isUserBot = type === BotType.User;
		const client = new Client({
			intents: options?.intents ?? [],
			shards: isUserBot ? 1 : 'auto',
		});

		// Monkeypatch the Discord.js library if it's a user.
		if (isUserBot) {
			userbot(client);

			client.on('userbot-debug', (msg) => {
				console.log("\x1B[33m%s\x1B[0m", msg);
			});

			client.on('debug', (msg) => {
				console.log("\x1B[2m%s\x1B[0m", msg);
			});
		}

		// Return a promise that will resolve when logged in, or when login fails.
		return new Promise((resolve, reject) => {
			client.once(Events.ClientReady, () => {
				const logger = options?.logger ?? createLogger(client.user!.username);
				logger.info('Logged in as', { user: client.user!.tag, id: client.user?.id });

				resolve(
					new Bot({
						client,
						logger,
					}),
				);
			});

			client.once(Events.Error, (err) => {
				reject(err);
			});

			client.login(token);
		});
	}
}

export enum BotType {
	User = 'user',
	Bot = 'bot',
}

export interface BotEvents {
	userJoined(guild: Guild, member: GuildMember): void;
	userInteraction(interaction: Interaction): void;
}
