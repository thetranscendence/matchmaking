import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';

// Extension du type FastifyInstance pour inclure la propriété db
declare module 'fastify' {
	interface FastifyInstance {
		db: Database.Database;
	}
}

async function dbConnector(fastify: FastifyInstance) {
	fastify.log.info('Initializing SQLite database plugin...');

	// Définition des chemins: Utilisation de process.cwd() pour la racine de l'exécution
	// Dans Docker avec pnpm --filter, le cwd est /app/apps/matchmaking
	// Database file is stored in ./db/ directory (mounted as Docker volume for persistence)
	const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'db', 'db.sqlite');
	// Schema SQL file is in ./data/ directory (part of the source code, not overwritten by volume)
	const initSqlPath = process.env.INIT_SQL_PATH || path.join(process.cwd(), 'data', 'init.sql');
	const dbDir = path.dirname(dbPath);

	fastify.log.debug({ dbPath, initSqlPath }, 'Resolved database paths');

	// 1. S'assurer que le répertoire de destination existe
	if (!fs.existsSync(dbDir)) {
		fastify.log.debug(`Directory "${dbDir}" does not exist. Creating it...`);
		try {
			fs.mkdirSync(dbDir, { recursive: true });
			fastify.log.info(`Directory "${dbDir}" created successfully.`);
		} catch (err) {
			fastify.log.error({ err }, `Failed to create directory "${dbDir}"`);
			throw err;
		}
	}

	// 2. Initialisation de la connexion
	let db: Database.Database;
	try {
		db = new Database(dbPath, {
			verbose: (message) => fastify.log.debug(message), // Redirection des logs SQLite vers Fastify
		});
		fastify.log.info('SQLiite database connection established.');
	} catch (err) {
		fastify.log.error({ err }, 'Failed to establish SQLite database connection');
		throw err;
	}

	// 3. Exécution du script d'initialisation (Schéma)
	try {
		if (fs.existsSync(initSqlPath)) {
			fastify.log.debug(`Reading initialization script from "${initSqlPath}"...`);
			const initSql = fs.readFileSync(initSqlPath, 'utf8');

			fastify.log.debug('Executing initialization script...');
			db.exec(initSql);
			fastify.log.info('Database schema initialized successfully.');
		} else {
			fastify.log.warn(
				`Initialization script not found at "${initSqlPath}". Skipping schema initilization.`,
			);
		}
	} catch (err) {
		fastify.log.error({ err }, 'Failed to execute initialization script');
		// On ferme la connexion proprement avant de lever l'erreur
		db.close();
		throw err;
	}

	// 4. Décoration de l'instance Fastify
	if (!fastify.hasDecorator('db')) {
		fastify.decorate('db', db);
		fastify.log.debug('Fastify instance decorated with "db."');
	} else {
		fastify.log.warn('Fastify instance already has "db" decorator. Skipping decoration.');
	}

	// 5. Gestion de la fermeture
	fastify.addHook('onClose', (_instance, done) => {
		fastify.log.info('Closing SQLite database connection...');
		try {
			if (db.open) {
				db.close();
				fastify.log.info('SQLite database connection closed successfully');
			} else {
				fastify.log.debug('Database connection was already closed.');
			}
		} catch (err) {
			fastify.log.error({ err }, 'Error while closing SQLite database connection');
		}
		done();
	});
}

export default fp(dbConnector, {
	name: 'sqlite-plugin',
});
