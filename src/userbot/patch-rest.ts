import { Client, InternalRequest, RequestOptions, REST, Routes } from 'discord.js';
import { IncomingHttpHeaders } from 'http';
import { PatchDeclaration, PatchedClient } from './util';

export type RestRequest = InternalRequest;

/**
 * A patch for a REST API route.
 */
export interface RoutePatch {
	/**
	 * Redirect the request to this location.
	 */
	redirect?: string;

	/**
	 * Function called before the request is made.
	 * @param request The request data.
	 * @returns
	 */
	pre?: (client: Client, request: RestRequest) => RestRequest;
	post?: (client: Client, request: RestRequest, response: unknown) => unknown;
	resolve?: (
		client: Client,
		request: RestRequest,
		resolved: { url: string; fetchOptions: RequestOptions },
	) => { url: string; fetchOptions: RequestOptions };
}

interface Config {
	routes: Map<string, RoutePatch>;
}

/**
 * Patch: Intercept REST API requests and responses.
 */
export default function Rest(client: Client): PatchDeclaration<'rest', Config> {
	const pClient = client as PatchedClient<typeof Rest>;

	patchRequest(pClient);
	patchResolveRequest(pClient);

	return {
		id: 'rest',
		config: {
			routes: createDefaults(),
		},
	};
}

function escapeRegExp(string: string): string {
	// https://stackoverflow.com/a/6969486
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testParameterizedMatch(route: string, key: string): boolean {
	const REGEX_PARAMETER = /\{:[a-z]+\}/;
	if (!REGEX_PARAMETER.test(key)) return false;
	if (!key.startsWith(route.substring(0, route.indexOf('{:')))) {
		return false;
	}

	// Escape the key.
	const keyEscaped = escapeRegExp(key);
	const keyRegex = new RegExp('^' + keyEscaped.replace(/\\\{:[a-z]+\\\}/g, '[^/]+'));
	return keyRegex.test(route);
}

/**
 * Wrap the REST.request function.
 * This will allow us to intercept the request and the response data.
 */
function patchRequest(client: PatchedClient<typeof Rest>) {
	type REST = (typeof client)['rest'];
	type RequestFunction = REST['request'];

	const original = client.rest.request;
	client.rest.request = async function (
		this: REST,
		options: RestRequest,
		...args: any[]
	): ReturnType<RequestFunction> {
		const route = options.fullRoute;
		let patch = client.patches.rest.routes.get(route);

		// Couldn't find a patch.
		// Try parameterized route.
		if (patch === undefined) {
			for (const [key, val] of client.patches.rest.routes.entries()) {
				if (testParameterizedMatch(route, key)) {
					patch = val;
					break;
				}
			}
		}

		// Rewrite the URL.
		if (patch?.redirect) {
			options.fullRoute = patch.redirect as (typeof options)['fullRoute'];
		}

		// Patch the outgoing data.
		if (patch?.pre) {
			options = patch.pre(client, options);
		}

		// Make the request and patch the response.
		let result = await Reflect.apply(original, this, [options, ...args]);
		if (patch?.post) {
			result = patch.post(client, options, result);
		}

		return result;
	};
}

/**
 * Wrap the RestManager.resolveRequest function.
 * This will allow us to intercept the request headers.
 */
function patchResolveRequest(client: PatchedClient<typeof Rest>) {
	type RestManager = (typeof client)['rest']['requestManager'];

	//@ts-expect-error
	const original = client.rest.requestManager.resolveRequest;
	//@ts-expect-error
	client.rest.requestManager.resolveRequest = async function (
		this: RestManager,
		options: RestRequest,
		...args: any[]
	): Promise<{ url: string; fetchOptions: RequestOptions }> {
		const route = options.fullRoute;
		let patch = client.patches.rest.routes.get(route);

		// Couldn't find a patch.
		// Try parameterized route.
		if (patch === undefined) {
			for (const [key, val] of client.patches.rest.routes.entries()) {
				if (testParameterizedMatch(route, key)) {
					patch = val;
					break;
				}
			}
		}

		// Patch the resolved options.
		let result: any = await Reflect.apply(original, this, [options, ...args]);
		if (patch?.resolve) {
			result = patch.resolve(client, options, result);
		}

		return result;
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Default Patches:
// ---------------------------------------------------------------------------------------------------------------------

const DEFAULT_ROUTE_PATCHES: { [key: string]: RoutePatch } = {
	// Gateway URL request:
	// Use the user gateway instead of the bot gateway.
	[Routes.gatewayBot()]: {
		redirect: Routes.gateway(),
		post: (client, req, res) => ({
			shards: 1,
			session_start_limit: { total: 1, remaining: 1, reset_after: 14400000, max_concurrency: 1 },
			...(res as object),
		}),
	},

	'/users/{:id}/': {
		resolve(client, req, resolved) {
			const headers = resolved.fetchOptions.headers as Record<string, string>;
			headers['Authorization'] = headers['Authorization']!.replace(/^Bearer /, '');
			return resolved;
		},
	},
};

/**
 * Creates a map of default route patches.
 * @returns The default route patches.
 */
function createDefaults(): Map<string, RoutePatch> {
	return new Map(Object.entries(DEFAULT_ROUTE_PATCHES));
}
