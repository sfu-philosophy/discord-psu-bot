import { Client } from 'discord.js';

/**
 * Patch: Use Bearer token and gateway instead of Bot token.
 */
export default function BearerToken(client: Client) {
	client.rest.requestManager.options.authPrefix = 'Bearer';
	return { id: 'authPrefix', config: {} };
}
