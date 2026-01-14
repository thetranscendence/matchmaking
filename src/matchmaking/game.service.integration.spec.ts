import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { GameService, type CreateGameInput } from './game.service.js';

// =============================================================================
// INTEGRATION TESTS FOR GAME SERVICE (Matchmaking -> Game Communication)
// =============================================================================
//
// These tests verify real HTTP communication between the Matchmaking and Game
// services. They require both services to be running (typically via Docker Compose).
//
// Prerequisites:
// - docker compose up (all services running)
// - GAME_SERVICE_URL environment variable set correctly
//
// Run these tests with:
//   GAME_SERVICE_URL=http://localhost:8080/api/game pnpm test -- game.service.integration
//
// Or inside the matchmaking container:
//   GAME_SERVICE_URL=http://game:3000 pnpm test -- game.service.integration
//
// =============================================================================

// Skip integration tests if INTEGRATION_TEST env var is not set
const runIntegration = process.env.INTEGRATION_TEST === 'true';

const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('GameService Integration Tests (Real HTTP)', () => {
	let gameService: GameService;
	let testGameCounter = 0;

	/**
	 * Generate unique game ID for each test to avoid conflicts.
	 * Uses timestamp + counter to ensure uniqueness across test runs.
	 */
	const generateUniqueGameId = (): string => {
		testGameCounter++;
		return `integration-test-${Date.now()}-${testGameCounter}`;
	};

	/**
	 * Generate unique player ID for each test.
	 * Uses high numbers to avoid conflicts with real user IDs.
	 */
	const generateUniquePlayerId = (): string => {
		testGameCounter++;
		return `90${Date.now().toString().slice(-6)}${testGameCounter}`;
	};

	beforeAll(() => {
		// Verify environment is configured
		const gameServiceUrl = process.env.GAME_SERVICE_URL;
		if (!gameServiceUrl) {
			throw new Error(
				'GAME_SERVICE_URL environment variable is required for integration tests.\n' +
					'Set it to the Game Service URL (e.g., http://game:3000 or http://localhost:8080/api/game)',
			);
		}

		console.log(`[Integration Test] Using Game Service URL: ${gameServiceUrl}`);

		gameService = new GameService();
	});

	afterAll(() => {
		// Cleanup if needed
	});

	// ===========================================================================
	// CONNECTIVITY TESTS
	// ===========================================================================

	describe('Service Connectivity', () => {
		it('should reach the Game Service via POST /games (health via actual endpoint)', async () => {
			// Note: Game Service doesn't have a dedicated /health endpoint.
			// We test connectivity by making a real request that will fail validation
			// but prove the service is reachable.

			// Arrange - Use empty strings which will fail validation but reach the service
			const input: CreateGameInput = {
				gameId: generateUniqueGameId(),
				player1Id: generateUniquePlayerId(),
				player2Id: generateUniquePlayerId(),
			};

			// Act
			const result = await gameService.createGame(input);

			// Assert - Any response (success or business error) proves connectivity
			// Only network errors would return fallback with message containing "fallback"
			expect(result.message).not.toContain('fallback');
		});
	});

	// ===========================================================================
	// SUCCESSFUL GAME CREATION
	// ===========================================================================

	describe('Successful Game Creation', () => {
		it('should create a game with valid input and receive success response', async () => {
			// Arrange
			const input: CreateGameInput = {
				gameId: generateUniqueGameId(),
				player1Id: generateUniquePlayerId(),
				player2Id: generateUniquePlayerId(),
			};

			console.log(`[Integration Test] Creating game with ID: ${input.gameId}`);

			// Act
			const result = await gameService.createGame(input);

			// Assert
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.gameId).toBe(input.gameId);
				expect(result.message).toBe('Game created successfully');
			}
		});

		it('should handle UUID-format game IDs from matchmaking', async () => {
			// Arrange - Realistic format from MatchmakingService
			const input: CreateGameInput = {
				gameId: `match-${crypto.randomUUID()}`,
				player1Id: generateUniquePlayerId(),
				player2Id: generateUniquePlayerId(),
			};

			// Act
			const result = await gameService.createGame(input);

			// Assert
			expect(result.success).toBe(true);
		});

		it('should handle rapid sequential game creations', async () => {
			// Arrange - 5 games in rapid succession
			const games: CreateGameInput[] = [];
			for (let i = 0; i < 5; i++) {
				games.push({
					gameId: generateUniqueGameId(),
					player1Id: generateUniquePlayerId(),
					player2Id: generateUniquePlayerId(),
				});
			}

			// Act & Assert - Sequential
			for (const input of games) {
				const result = await gameService.createGame(input);
				expect(result.success).toBe(true);
			}
		});

		it('should handle concurrent game creations', async () => {
			// Arrange - 3 parallel game creations
			const games: CreateGameInput[] = [];
			for (let i = 0; i < 3; i++) {
				games.push({
					gameId: generateUniqueGameId(),
					player1Id: generateUniquePlayerId(),
					player2Id: generateUniquePlayerId(),
				});
			}

			// Act - Fire all in parallel
			const results = await Promise.all(games.map((input) => gameService.createGame(input)));

			// Assert
			for (const result of results) {
				expect(result.success).toBe(true);
			}
		});
	});

	// ===========================================================================
	// BUSINESS ERROR SCENARIOS
	// ===========================================================================

	describe('Business Error Scenarios', () => {
		it('should return GAME_ALREADY_EXISTS when creating duplicate game ID', async () => {
			// Arrange - Create first game
			const sharedGameId = generateUniqueGameId();
			const firstGame: CreateGameInput = {
				gameId: sharedGameId,
				player1Id: generateUniquePlayerId(),
				player2Id: generateUniquePlayerId(),
			};

			const firstResult = await gameService.createGame(firstGame);
			expect(firstResult.success).toBe(true);

			// Act - Try to create same game ID with different players
			const secondGame: CreateGameInput = {
				gameId: sharedGameId, // Same ID!
				player1Id: generateUniquePlayerId(),
				player2Id: generateUniquePlayerId(),
			};

			const result = await gameService.createGame(secondGame);

			// Assert
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('GAME_ALREADY_EXISTS');
				expect(result.message).toContain(sharedGameId);
			}
		});

		it('should return PLAYER_ALREADY_IN_GAME when player1 is already playing', async () => {
			// Arrange - Create game with player1
			const player1Id = generateUniquePlayerId();
			const firstGame: CreateGameInput = {
				gameId: generateUniqueGameId(),
				player1Id: player1Id,
				player2Id: generateUniquePlayerId(),
			};

			const firstResult = await gameService.createGame(firstGame);
			expect(firstResult.success).toBe(true);

			// Act - Try to create new game with same player1
			const secondGame: CreateGameInput = {
				gameId: generateUniqueGameId(),
				player1Id: player1Id, // Already in a game!
				player2Id: generateUniquePlayerId(),
			};

			const result = await gameService.createGame(secondGame);

			// Assert
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('PLAYER_ALREADY_IN_GAME');
				expect(result.message).toContain(player1Id);
			}
		});

		it('should return PLAYER_ALREADY_IN_GAME when player2 is already playing', async () => {
			// Arrange - Create game with player2
			const player2Id = generateUniquePlayerId();
			const firstGame: CreateGameInput = {
				gameId: generateUniqueGameId(),
				player1Id: generateUniquePlayerId(),
				player2Id: player2Id,
			};

			const firstResult = await gameService.createGame(firstGame);
			expect(firstResult.success).toBe(true);

			// Act - Try to create new game with same player2
			const secondGame: CreateGameInput = {
				gameId: generateUniqueGameId(),
				player1Id: generateUniquePlayerId(),
				player2Id: player2Id, // Already in a game!
			};

			const result = await gameService.createGame(secondGame);

			// Assert
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('PLAYER_ALREADY_IN_GAME');
				expect(result.message).toContain(player2Id);
			}
		});
	});

	// ===========================================================================
	// END-TO-END MATCHMAKING SIMULATION
	// ===========================================================================

	describe('Matchmaking Simulation', () => {
		it('should simulate full matchmaking flow: match found -> create game', async () => {
			// Simulate what MatchmakingService.finalizeMatch() will do

			// Step 1: Matchmaking finds two players (simulated)
			const matchId = `match-${crypto.randomUUID()}`;
			const player1 = {
				userId: generateUniquePlayerId(),
				elo: 1500,
			};
			const player2 = {
				userId: generateUniquePlayerId(),
				elo: 1520,
			};

			console.log(`[Matchmaking Simulation] Match found!`);
			console.log(`  Match ID: ${matchId}`);
			console.log(`  Player 1: ${player1.userId} (ELO: ${player1.elo})`);
			console.log(`  Player 2: ${player2.userId} (ELO: ${player2.elo})`);

			// Step 2: Create game via Game Service
			const result = await gameService.createGame({
				gameId: matchId,
				player1Id: player1.userId,
				player2Id: player2.userId,
			});

			// Step 3: Verify game was created
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.gameId).toBe(matchId);
				console.log(`[Matchmaking Simulation] Game created successfully!`);
				console.log(`  Response: ${JSON.stringify(result)}`);
			}

			// Step 4: In real flow, Matchmaking would now emit 'match_confirmed'
			// to both players via WebSocket, and they would connect to Game Gateway
		});
	});
});
