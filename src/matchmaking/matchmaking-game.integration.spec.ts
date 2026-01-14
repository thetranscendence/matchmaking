import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { bootstrap } from 'my-fastify-decorators';
import { io as Client, type Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';

// Import plugins
import socketPlugin from '../plugins/socket-plugin.js';
import sqlitePlugin from '../plugins/sqlite-plugin.js';

import { MatchmakingModule } from './matchmaking.module.js';
import { UserService } from './user.service.js';
import { GameService } from './game.service.js';

// =============================================================================
// INTEGRATION TESTS FOR MATCHMAKING -> GAME SERVICE FLOW
// =============================================================================
//
// These tests verify the complete integration flow between Matchmaking and Game
// services, specifically testing the `finalizeMatch()` method which calls
// `GameService.createGame()` after both players accept a match.
//
// Test Scenarios:
// 1. Successful match flow: queue -> proposal -> accept -> game created
// 2. Game creation failure: players are re-queued with priority
// 3. Network errors: fallback handling and player notification
//
// =============================================================================

const TEST_SECRET = 'super-secret-test-key';

describe('Matchmaking -> Game Integration Flow', () => {
	let app: FastifyInstance;
	let serverPort: number;
	let serverUrl: string;
	let activeClients: ClientSocket[] = [];

	// Spies for controlling service behavior
	const getUserEloSpy = jest.spyOn(UserService.prototype, 'getUserElo');
	const createGameSpy = jest.spyOn(GameService.prototype, 'createGame');

	/**
	 * Helper function to generate valid JWT tokens for testing.
	 * Token payload matches the Auth Service structure.
	 */
	const createToken = (
		userId: number,
		email: string = 'test@example.com',
		username: string = 'testuser',
	) => {
		return jwt.sign({ id: userId, email, username, provider: 'email' }, TEST_SECRET);
	};

	/**
	 * Helper to connect a Socket.IO client with authentication.
	 */
	const connectClient = (token: string): ClientSocket => {
		const socket = Client(serverUrl, {
			auth: { token },
			transports: ['websocket'],
			forceNew: true,
			autoConnect: true,
		});
		activeClients.push(socket);
		return socket;
	};

	/**
	 * Helper to wait for a specific event on a socket with timeout.
	 */
	const waitForEvent = <T = unknown>(
		socket: ClientSocket,
		event: string,
		timeoutMs: number = 5000,
	): Promise<T> => {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Timeout waiting for event: ${event}`));
			}, timeoutMs);

			socket.once(event, (data: T) => {
				clearTimeout(timeout);
				resolve(data);
			});
		});
	};

	beforeAll(async () => {
		console.debug('[TEST] [Setup] Initializing Fastify server...');

		app = Fastify({ logger: false });

		await app.register(sqlitePlugin);
		await app.register(socketPlugin);
		await app.after();

		// JWT authentication simulation
		app.decorateRequest('user', null);
		app.addHook('preValidation', async (req) => {
			const authHeader = req.headers.authorization;
			if (authHeader && authHeader.startsWith('Bearer ')) {
				const token = authHeader.split(' ')[1];
				try {
					(req as any).user = jwt.verify(token, TEST_SECRET);
				} catch (e) {}
			}
		});

		await bootstrap(app, MatchmakingModule);

		await app.ready();
		await app.listen({ port: 0, host: '127.0.0.1' });

		const address = app.server.address() as AddressInfo;
		serverPort = address.port;
		serverUrl = `http://127.0.0.1:${serverPort}`;

		console.debug(`[TEST] [Setup] Server listening on ${serverUrl}`);
	});

	afterEach(() => {
		// Cleanup clients after each test
		activeClients.forEach((socket) => {
			if (socket.connected) socket.disconnect();
		});
		activeClients = [];
		jest.clearAllMocks();
	});

	afterAll(async () => {
		await app.close();
	});

	// ===========================================================================
	// SUCCESSFUL MATCH FLOW
	// ===========================================================================

	describe('Successful Match Flow', () => {
		it('should create game via GameService when both players accept', (done) => {
			const p1Id = 1001;
			const p2Id = 1002;
			const elo = 1500;

			// Mock services
			getUserEloSpy.mockResolvedValue(elo);
			createGameSpy.mockResolvedValue({
				success: true,
				gameId: 'test-game-uuid',
				message: 'Game created successfully',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			let matchId: string;
			let gameServiceCalled = false;
			let p1Confirmed = false;
			let p2Confirmed = false;

			const checkCompletion = () => {
				if (gameServiceCalled && p1Confirmed && p2Confirmed) {
					// Verify GameService was called with correct parameters
					expect(createGameSpy).toHaveBeenCalledWith({
						gameId: matchId,
						player1Id: String(p1Id),
						player2Id: String(p2Id),
					});
					done();
				}
			};

			// Handle match proposal - both accept
			client1.on('match_proposal', (data) => {
				matchId = data.matchId;
				client1.emit('accept_match', { matchId: data.matchId });
			});

			client2.on('match_proposal', (data) => {
				client2.emit('accept_match', { matchId: data.matchId });
			});

			// Handle match confirmed
			client1.on('match_confirmed', (data) => {
				try {
					expect(data.gameId).toBeDefined();
					expect(data.player1Id).toBe(String(p1Id));
					expect(data.player2Id).toBe(String(p2Id));
					p1Confirmed = true;
					checkCompletion();
				} catch (e) {
					done(e);
				}
			});

			client2.on('match_confirmed', (data) => {
				try {
					expect(data.gameId).toBeDefined();
					p2Confirmed = true;
					gameServiceCalled = true; // If confirmed, game was created
					checkCompletion();
				} catch (e) {
					done(e);
				}
			});

			// Join queue when connected
			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);

		it('should include gameId in match_confirmed payload', (done) => {
			const p1Id = 1003;
			const p2Id = 1004;
			const elo = 1600;
			const expectedGameId = 'unique-game-id-12345';

			getUserEloSpy.mockResolvedValue(elo);
			createGameSpy.mockResolvedValue({
				success: true,
				gameId: expectedGameId,
				message: 'Game created',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			client1.on('match_proposal', (data) => {
				client1.emit('accept_match', { matchId: data.matchId });
			});

			client2.on('match_proposal', (data) => {
				client2.emit('accept_match', { matchId: data.matchId });
			});

			client1.on('match_confirmed', (data) => {
				try {
					// Note: The actual gameId comes from the match UUID, not our mock
					// because finalizeMatch uses match.matchId for the request
					expect(data.gameId).toBeDefined();
					expect(typeof data.gameId).toBe('string');
					expect(data.gameId.length).toBeGreaterThan(0);
					done();
				} catch (e) {
					done(e);
				}
			});

			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);
	});

	// ===========================================================================
	// GAME CREATION FAILURE SCENARIOS
	// ===========================================================================

	describe('Game Creation Failure Handling', () => {
		it('should emit match_failed when GameService returns failure', (done) => {
			const p1Id = 2001;
			const p2Id = 2002;
			const elo = 1400;

			getUserEloSpy.mockResolvedValue(elo);
			createGameSpy.mockResolvedValue({
				success: false,
				error: 'GAME_ALREADY_EXISTS',
				message: 'Game with this ID already exists',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			let p1Failed = false;
			let p2Failed = false;

			const checkCompletion = () => {
				if (p1Failed && p2Failed) {
					done();
				}
			};

			client1.on('match_proposal', (data) => {
				client1.emit('accept_match', { matchId: data.matchId });
			});

			client2.on('match_proposal', (data) => {
				client2.emit('accept_match', { matchId: data.matchId });
			});

			client1.on('match_failed', (data) => {
				try {
					expect(data.reason).toBe('game_creation_failed');
					expect(data.errorCode).toBe('GAME_ALREADY_EXISTS');
					expect(data.message).toBeDefined();
					p1Failed = true;
					checkCompletion();
				} catch (e) {
					done(e);
				}
			});

			client2.on('match_failed', (data) => {
				try {
					expect(data.reason).toBe('game_creation_failed');
					p2Failed = true;
					checkCompletion();
				} catch (e) {
					done(e);
				}
			});

			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);

		it('should re-queue both players with priority after game creation failure', (done) => {
			const p1Id = 2003;
			const p2Id = 2004;
			const elo = 1350;

			getUserEloSpy.mockResolvedValue(elo);
			createGameSpy.mockResolvedValue({
				success: false,
				error: 'PLAYER_ALREADY_IN_GAME',
				message: 'Player is already in a game',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			let p1QueueCount = 0;
			let p2QueueCount = 0;
			let p1PriorityJoin = false;
			let p2PriorityJoin = false;

			const checkCompletion = () => {
				if (p1PriorityJoin && p2PriorityJoin) {
					done();
				}
			};

			client1.on('match_proposal', (data) => {
				client1.emit('accept_match', { matchId: data.matchId });
			});

			client2.on('match_proposal', (data) => {
				client2.emit('accept_match', { matchId: data.matchId });
			});

			// Track queue_joined events
			client1.on('queue_joined', (data) => {
				p1QueueCount++;
				// Second join should be with priority (after failure)
				if (p1QueueCount >= 2 && data.priority === true) {
					p1PriorityJoin = true;
					checkCompletion();
				}
			});

			client2.on('queue_joined', (data) => {
				p2QueueCount++;
				if (p2QueueCount >= 2 && data.priority === true) {
					p2PriorityJoin = true;
					checkCompletion();
				}
			});

			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);

		it('should handle network error gracefully via fallback', (done) => {
			const p1Id = 2005;
			const p2Id = 2006;
			const elo = 1300;

			getUserEloSpy.mockResolvedValue(elo);
			// Simulate fallback response from @Resilient decorator on network error
			createGameSpy.mockResolvedValue({
				success: false,
				error: 'GAME_ALREADY_EXISTS', // Fallback error code
				message: 'Failed to reach Game Service - fallback response',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			client1.on('match_proposal', (data) => {
				client1.emit('accept_match', { matchId: data.matchId });
			});

			client2.on('match_proposal', (data) => {
				client2.emit('accept_match', { matchId: data.matchId });
			});

			client1.on('match_failed', (data) => {
				try {
					expect(data.reason).toBe('game_creation_failed');
					expect(data.message).toContain('fallback');
					done();
				} catch (e) {
					done(e);
				}
			});

			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);
	});

	// ===========================================================================
	// EDGE CASES
	// ===========================================================================

	describe('Edge Cases', () => {
		it('should not create game if only one player accepts', (done) => {
			const p1Id = 3001;
			const p2Id = 3002;
			const elo = 1500;

			getUserEloSpy.mockResolvedValue(elo);
			createGameSpy.mockResolvedValue({
				success: true,
				gameId: 'should-not-be-called',
				message: 'Game created',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			client1.on('match_proposal', (data) => {
				// Only player 1 accepts
				client1.emit('accept_match', { matchId: data.matchId });

				// Wait and verify GameService was NOT called
				setTimeout(() => {
					expect(createGameSpy).not.toHaveBeenCalled();
					done();
				}, 1000);
			});

			client2.on('match_proposal', () => {
				// Player 2 does NOT accept (simulates timeout or disconnect)
			});

			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);

		it('should call GameService only once even with rapid accept calls', (done) => {
			const p1Id = 3003;
			const p2Id = 3004;
			const elo = 1500;

			getUserEloSpy.mockResolvedValue(elo);
			createGameSpy.mockResolvedValue({
				success: true,
				gameId: 'single-call-test',
				message: 'Game created',
			});

			const client1 = connectClient(createToken(p1Id));
			const client2 = connectClient(createToken(p2Id));

			client1.on('match_proposal', (data) => {
				// Rapid duplicate accepts from player 1
				client1.emit('accept_match', { matchId: data.matchId });
				client1.emit('accept_match', { matchId: data.matchId });
				client1.emit('accept_match', { matchId: data.matchId });
			});

			client2.on('match_proposal', (data) => {
				client2.emit('accept_match', { matchId: data.matchId });
			});

			client1.on('match_confirmed', () => {
				// Wait a bit to ensure no duplicate calls
				setTimeout(() => {
					expect(createGameSpy).toHaveBeenCalledTimes(1);
					done();
				}, 200);
			});

			client1.on('connect', () => client1.emit('join_queue', { elo }));
			client2.on('connect', () => client2.emit('join_queue', { elo }));
		}, 10000);
	});
});
