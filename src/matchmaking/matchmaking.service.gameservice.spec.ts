import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MatchmakingService } from './matchmaking.service.js';
import { MatchHistoryRepository } from './repositories/match-history.repository.js';
import { PenaltyRepository } from './repositories/penalty.repository.js';
import { GameService, type CreateGameResponseDto } from './game.service.js';
import type { Server } from 'socket.io';

// =============================================================================
// UNIT TESTS FOR GAMESERVICE INTEGRATION IN MATCHMAKING SERVICE
// =============================================================================
//
// These tests verify the integration between MatchmakingService and GameService,
// specifically testing the `finalizeMatch()` method behavior when:
// - Game creation succeeds (HTTP 201 from Game Service)
// - Game creation fails (business errors or network failures)
//
// The tests mock all dependencies (GameService, repositories, Socket.IO server)
// to isolate the MatchmakingService behavior.
//
// NOTE: The matchmaking loop runs every 1000ms, so we wait 1100ms for it to
// process the queue. Full integration tests with real WebSocket connections
// are in matchmaking-game.integration.spec.ts.
//
// =============================================================================

// Increase Jest timeout for tests that wait for matchmaking loop
jest.setTimeout(15000);

describe('MatchmakingService - GameService Integration', () => {
	let matchmakingService: MatchmakingService;
	let mockMatchHistoryRepository: jest.Mocked<MatchHistoryRepository>;
	let mockPenaltyRepository: jest.Mocked<PenaltyRepository>;
	let mockGameService: jest.Mocked<GameService>;
	let emittedEvents: Map<string, { event: string; payload: unknown }[]>;
	let mockServer: any;

	// Sample player data for tests
	const player1 = {
		userId: '100',
		socketId: 'socket-100',
		elo: 1500,
	};

	const player2 = {
		userId: '200',
		socketId: 'socket-200',
		elo: 1520,
	};

	/**
	 * Creates a mock Socket.IO server that tracks emitted events.
	 * Uses a proper mock pattern that captures to().emit() calls.
	 */
	const createMockServer = () => {
		emittedEvents = new Map();

		const createEmitter = (socketId: string) => {
			return {
				emit: jest.fn((event: string, payload: unknown) => {
					const events = emittedEvents.get(socketId) || [];
					events.push({ event, payload });
					emittedEvents.set(socketId, events);
					return true;
				}),
			};
		};

		mockServer = {
			to: jest.fn((socketId: string) => createEmitter(socketId)),
			emit: jest.fn((event: string, payload: unknown) => {
				const events = emittedEvents.get('broadcast') || [];
				events.push({ event, payload });
				emittedEvents.set('broadcast', events);
			}),
		};

		return mockServer as unknown as Server;
	};

	/**
	 * Helper to get emitted events for a specific socket.
	 */
	const getSocketEvents = (socketId: string): { event: string; payload: any }[] => {
		return emittedEvents.get(socketId) || [];
	};

	/**
	 * Helper to wait for matchmaking loop to process (TICK_RATE_MS = 1000ms).
	 */
	const waitForMatchmakingLoop = () => new Promise((resolve) => setTimeout(resolve, 1200));

	beforeEach(() => {
		// Create mock repositories
		mockMatchHistoryRepository = {
			createSessionLog: jest.fn(),
		} as unknown as jest.Mocked<MatchHistoryRepository>;

		mockPenaltyRepository = {
			getActivePenalty: jest.fn().mockReturnValue(null),
			addPenalty: jest.fn(),
		} as unknown as jest.Mocked<PenaltyRepository>;

		// Create mock GameService
		mockGameService = {
			createGame: jest.fn(),
			isHealthy: jest.fn().mockResolvedValue(true),
		} as unknown as jest.Mocked<GameService>;

		// Create MatchmakingService instance with mocked dependencies
		matchmakingService = new MatchmakingService(
			mockMatchHistoryRepository,
			mockPenaltyRepository,
			mockGameService,
		);

		// Set the mock server
		matchmakingService.setServer(createMockServer());

		// Initialize the service (starts matchmaking loop)
		matchmakingService.onModuleInit();
	});

	afterEach(() => {
		// Cleanup: call onModuleDestroy to clear intervals and timeouts
		matchmakingService.onModuleDestroy();
		jest.clearAllMocks();
	});

	// ===========================================================================
	// SUCCESS SCENARIOS
	// ===========================================================================

	describe('finalizeMatch - Success Scenarios', () => {
		it('should call GameService.createGame when both players accept', async () => {
			// Arrange: Mock successful game creation
			const successResponse: CreateGameResponseDto = {
				success: true,
				gameId: 'test-game-id',
				message: 'Game created successfully',
			};
			mockGameService.createGame.mockResolvedValue(successResponse);

			// Act: Add both players to queue
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			// Wait for matchmaking loop to create the match proposal
			await waitForMatchmakingLoop();

			// Verify match proposal was emitted
			expect(mockServer.to).toHaveBeenCalledWith(player1.socketId);
			expect(mockServer.to).toHaveBeenCalledWith(player2.socketId);

			// Get the matchId from the to().emit() call
			const toCalls = mockServer.to.mock.calls;
			expect(toCalls.length).toBeGreaterThan(0);

			// Find the match_proposal call
			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');

			if (!proposalEvent) {
				// Debug: print what events were emitted
				console.log('Emitted events:', Object.fromEntries(emittedEvents));
				throw new Error('Match proposal not emitted');
			}

			const matchId = proposalEvent.payload.matchId;

			// Both players accept
			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert: GameService.createGame should have been called
			expect(mockGameService.createGame).toHaveBeenCalledTimes(1);
			expect(mockGameService.createGame).toHaveBeenCalledWith({
				gameId: matchId,
				player1Id: player1.userId,
				player2Id: player2.userId,
			});
		});

		it('should emit match_confirmed to both players on successful game creation', async () => {
			// Arrange
			const successResponse: CreateGameResponseDto = {
				success: true,
				gameId: 'confirmed-game-id',
				message: 'Game created successfully',
			};
			mockGameService.createGame.mockResolvedValue(successResponse);

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert: Both players should receive match_confirmed
			const p1Final = getSocketEvents(player1.socketId);
			const p2Final = getSocketEvents(player2.socketId);

			const p1Confirmed = p1Final.find((e) => e.event === 'match_confirmed');
			const p2Confirmed = p2Final.find((e) => e.event === 'match_confirmed');

			expect(p1Confirmed).toBeDefined();
			expect(p2Confirmed).toBeDefined();
			expect(p1Confirmed?.payload.gameId).toBe('confirmed-game-id');
			expect(p1Confirmed?.payload.player1Id).toBe(player1.userId);
			expect(p1Confirmed?.payload.player2Id).toBe(player2.userId);
		});

		it('should log session start to match history repository', async () => {
			// Arrange
			mockGameService.createGame.mockResolvedValue({
				success: true,
				gameId: 'logged-game-id',
				message: 'Game created',
			});

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert
			expect(mockMatchHistoryRepository.createSessionLog).toHaveBeenCalledWith(
				expect.objectContaining({
					id: matchId,
					player1Id: player1.userId,
					player2Id: player2.userId,
					status: 'STARTED',
				}),
			);
		});
	});

	// ===========================================================================
	// FAILURE SCENARIOS
	// ===========================================================================

	describe('finalizeMatch - Failure Scenarios', () => {
		it('should emit match_failed to both players when game creation fails', async () => {
			// Arrange: Mock failed game creation
			const failureResponse: CreateGameResponseDto = {
				success: false,
				error: 'GAME_ALREADY_EXISTS',
				message: 'Failed to reach Game Service - fallback response',
			};
			mockGameService.createGame.mockResolvedValue(failureResponse);

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert: Both players should receive match_failed
			const p1Final = getSocketEvents(player1.socketId);
			const p2Final = getSocketEvents(player2.socketId);

			const p1Failed = p1Final.find((e) => e.event === 'match_failed');
			const p2Failed = p2Final.find((e) => e.event === 'match_failed');

			expect(p1Failed).toBeDefined();
			expect(p2Failed).toBeDefined();
			expect(p1Failed?.payload.reason).toBe('game_creation_failed');
			expect(p1Failed?.payload.errorCode).toBe('GAME_ALREADY_EXISTS');
		});

		it('should re-queue both players with priority after game creation failure', async () => {
			// Arrange
			mockGameService.createGame.mockResolvedValue({
				success: false,
				error: 'PLAYER_ALREADY_IN_GAME',
				message: 'Player is already in a game',
			});

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Wait for re-queue to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Assert: Both players should receive queue_joined with priority
			const p1Final = getSocketEvents(player1.socketId);
			const p2Final = getSocketEvents(player2.socketId);

			// Find queue_joined events with priority flag
			const p1PriorityJoin = p1Final.find(
				(e) => e.event === 'queue_joined' && e.payload.priority === true,
			);
			const p2PriorityJoin = p2Final.find(
				(e) => e.event === 'queue_joined' && e.payload.priority === true,
			);

			expect(p1PriorityJoin).toBeDefined();
			expect(p2PriorityJoin).toBeDefined();
		});
	});

	// ===========================================================================
	// EDGE CASES
	// ===========================================================================

	describe('finalizeMatch - Edge Cases', () => {
		it('should not call GameService if only one player accepts', async () => {
			// Arrange
			mockGameService.createGame.mockResolvedValue({
				success: true,
				gameId: 'should-not-exist',
				message: 'Game created',
			});

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			// Only player1 accepts
			await matchmakingService.acceptMatch(player1.userId, matchId);

			// Wait to ensure no async calls are made
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Assert: GameService should NOT have been called
			expect(mockGameService.createGame).not.toHaveBeenCalled();
		});

		it('should handle session log failure gracefully (non-blocking)', async () => {
			// Arrange: Session log throws, but game creation should still proceed
			mockMatchHistoryRepository.createSessionLog.mockImplementation(() => {
				throw new Error('Database connection failed');
			});

			mockGameService.createGame.mockResolvedValue({
				success: true,
				gameId: 'game-despite-log-failure',
				message: 'Game created',
			});

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert: Game should still be created despite log failure
			expect(mockGameService.createGame).toHaveBeenCalled();

			const p1Final = getSocketEvents(player1.socketId);
			const p1Confirmed = p1Final.find((e) => e.event === 'match_confirmed');
			expect(p1Confirmed).toBeDefined();
		});

		it('should update queue stats after finalization', async () => {
			// Arrange
			mockGameService.createGame.mockResolvedValue({
				success: true,
				gameId: 'stats-test',
				message: 'Game created',
			});

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert: Queue stats should show no pending matches
			const stats = matchmakingService.getQueueStats();
			expect(stats.pending).toBe(0);
		});

		it('should handle duplicate accept calls gracefully', async () => {
			// Arrange
			mockGameService.createGame.mockResolvedValue({
				success: true,
				gameId: 'duplicate-accept-test',
				message: 'Game created',
			});

			// Act
			await matchmakingService.addPlayer(player1.userId, player1.socketId, player1.elo);
			await matchmakingService.addPlayer(player2.userId, player2.socketId, player2.elo);

			await waitForMatchmakingLoop();

			const p1Events = getSocketEvents(player1.socketId);
			const proposalEvent = p1Events.find((e) => e.event === 'match_proposal');
			expect(proposalEvent).toBeDefined();
			const matchId = proposalEvent!.payload.matchId;

			// Player1 accepts multiple times
			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player1.userId, matchId);
			await matchmakingService.acceptMatch(player2.userId, matchId);

			// Assert: GameService should only be called once
			expect(mockGameService.createGame).toHaveBeenCalledTimes(1);
		});
	});
});
