import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { bootstrap } from 'my-fastify-decorators';
import { AppModule } from '../app.module.js';

async function bootstrapPlugin(fastify: FastifyInstance) {
	bootstrap(fastify, AppModule);
}

export default fp(bootstrapPlugin);
