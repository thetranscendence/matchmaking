import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { GameService, type CreateGameInput } from './game.service.js';

// =============================================================================
// UNIT TESTS FOR GAME SERVICE
// =============================================================================

/**
 * Unit tests for GameService.
 *
 * These tests verify the HTTP communication layer between Matchmaking and Game services.
 * We mock the global `fetch` function to simulate various scenarios:
 * - Successful game creation (HTTP 201)
 * - Business errors (HTTP 409 - Conflict)
 * - Network errors (ECONNREFUSED, timeouts)
 * - Invalid response data
 * - Server errors (HTTP 5xx)
 *
 * @remarks
 * The tests focus on the service's behavior, not the actual network calls.
 * The @Resilient decorator is exercised naturally through these tests,
 * verifying that fallback values are returned on network/server errors.
 */
describe('GameService Unit Tests', () => {
	let gameService: GameService;

	// Store original fetch and env to restore after tests
	const originalFetch = global.fetch;
	const originalEnv = process.env.GAME_SERVICE_URL;

	// Sample input for most tests
	const sampleInput: CreateGameInput = {
		gameId: '550e8400-e29b-41d4-a716-446655440000',
		player1Id: '100',
		player2Id: '200',
	};

	beforeEach(() => {
		// Set up environment variable for tests
		process.env.GAME_SERVICE_URL = 'http://game:3000';

		// Create a fresh instance for each test
		gameService = new GameService();
	});

	afterEach(() => {
		// Restore original fetch after each test
		global.fetch = originalFetch;

		// Restore environment
		if (originalEnv === undefined) {
			delete process.env.GAME_SERVICE_URL;
		} else {
			process.env.GAME_SERVICE_URL = originalEnv;
		}

		jest.restoreAllMocks();
	});

	// ===========================================================================
	// SUCCESS SCENARIOS (HTTP 201 Created)
	// ===========================================================================

	describe('createGame - Success Cases (HTTP 201)', () => {
		it('should successfully create a game and return valid success response', async () => {
			// Arrange: Mock successful HTTP 201 response
			const mockResponse = {
				success: true,
				gameId: sampleInput.gameId,
				message: 'Game created successfully',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: true,
					status: 201,
					json: () => Promise.resolve(mockResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.gameId).toBe(sampleInput.gameId);
				expect(result.message).toBe('Game created successfully');
			}

			// Verify fetch was called with correct parameters
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(global.fetch).toHaveBeenCalledWith(
				'http://game:3000/games',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						gameId: sampleInput.gameId,
						player1Id: sampleInput.player1Id,
						player2Id: sampleInput.player2Id,
					}),
				}),
			);
		});

		it('should handle custom gameId formats (not just UUID)', async () => {
			// Arrange: Custom gameId format like "match-{uuid}" or "game-{timestamp}"
			const customInput: CreateGameInput = {
				gameId: 'match-abc123-def456',
				player1Id: '42',
				player2Id: '43',
			};

			const mockResponse = {
				success: true,
				gameId: customInput.gameId,
				message: 'Game created successfully',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 201,
					json: () => Promise.resolve(mockResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(customInput);

			// Assert
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.gameId).toBe('match-abc123-def456');
			}
		});
	});

	// ===========================================================================
	// BUSINESS ERROR SCENARIOS (HTTP 409 Conflict)
	// ===========================================================================

	describe('createGame - Business Errors (HTTP 409)', () => {
		it('should return error response when game already exists', async () => {
			// Arrange: HTTP 409 with GAME_ALREADY_EXISTS
			const mockResponse = {
				success: false,
				error: 'GAME_ALREADY_EXISTS',
				message: 'A game with this ID already exists',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 409,
					json: () => Promise.resolve(mockResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert: Should return the error response, NOT fallback
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('GAME_ALREADY_EXISTS');
				expect(result.message).toBe('A game with this ID already exists');
			}
		});

		it('should return error response when player is already in a game', async () => {
			// Arrange: HTTP 409 with PLAYER_ALREADY_IN_GAME
			const mockResponse = {
				success: false,
				error: 'PLAYER_ALREADY_IN_GAME',
				message: 'Player 100 is already in an active game',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 409,
					json: () => Promise.resolve(mockResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('PLAYER_ALREADY_IN_GAME');
				expect(result.message).toContain('Player 100');
			}
		});

		it('should return error response when players are invalid', async () => {
			// Arrange: HTTP 409 with INVALID_PLAYERS
			const mockResponse = {
				success: false,
				error: 'INVALID_PLAYERS',
				message: 'Player IDs cannot be the same',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 409,
					json: () => Promise.resolve(mockResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('INVALID_PLAYERS');
			}
		});
	});

	// ===========================================================================
	// NETWORK ERROR SCENARIOS - FALLBACK
	// ===========================================================================

	describe('createGame - Network Error Fallback', () => {
		it('should return fallback on network connection refused', async () => {
			// Arrange: Simulate ECONNREFUSED
			global.fetch = jest.fn(() =>
				Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3000')),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert: Should return fallback, not throw
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe('GAME_ALREADY_EXISTS'); // Fallback error code
				expect(result.message).toContain('fallback');
			}
		});

		it('should return fallback on fetch timeout', async () => {
			// Arrange: Simulate a delayed response that exceeds timeout
			global.fetch = jest.fn(
				() =>
					new Promise((resolve) => {
						// This will be slower than the 3000ms timeout in the service
						// But the @Resilient decorator should timeout first
						setTimeout(() => {
							resolve({
								status: 201,
								json: () =>
									Promise.resolve({
										success: true,
										gameId: 'too-late',
										message: 'Game created',
									}),
							} as Response);
						}, 5000);
					}),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert: Should return fallback due to timeout
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('fallback');
			}
		}, 10000); // Extended timeout for this test

		it('should return fallback on DNS resolution failure', async () => {
			// Arrange: Simulate DNS failure
			global.fetch = jest.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND game')));

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('fallback');
			}
		});
	});

	// ===========================================================================
	// SERVER ERROR SCENARIOS - FALLBACK
	// ===========================================================================

	describe('createGame - Server Error Fallback', () => {
		it('should return fallback on HTTP 500 Internal Server Error', async () => {
			// Arrange
			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 500,
					statusText: 'Internal Server Error',
					text: () => Promise.resolve('Server crashed'),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert: Should return fallback
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('fallback');
			}
		});

		it('should return fallback on HTTP 404 Not Found', async () => {
			// Arrange
			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Endpoint not found'),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
		});

		it('should return fallback on HTTP 503 Service Unavailable', async () => {
			// Arrange
			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 503,
					statusText: 'Service Unavailable',
					text: () => Promise.resolve('Service temporarily unavailable'),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// VALIDATION ERROR SCENARIOS - FALLBACK
	// ===========================================================================

	describe('createGame - Validation Error Fallback', () => {
		it('should return fallback when response is missing required fields', async () => {
			// Arrange: Success response missing 'message' field
			const invalidResponse = {
				success: true,
				gameId: sampleInput.gameId,
				// missing: message (required for success response)
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 201,
					json: () => Promise.resolve(invalidResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert: @ValidateResult should fail, triggering @Resilient fallback
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('fallback');
			}
		});

		it('should return fallback when gameId has wrong type', async () => {
			// Arrange: gameId is number instead of string
			const invalidResponse = {
				success: true,
				gameId: 12345, // Should be string
				message: 'Game created',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 201,
					json: () => Promise.resolve(invalidResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
		});

		it('should return fallback when success has wrong type', async () => {
			// Arrange: success is string instead of boolean
			const invalidResponse = {
				gameId: sampleInput.gameId,
				success: 'true', // Should be boolean literal true
				message: 'Game created',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 201,
					json: () => Promise.resolve(invalidResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
		});

		it('should return fallback when error response has invalid error code', async () => {
			// Arrange: Invalid error code not in enum
			const invalidResponse = {
				success: false,
				error: 'UNKNOWN_ERROR', // Not in the valid enum
				message: 'Something went wrong',
			};

			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 409,
					json: () => Promise.resolve(invalidResponse),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert: Validation should fail
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('fallback');
			}
		});

		it('should return fallback on malformed JSON response', async () => {
			// Arrange: json() throws error
			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 201,
					json: () => Promise.reject(new Error('Unexpected token in JSON')),
				} as Response),
			);

			// Act
			const result = await gameService.createGame(sampleInput);

			// Assert
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// HEALTH CHECK TESTS
	// ===========================================================================

	describe('isHealthy', () => {
		it('should return true when Game Service is reachable', async () => {
			// Arrange
			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
				} as Response),
			);

			// Act
			const result = await gameService.isHealthy();

			// Assert
			expect(result).toBe(true);
			expect(global.fetch).toHaveBeenCalledWith(
				'http://game:3000/health',
				expect.objectContaining({ method: 'GET' }),
			);
		});

		it('should return false when Game Service returns non-ok status', async () => {
			// Arrange
			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: false,
					status: 503,
				} as Response),
			);

			// Act
			const result = await gameService.isHealthy();

			// Assert
			expect(result).toBe(false);
		});

		it('should return false when Game Service is unreachable', async () => {
			// Arrange
			global.fetch = jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

			// Act
			const result = await gameService.isHealthy();

			// Assert
			expect(result).toBe(false);
		});

		it('should return false on health check timeout (abort signal triggered)', async () => {
			// Arrange: Simulate AbortError which is what AbortSignal.timeout throws
			global.fetch = jest.fn(() =>
				Promise.reject(new DOMException('The operation was aborted', 'AbortError')),
			);

			// Act
			const result = await gameService.isHealthy();

			// Assert
			expect(result).toBe(false);
		});
	});

	// ===========================================================================
	// ENVIRONMENT CONFIGURATION TESTS
	// ===========================================================================

	describe('Environment Configuration', () => {
		it('should use GAME_SERVICE_URL from environment when set', async () => {
			// Arrange: Set custom environment variable
			process.env.GAME_SERVICE_URL = 'http://custom-game-service:4000';

			// Create new instance to pick up env var
			const customService = new GameService();

			global.fetch = jest.fn(() =>
				Promise.resolve({
					status: 201,
					json: () =>
						Promise.resolve({
							success: true,
							gameId: sampleInput.gameId,
							message: 'Game created',
						}),
				} as Response),
			);

			// Act
			await customService.createGame(sampleInput);

			// Assert
			expect(global.fetch).toHaveBeenCalledWith(
				'http://custom-game-service:4000/games',
				expect.anything(),
			);
		});
	});
});
