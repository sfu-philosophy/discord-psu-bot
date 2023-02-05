import * as dotenv from 'dotenv';
import * as sourcemaps from 'source-map-support';
import createLogger from 'kisl';

import Manager from './manager';
import Verifier from './modules/verifier';

// Enable .env file and sourcemaps if not running under production.
if (process.env.NODE_ENV !== 'production') {
	dotenv.config({ path: `./.env.local` });
	sourcemaps.install();
}

// Load variables from .env file.
dotenv.config({ path: `./.env` });

// Functions.
function getConfig(name: string): string {
	if (!(name in process.env)) {
		throw new Error(`Missing environment variable: ${name}`);
	}

	return process.env[name]!;
}

// Main.
(async function () {
	const logger = createLogger('psubot');
	const manager = await Manager.create({
		userToken: getConfig('DISCORD_TOKEN_USER'),
		botToken: getConfig('DISCORD_TOKEN'),
		logger,
		modules: [Verifier],
	});

	manager.on('error', (error) => {
		logger.error('Encountered unhandled error.', error);
	});
})().catch((error) => {
	console.error('Failed to start bot.');
	console.error(error);
	process.exit(1);
});
