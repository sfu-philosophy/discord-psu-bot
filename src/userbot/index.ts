import { Client as UnmodifiedClient } from 'discord.js';
import BearerToken from './patch-auth';
import Gateway from './patch-gateway';
import Rest from './patch-rest';
import UserAgent from './patch-user-agent';

import { patchClient, PatchedClient } from './util';

const DEFAULT_PATCHES = [
	BearerToken,
	Gateway,
	Rest,
	UserAgent
]

export type Client = PatchedClient<typeof BearerToken>

/**
 * Monkeypatches the discord.js client to work for a user-bot.
 * @param client The client to patch.
 */
export default function userbot(client: UnmodifiedClient) {
	for (const patch of DEFAULT_PATCHES) {
		patchClient(client, patch);
	}
}
