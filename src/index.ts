import Ajv from 'ajv';
import * as ajvErrors from 'ajv-errors';
import Fastify from 'fastify';
import { registerValidators } from 'my-class-validator';
import bootstrapPlugin from './plugins/bootstrap-plugin.js';
import socketPlugin from './plugins/socket-plugin.js';
import sqlitePlugin from './plugins/sqlite-plugin.js';

const app = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } });

const AjvCtor: any = (Ajv as any).default ?? Ajv;
const addAjvErrors: any = (ajvErrors as any).default ?? ajvErrors;
const ajv = new AjvCtor({ allErrors: true, $data: true, messages: true, coerceTypes: true } as any);
addAjvErrors(ajv);

registerValidators(ajv);

app.register(sqlitePlugin);
app.register(socketPlugin);
app.register(bootstrapPlugin);

app.setValidatorCompiler(({ schema }) => {
	return ajv.compile(schema as any);
});

app.setSchemaErrorFormatter((errors) => {
	const message =
		errors
			.map((e) => e.message)
			.filter(Boolean)
			.join('; ') || 'Validation error';
	const err: any = new Error(message);
	err.statusCode = 400;
	err.validation = errors;
	// On évite de pointer systématiquement sur index.ts
	err.stack = undefined;

	return err as Error;
});

async function start() {
	try {
		await app.listen({ port: 3000, host: '0.0.0.0' });
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}
}

start();
