import { SlashCommandBuilder } from 'discord.js';
import { Logger } from 'kisl/types';
import Bot, { BotEvents } from './bot';

import Manager from './manager';
import Server, { CommandHandler, ServerEvents } from './server';

export type ModuleConstructorArguments = Pick<Module, 'manager' | 'bot' | 'logger' | 'server'>;

export type ModuleConstructor = {
	new (args: ModuleConstructorArguments): Module;
	Orchestrator?: { new (): Orchestrator };
};

/**
 * An abstract class for a bot module.
 */
export abstract class Module<Config = unknown, Orchestrator = never> {
	public readonly manager: Manager;
	public readonly bot: Bot;
	public readonly logger: Logger;
	public readonly server: Server;

	private readonly unregisterFunctions: Array<() => void>;

	public constructor({ manager, bot, logger, server }: ModuleConstructorArguments) {
		this.manager = manager;
		this.bot = bot;
		this.logger = logger.derive(`${logger.name}:${this.getId()}`);
		this.server = server;

		this.unregisterFunctions = [];
	}

	/**
	 * Registers an event scoped to the bot.
	 * This will be removed automatically when the module is unloaded.
	 *
	 * @param event The event name.
	 * @param handler The event handler.
	 */
	public registerBotEvent<Event extends keyof BotEvents = keyof BotEvents>(event: Event, handler: BotEvents[Event]) {
		const boundHandler = this.guard(handler).bind(this as any);
		this.bot.on(event, boundHandler);
		this.register(() => {
			this.bot.off(event, boundHandler);
		});
	}

	/**
	 * Registers an event scoped to the guild.
	 * This will be removed automatically when the module is unloaded.
	 *
	 * @param event The event name.
	 * @param handler The event handler.
	 */
	public registerServerEvent<Event extends keyof ServerEvents = keyof ServerEvents>(
		event: Event,
		handler: ServerEvents[Event],
	) {
		const boundHandler = this.guard(handler).bind(this as any);
		this.server.on(event, boundHandler);
		this.register(() => {
			this.server.off(event, boundHandler);
		});
	}

	/**
	 * Registers a Discord slash command.
	 * This will be removed automatically when the module is unloaded.
	 *
	 * @param command The slash command.
	 * @param handler The handler for the slash command.
	 */
	public registerCommand(command: SlashCommandBuilder, handler: CommandHandler) {
		this.server.registerCommand(command, handler);
		this.register(() => {
			this.server.unregisterCommand(command);
		});
	}

	/**
	 * Registers a function to be called when the module unloads.
	 * @param onUnload The function to call.
	 */
	public register(onUnload: () => void) {
		this.unregisterFunctions.push(onUnload);
	}

	public guard<F extends (this: T, ...args: A) => R, A extends any[], R extends any, T extends any>(fn: F): F {
		const moduleThis = this as Module;
		return function (this: ThisParameterType<F>, ...args: Parameters<F>): ReturnType<F> {
			try {
				return Reflect.apply(fn, this, args) as ReturnType<F>;
			} catch (ex) {
				throw new ModuleError(moduleThis, 'Error within guarded function', ex as Error);
			}
		} as F;
	}

	/**
	 * Gets the module's ID.
	 */
	public abstract getId(): string;

	/**
	 * Called when the module should initialize.
	 */
	public abstract initialize(config: Config): Promise<void>;

	/**
	 * Called when the module config has changed.
	 */
	public abstract reconfigure(config: Config): Promise<void>;

	/**
	 * Called when the module is uninitializing.
	 */
	public async unload(): Promise<void> {
		while (this.unregisterFunctions.length > 0) {
			const cleanupFunction = this.unregisterFunctions.pop()!;
			cleanupFunction();
		}
	}
}

export abstract class Orchestrator {
	/**
	 * Called when the module should initialize.
	 */
	public abstract onModuleInitialize<M extends Module>(module: M): Promise<void>;
}

/**
 * An error that occurred within a module.
 */
export class ModuleError extends Error {
	public readonly module: Module;
	public readonly cause?: Error;
	private readonly _message: string;

	constructor(module: Module, message: string, cause?: Error) {
		super(message);

		this.module = module;
		this.cause = cause;
		this._message = message;

		Object.defineProperty(this, '_message', {
			value: message,
			enumerable: false,
		});
	}

	public get message(): string {
		if (this.cause != null) {
			return `${this._message}\n\nCaused by: ${this.cause}`;
		}

		return this._message;
	}
}
