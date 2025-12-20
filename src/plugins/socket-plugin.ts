import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server, ServerOptions } from 'socket.io';

const opts: Partial<ServerOptions> = {
	cors: {
		origin: '*',
	},
};

async function socketPlugin(fastify: FastifyInstance) {
	const io = new Server(fastify.server, opts);

	fastify.decorate('io', io);

	fastify.addHook('preClose', (done) => {
		(fastify as any).io.local.disconnectSockets(true);
		done();
	});

	fastify.addHook('onClose', (_fastify, done: () => void) => {
		(fastify as any).io.close();
		done();
	});
}

export default fp(socketPlugin);
