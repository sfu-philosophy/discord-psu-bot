import {
	ChatInputCommandInteraction,
	GuildMember,
	MessageFlags,
	Role,
	SlashCommandBuilder,
} from 'discord.js';
import { Module } from '../../module';

export interface Config {
	verify_on_join?: boolean;
	verify_fail_message?: string;
	assignments: Array<{
		server_id: string; // Make sure to quote me in Yaml!
		role_id: string; // Make sure to quote me in Yaml!
	}>;
}

export default class Verifier extends Module {
	private config!: Config;

	public getId(): string {
		return 'verifier';
	}

	public async initialize(config: Config): Promise<void> {
		this.config = config;

		this.registerServerEvent('userJoined', (member) => {
			if (this?.config.verify_on_join === true) {
				this.assignRoles(member, true);
			}
		});

		this.registerCommand(
			new SlashCommandBuilder().setName('verify').setDescription('Verify your student status.'),
			async (interaction) => {
				const result = await this.assignRoles(interaction.member as GuildMember, true);
				this.replyToInteraction(interaction as ChatInputCommandInteraction, result);
			},
		);

		this.registerCommand(
			new SlashCommandBuilder().setName('unverify').setDescription('Remove your verification roles.'),
			async (interaction) => {
				const result = await this.clearRoles(interaction.member as GuildMember);
				this.replyToInteraction(interaction as ChatInputCommandInteraction, result);
			},
		);
	}

	public async reconfigure(config: Config): Promise<void> {
		this.config = config;
	}

	protected async replyToInteraction(
		interaction: ChatInputCommandInteraction,
		result: { added?: Role[]; removed: Role[]; hasAnything?: boolean },
	) {
		const added = result.added ?? [];
		const removed = result.removed;

		if (result.added?.length === 0 && result.removed.length === 0) {
			const userHasNoRolesButTriedToGetSome = result.added != null && !result.hasAnything;
			const message = userHasNoRolesButTriedToGetSome ? this.config.verify_fail_message : null;
			return await interaction.reply({
				content: message ?? 'None of your roles were changed.',
				flags: MessageFlags.Ephemeral,
			});
		}

		let text = '';

		if (added.length > 0) {
			let mentions = added.map((role) => role.toString() as string);
			text += `You were given the ${joinTextList(mentions)} role${added.length === 1 ? '' : 's'}.`;
		}

		if (removed.length > 0) {
			let mentions = removed.map((role) => role.toString() as string);
			text += `The ${joinTextList(mentions)} role${removed.length === 1 ? '' : 's'} ${
				removed.length === 1 ? 'was' : 'were'
			} removed.`;
		}

		return await interaction.reply({
			content: `**Verification complete!**\n\n${text}`,
			flags: MessageFlags.Ephemeral,
		});
	}

	/**
	 * Clears all verifable roles from a user.
	 *
	 * @param member The member to clear.
	 * @returns The roles that were removed.
	 */
	protected async clearRoles(member: GuildMember): Promise<{ removed: Role[] }> {
		const toRemove = [];

		// Calculate the difference.
		for (const { role_id } of this.config.assignments) {
			const isHolding = member.roles.cache.has(role_id);
			if (isHolding) {
				toRemove.push(role_id);
			}
		}

		// Apply the changes.
		if (toRemove.length > 0) await member.roles.remove(toRemove);
		return { removed: (await Promise.all(toRemove.map((id) => this.server.getRole(id)))) as Role[] };
	}

	/**
	 * Assigns all verifiable roles to a user.
	 *
	 * @param member The member to verify.
	 * @param onlyAdd If true, roles will not be removed.
	 * @returns The roles that were added or removed.
	 */
	protected async assignRoles(
		member: GuildMember,
		onlyAdd: boolean,
	): Promise<{ added: Role[]; removed: Role[]; hasAnything: boolean }> {
		const toAdd = [];
		const toRemove = [];
		let hasAtLeastOneRole = false;

		// Calculate the difference.
		for (const { server_id, role_id } of this.config.assignments) {
			const isHolding = member.roles.cache.has(role_id);
			const isEligible = await this.manager.isUserMutualMemberOf(member.user, server_id);

			if (!isHolding && isEligible) {
				toAdd.push(role_id);
			}

			if (isHolding && !isEligible && !onlyAdd) {
				toRemove.push(role_id);
			}

			if (isHolding) {
				hasAtLeastOneRole = true;
			}
		}

		// Apply the changes.
		if (toAdd.length > 0) await member.roles.add(toAdd);
		if (toRemove.length > 0) await member.roles.remove(toRemove);

		const [added, removed] = await Promise.all([
			Promise.all(toAdd.map((id) => this.server.getRole(id))),
			Promise.all(toRemove.map((id) => this.server.getRole(id))),
		]);

		return { added: added as Role[], removed: removed as Role[], hasAnything: hasAtLeastOneRole };
	}
}

function joinTextList(items: string[]): string {
	if (items.length > 2) {
		return joinTextList([items.slice(0, -2).join(',') + ',', items[items.length - 1]]);
	}

	return items.join(' and ');
}
