import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';

const opts: Database.Options = {
	// verbose: console.log,
};

declare module 'fastify' {
	interface FastifyInstance {
		db: Database.Database;
	}
}

const __dirname = path.resolve();

async function dbConnector(fastify: FastifyInstance) {
	const db = new Database('./data/db.sqlite', opts);

	try {
		const initSql = fs.readFileSync(path.join(__dirname, './data/init.sql'), 'utf8');
		db.exec(initSql);
	} catch (error) {
		// console.error(error);
		throw error;
	}

	fastify.decorate('db', db);

	fastify.addHook('onClose', (_fastify, done: () => void) => {
		(fastify as any).db.close();
		done();
	});
}

export default fp(dbConnector);
