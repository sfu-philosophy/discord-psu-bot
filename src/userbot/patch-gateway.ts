import {
	Client,
	Collection,
	GatewayDispatchEvents,
	GatewayIdentify,
	GatewayOpcodes,
	WebSocketManager,
	WebSocketShard,
} from 'discord.js';
import {
	WebSocketManager as WSWebSocketManager,
	WebSocketShardEvents as WSWebSocketShardEvents,
	WebSocketShardEventsMap as WSWebSocketShardEventsMap,
	WebSocketShard as WSWebSocketShard,
} from '@discordjs/ws';
import {
	GatewaySendPayload,
	GatewayReceivePayload,
	GatewayDispatchPayload,
	GatewayReadyDispatch,
} from 'discord-api-types/gateway/v10';
import { PatchDeclaration, PatchedClient } from './util';
import { getUserAgent } from './patch-user-agent';
import { WebSocketShardEvents } from 'discord.js';

/**
 * Maps a {@link GatewayOpcodes gateway opcode} to its corresponding payload structure.
 */
export type GatewayPayload<O extends GatewayOpcodes> = Extract<GatewaySendPayload | GatewayReceivePayload, { op: O }>;

/**
 * Maps a {@link GatewayDispatchPayload gateway event} to its corresponding structure.
 */
export type GatewayEvent<E extends GatewayDispatchEvents> = Extract<
	GatewayDispatchPayload,
	{ op: GatewayOpcodes.Dispatch; t: E }
>;

/**
 * A patch to intercept a gateway packet.
 */
export interface GatewayPacketPatch<T = unknown> {
	inbound?: (client: Client, data: T) => T;
	outbound?: (client: Client, data: T) => T;
}

/**
 * A patch to intercept a gateway event.
 */
export interface GatewayEventPatch<T = unknown> {
	inbound?: (client: Client, event: T) => T;
}

/**
 * An object containing gateway packet patches.
 */
export type GatewayPacketPatchSet = { [key in GatewayOpcodes]?: GatewayPacketPatch<GatewayPayload<key>> };

/**
 * An object containing gateway event patches.
 */
export type GatewayEventPatchSet = { [key in GatewayDispatchEvents]?: GatewayEventPatch<GatewayEvent<key>> };

interface Config {
	packets: GatewayPacketPatchSet;
	events: GatewayEventPatchSet;
}

/**
 * Patches the client to intercept gateway packets.
 */
export default function Gateway(client: Client): PatchDeclaration<'gateway', Config> {
	patchCreateShardManager(client);

	return {
		id: 'gateway',
		config: {
			...createDefaults(),
		},
	};
}

function patchCreateShardManager(client: Client) {
	const manager = client.ws as WebSocketManager & { _ws: WSWebSocketManager };
	if (manager._ws === undefined) throw new Error('discord.js internal API has changed');

	let ws = manager._ws;
	Object.defineProperty(manager, '_ws', {
		get: () => {
			return ws;
		},

		set: (v: WSWebSocketManager) => {
			ws = v;
			patchCreateShard(client as PatchedClient<typeof Gateway>, ws);
			patchShardInbound(client as PatchedClient<typeof Gateway>, ws);
			client.emit('userbot-debug', 'patch-gateway: Received WSWebSocketManager and patched it.');
		},
	});
}

/**
 * Patch a websocket manager to patch shard instances as they are created.
 * This allows for more hooks to be installed on the individual shard instances.
 */
function patchCreateShard(client: PatchedClient<typeof Gateway>, ws: WSWebSocketManager) {
	const tag = Symbol('patched');
	const original = ws.updateShardCount;
	if (original === undefined) throw new Error('discord.js internal API has changed');

	ws.updateShardCount = async function (this: WSWebSocketManager, ...args: any[]): Promise<WSWebSocketManager> {
		const ret = await Reflect.apply(original, this, args);

		const strategy = (this as any).strategy;
		if (strategy?.shards === undefined) throw new Error('discord.js internal API has changed');

		const shards = strategy.shards as Map<number, WSWebSocketShard>;
		for (const [id, shard] of shards) {
			if (tag in shard) continue;

			client.emit('userbot-debug', `patch-gateway: Patching shard with ID ${id}.`);
			(shard as any)[tag] = true;
			patchShardOutbound(client, ws, shard);
		}

		return ret;
	};
}

/**
 * Patch a websocket manager to alter outbound gateway packets.
 * This will intercept outbound packets and allow for them to be manipulated based on the patch map.
 */
function patchShardOutbound(client: PatchedClient<typeof Gateway>, ws: WSWebSocketManager, shard: WSWebSocketShard) {
	const original = shard.send;
	if (original === undefined) throw new Error('discord.js internal API has changed');

	shard.send = function (
		this: WSWebSocketShard,
		data: GatewaySendPayload,
		...args: unknown[]
	): ReturnType<typeof original> {
		if (data != null && typeof data === 'object' && 'op' in data) {
			const opcode = data.op as GatewayOpcodes;
			const patch = client.patches.gateway.packets[opcode];

			if (patch?.outbound) {
				data = patch.outbound(client, data as any) as GatewaySendPayload;
			}
		}

		return Reflect.apply(original, this, [data, ...args]);
	};
}

/**
 * Patch an individual shard's inbound gateway packets.
 * This will intercept inbound packets and allow for them to be manipulated based on the patch map.
 */
function patchShardInbound(client: PatchedClient<typeof Gateway>, ws: WSWebSocketManager) {
	const original = ws.emit;
	if (original === undefined) throw new Error('discord.js internal API has changed');

	ws.emit = <any>(
		function (this: WSWebSocketManager, ...args: Parameters<typeof original>): ReturnType<typeof original> {
			const event = args[0] as WSWebSocketShardEvents;
			const eventData = args.slice(1) as WSWebSocketShardEventsMap[typeof event];

			// Just do everything as-is unless its a dispatch event.
			if (event !== WSWebSocketShardEvents.Dispatch) {
				return Reflect.apply(original, this, args);
			}

			// Extract the data from the dispatch event.
			let { data } = (eventData as WSWebSocketShardEventsMap[WSWebSocketShardEvents.Dispatch])[0];
			console.error('GOT PAYLOAD', data);
			if (data != null && typeof data === 'object' && 'op' in data) {
				const opcode = data.op as GatewayOpcodes;
				const patch = client.patches.gateway.packets[opcode];

				// Handle gateway packet.
				if (patch?.inbound) {
					data = patch.inbound(client, data as any) as GatewayDispatchPayload;
				}

				// Handle gateway event.
				if (opcode === GatewayOpcodes.Dispatch) {
					const event = (data as GatewayDispatchPayload).t;
					const patch = client.patches.gateway.events[event];
					if (patch?.inbound) {
						//FIXME(eth-p): Figure out a way to fix this.
						//@ts-ignore
						data = patch.inbound(client, data);
					}
				}

				(eventData as WSWebSocketShardEventsMap[WSWebSocketShardEvents.Dispatch])[0].data = data;
			}

			return Reflect.apply(original, this, args);
		}
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Default Patches:
// ---------------------------------------------------------------------------------------------------------------------

const DEFAULT_GATEWAY_PACKET_PATCHES: GatewayPacketPatchSet = {
	// Identify packet:
	//
	// Pretend to be a real client.
	// This is needed or else the gateway will close the connection.
	[GatewayOpcodes.Identify]: {
		outbound(client: Client, packet: GatewayIdentify) {
			const data = packet.d as any;
			data.capabilities = 4093;
			data.properties = {
				browser: 'Chrome',
				browser_user_agent: getUserAgent(client),
				browser_version: '109.0.0.0',
				client_build_number: 171842,
				client_event_source: null,
				device: '',
				os: 'Windows',
				os_version: '10',
				referrer: '',
				referrer_current: '',
				referring_domain: '',
				referring_domain_current: '',
				release_channel: 'stable',
				system_locale: 'en-CA',
			};

			delete packet.d.shard; // This is what causes the gateway to reject the client.
			return packet;
		},
	},
};

const DEFAULT_GATEWAY_EVENT_PATCHES: GatewayEventPatchSet = {
	// Identify packet:
	//
	// Pretend to be a real client.
	// This is needed or else the gateway will close the connection.
	[GatewayDispatchEvents.Ready]: {
		inbound(client: Client, packet: GatewayReadyDispatch) {
			const data = packet.d as any;
			data.application = {
				id: '0',
				flags: 0,
			};

			return packet;
		},
	},
};

/**
 * Creates a map of default gateway patches.
 * @returns The default gateway patches.
 */
function createDefaults(): Config {
	return {
		packets: { ...DEFAULT_GATEWAY_PACKET_PATCHES },
		events: { ...DEFAULT_GATEWAY_EVENT_PATCHES },
	};
}
