import { Client } from 'discord.js';

export interface PatchDeclaration<ID extends string = string, C extends object = object> {
	id: ID;
	config: C;
}

/**
 * A function that applies a patch to the Discord.js {@link Client}.
 */
export type PatchFunction = (client: Client) => PatchDeclaration<string, object>;

/**
 * A client that has had a {@link PatchFunction} applied to it.
 */
export type PatchedClient<
	Fn extends PatchFunction,
	ID extends string = ReturnType<Fn>['id'],
	Config extends object = ReturnType<Fn>['config'],
> = Client & {
	patches: { [key in ID]: Config };
};

/**
 * Adds a struct to a {@link Client}'s fake "patches" object.
 * This can allow for on-the-fly patch reconfiguring.
 *
 * @param client The client object.
 * @param patch The patch function.=
 */
export function patchClient<Fn extends PatchFunction, ID extends string = ReturnType<Fn>['id']>(
	client: Client,
	patch: Fn,
): PatchedClient<Fn> {
	const { id, config } = patch(client);
	const patchedClient = client as PatchedClient<Fn>;

	// Add the patches object.
	if (patchedClient.patches == null) {
		patchedClient.patches = {} as (typeof patchedClient)['patches'];
	}

	// Add the config object.
	patchedClient.patches[id as ID] = config;

	// Return the patched client.
	return patchedClient;
}
