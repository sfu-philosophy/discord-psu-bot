import { Client, RequestOptions } from 'discord.js';
import { PatchDeclaration, PatchedClient } from './util';

export const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36';

interface Config {
	value: string;
}

/**
 * Patch: Use browser user agent instead of Bot agent.
 */
export default function UserAgent(client: Client): PatchDeclaration<'userAgent', Config> {
	const pClient = client as PatchedClient<typeof UserAgent>;

	wrapResolveRequest(pClient);

	return {
		id: 'userAgent',
		config: {
			value: DEFAULT_USER_AGENT,
		},
	};
}

/**
 * Wrap the RequestManager.resolveRequest private function.
 * This will allow us to change the headers right before the request is made.
 */
function wrapResolveRequest(client: PatchedClient<typeof UserAgent>) {
	type RequestManager = Client['rest']['requestManager'];

	type ResolveRequestFunction = RequestManager['resolveRequest'];
	type ResolveRequestReturnType = Promise<{ fetchOptions: RequestOptions; url: string }>;

	// @ts-expect-error TS2341
	const original = client.rest.requestManager.resolveRequest;
	// @ts-expect-error TS2341
	client.rest.requestManager.resolveRequest = async function (
		this: RequestManager,
		...args: Parameters<ResolveRequestFunction>
	): ResolveRequestReturnType {
		const result: Awaited<ResolveRequestReturnType> = await Reflect.apply(original, this, args);
		let headers = result.fetchOptions.headers;

		if (headers instanceof Array) {
			headers = Object.fromEntries(
				headers.map((header) => header.split(':', 2)).map(([name, val]) => [name, val.trimStart()]),
			);
		}

		if (headers != null && typeof headers === 'object' && !(headers instanceof Array)) {
			headers['User-Agent'] = client.patches.userAgent.value;
		}

		return result;
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Utilities:
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Gets the user agent of a client.
 *
 * @param client The client instance.
 * @returns The user agent, or else the default one.
 */
export function getUserAgent(client: Client) {
	const patched = client as PatchedClient<typeof UserAgent>;
	return patched?.patches?.userAgent?.value ?? DEFAULT_USER_AGENT;
}
