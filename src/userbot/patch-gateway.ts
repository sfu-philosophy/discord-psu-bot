import {
	Client,
	GatewayDispatchEvents,
	GatewayIdentify,
	GatewayOpcodes,
	WebSocketManager,
	WebSocketShard,
} from 'discord.js';
import { GatewaySendPayload, GatewayReceivePayload, GatewayDispatchPayload, GatewayReadyDispatch } from 'discord-api-types/gateway/v10';
import { PatchDeclaration, PatchedClient } from './util';
import { getUserAgent } from './patch-user-agent';

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
	patchCreateShards(client);

	return {
		id: 'gateway',
		config: {
			...createDefaults(),
		},
	};
}

function patchCreateShards(client: Client) {
	//@ts-expect-error
	const original = client.ws.createShards;

	//@ts-expect-error
	client.ws.createShards = function (this: WebSocketManager, ...args: unknown[]): Promise<void> {
		// Patch the shard instances.
		//@ts-expect-error
		const queue: Set<WebSocketShard> = this.shardQueue;
		queue.forEach((shard) => {
			patchShardInbound(shard);
			patchShardOutbound(shard);
		});

		// Create the shards.
		return Reflect.apply(original, this, args);
	};
}

/**
 * Patch an individual shard's outbound gateway packets.
 * This will intercept outbound packets and allow for them to be manipulated based on the patch map.
 */
function patchShardOutbound(shard: WebSocketShard) {
	//@ts-expect-error
	const original = shard._send;
	//@ts-expect-error
	shard._send = function (this: WebSocketShard, data: unknown, ...args: unknown[]): ReturnType<typeof original> {
		if (data != null && typeof data === 'object' && 'op' in data) {
			const opcode = data.op as GatewayOpcodes;
			const client = this.manager.client as PatchedClient<typeof Gateway>;
			const patch = client.patches.gateway.packets[opcode];

			if (patch?.outbound) {
				data = patch.outbound(client, data as any);
			}
		}

		return Reflect.apply(original, this, [data, ...args]);
	};
}

/**
 * Patch an individual shard's inbound gateway packets.
 * This will intercept inbound packets and allow for them to be manipulated based on the patch map.
 */
function patchShardInbound(shard: WebSocketShard) {
	//@ts-expect-error
	const original = shard.onPacket;
	//@ts-expect-error
	shard.onPacket = function (this: WebSocketShard, data: unknown, ...args: unknown[]): ReturnType<typeof original> {
		if (data != null && typeof data === 'object' && 'op' in data) {
			const opcode = data.op as GatewayOpcodes;
			const client = this.manager.client as PatchedClient<typeof Gateway>;
			const patch = client.patches.gateway.packets[opcode];

			// Handle gateway packet.
			if (patch?.inbound) {
				data = patch.inbound(client, data as any);
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
		}

		return Reflect.apply(original, this, [data, ...args]);
	};
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
				id: "0",
				flags: 0,
			}

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
