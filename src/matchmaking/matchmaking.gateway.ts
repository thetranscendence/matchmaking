import Ajv from 'ajv';
import ajvFormats from 'ajv-formats';
import {
	Inject,
	WebSocketGateway,
	SubscribeConnection,
	SubscribeDisconnection,
	SubscribeMessage,
	ConnectedSocket,
	MessageBody,
	JWTBody,
} from 'my-fastify-decorators';
import { Server, Socket } from 'socket.io';
import { MatchmakingService } from './matchmaking.service.js';
import { UserService } from './user.service.js';
import type { JwtPayload } from './types.js';

// Instance AJV pour la validation des payloads WebSocket
const ajv = new Ajv.default({ allErrors: true, coerceTypes: false });
ajvFormats.default(ajv);

/**
 * Schéma de validation pour la demande de rejoindre la file.
 */
const JoinQueueSchema = {
	type: 'object',
	properties: {
		elo: { type: 'integer', minimum: 0 },
	},
	additionalProperties: true,
};

/**
 * Schéma de validation pour la réponse à une proposition de match.
 * On attend simplement l'ID du match concerné.
 */
const MatchDecisionSchema = {
	type: 'object',
	properties: {
		matchId: { type: 'string', format: 'uuid' },
	},
	required: ['matchId'],
	additionalProperties: true,
};

// Compilation des schémas pour de meilleures performances
const validateJoinQueue = ajv.compile<{ elo?: number }>(JoinQueueSchema);
const validateMatchDecision = ajv.compile<{ matchId: string }>(MatchDecisionSchema);

/**
 * Extension du type Socket pour inclure nos données de session.
 */
interface AuthenticatedSocket extends Socket {
	data: {
		userId?: string;
		elo?: number;
	};
}

@WebSocketGateway()
export class MatchmakingGateway {
	@Inject(MatchmakingService)
	private matchmakingService!: MatchmakingService;

	@Inject(UserService)
	private userService!: UserService;

	/**
	 * Hook de cycle de vie : Initialisation du Gateway.
	 * Capture l'instance du serveur Socket.io et la transmet au service
	 * pour permettre les notifications serveur -> client (Feedback Loop).
	 * @param server - L'instance du serveur Socket.io
	 */
	public afterInit(server: Server): void {
		console.info('[MatchmakingGateway] [afterInit] WebSocket Gateway initialized.');

		if (this.matchmakingService) {
			this.matchmakingService.setServer(server);
		} else {
			console.error(
				'[MatchmakingGateway] [afterInit] CRITICAL: MatchmakingService is not available during init.',
			);
		}
	}

	/**
	 * WebSocket connection handler.
	 *
	 * This method is invoked when a client establishes a WebSocket connection to the
	 * Matchmaking Gateway. It performs authentication and initial data loading:
	 *
	 * 1. Validates the JWT token extracted by the @JWTBody decorator
	 * 2. Fetches the user's current Elo rating from the User Service
	 * 3. Stores session data on the socket for subsequent message handlers
	 *
	 * @remarks
	 * - The JWT `id` field is a number from the Auth Service but is converted to string
	 *   for internal use (UserService API, socket session storage, etc.)
	 * - Connection is rejected if JWT is missing/invalid or if User Service is unavailable
	 * - The Elo rating is frozen at connection time (snapshot) to ensure fair matchmaking
	 *
	 * @param socket - The authenticated WebSocket client
	 * @param user - The decoded JWT payload from the handshake auth token
	 */
	@SubscribeConnection()
	public async handleConnection(
		@ConnectedSocket() socket: AuthenticatedSocket,
		@JWTBody() user: JwtPayload,
	): Promise<void> {
		const socketId = socket.id;

		// Step 1: Strict Guard - JWT must be valid and contain user identifier
		// The 'id' field comes from the Auth Service (see apps/auth/src/auth/auth.service.ts)
		// Note: We check for both 'id' existence and validity (must be a positive number)
		if (!user || typeof user.id !== 'number' || user.id <= 0) {
			console.warn(
				`[MatchmakingGateway] [Connection] Rejected: Missing or invalid JWT payload | SocketId: ${socketId}`,
				{ receivedPayload: user ? { id: user.id, hasUsername: !!user.username } : 'null' },
			);
			socket.disconnect(true);
			return;
		}

		// Convert numeric ID to string for internal service compatibility
		// All internal services (UserService, MatchmakingService) expect string IDs
		const userId = String(user.id);

		try {
			// Step 2: Fetch critical user data from User Service (strict mode - no silent fallback)
			// This ensures we have accurate Elo for fair matchmaking
			const elo = await this.userService.getUserElo(userId);

			// Validate received data - reject connection if data is corrupted
			if (typeof elo !== 'number' || elo < 0) {
				throw new Error(`Invalid Elo received from UserService: ${elo}`);
			}

			// Step 3: Initialize socket session with authenticated user data
			// This data persists for the lifetime of the connection and is used
			// by all subsequent message handlers (join_queue, accept_match, etc.)
			socket.data.userId = userId;
			socket.data.elo = elo;

			console.info(
				`[MatchmakingGateway] [Connection] Client connected | UserId: ${userId} | ` +
					`Username: ${user.username || 'N/A'} | Elo: ${elo} | SocketId: ${socketId}`,
			);
		} catch (error) {
			// Connection failure - either User Service is down or returned invalid data
			// We fail-fast to prevent degraded user experience
			console.error(
				`[MatchmakingGateway] [Connection] Critical error loading user data | UserId: ${userId}`,
				error,
			);
			socket.disconnect(true);
		}
	}

	/**
	 * Gestionnaire de déconnexion.
	 * Nettoie proprement la file d'attente si nécessaire.
	 */
	@SubscribeDisconnection()
	public handleDisconnect(@ConnectedSocket() socket: AuthenticatedSocket): void {
		const userId = socket.data.userId;

		if (userId) {
			// removePlayer est idempotente, on peut l'appeler sans risque
			this.matchmakingService.removePlayer(userId);
			console.debug(
				`[MatchmakingGateway] [Disconnection] Session closed & cleaned | UserId: ${userId}`,
			);
		}
	}

	/**
	 * Demande pour rejoindre la file de matchmaking.
	 */
	@SubscribeMessage('join_queue')
	public async handleJoinQueue(
		@ConnectedSocket() socket: AuthenticatedSocket,
		@MessageBody() payload: unknown,
	): Promise<void> {
		const userId = socket.data.userId;
		const sessionElo = socket.data.elo;

		if (!userId || sessionElo === undefined) {
			console.error(`[MatchmakingGateway] [JoinQueue] Unauthenticated socket tried to join queue.`);
			socket.disconnect(true);
			return;
		}

		const payloadData = (payload || {}) as { elo?: number };
		const isValid = validateJoinQueue(payloadData);

		if (!isValid) {
			console.warn(`[MatchmakingGateway] [JoinQueue] Invalid payload from User ${userId}`);
			socket.emit('error', {
				message: 'Invalid payload',
				details: validateJoinQueue.errors,
			});
			return;
		}

		try {
			const effectiveElo = payloadData.elo ?? sessionElo;

			// Note: Le paramètre priority est false par défaut lors d'un join manuel
			await this.matchmakingService.addPlayer(userId, socket.id, effectiveElo);

			socket.emit('queue_joined', {
				userId,
				elo: effectiveElo,
				timestamp: Date.now(),
			});

			console.info(
				`[MatchmakingGateway] [JoinQueue] Player joined | UserId: ${userId} | Elo: ${effectiveElo}`,
			);
		} catch (error: any) {
			console.warn(
				`[MatchmakingGateway] [JoinQueue] Failed | UserId: ${userId} | Reason: ${error.message}`,
			);
			socket.emit('error', { message: error.message });
		}
	}

	/**
	 * Demande pour quitter volontairement la file.
	 */
	@SubscribeMessage('leave_queue')
	public handleLeaveQueue(@ConnectedSocket() socket: AuthenticatedSocket): void {
		const userId = socket.data.userId;

		if (userId) {
			this.matchmakingService.removePlayer(userId);
			socket.emit('queue_left', { userId, timestamp: Date.now() });
			console.info(`[MatchmakingGateway] [LeaveQueue] Player left manually | UserId: ${userId}`);
		}
	}

	/**
	 * Acceptation d'une proposition de match.
	 */
	@SubscribeMessage('accept_match')
	public async handleAcceptMatch(
		@ConnectedSocket() socket: AuthenticatedSocket,
		@MessageBody() payload: unknown,
	): Promise<void> {
		const userId = socket.data.userId;
		if (!userId) return;

		const payloadData = (payload || {}) as { matchId: string };
		if (!validateMatchDecision(payloadData)) {
			socket.emit('error', { message: 'Invalid payload for accept_match' });
			return;
		}

		try {
			await this.matchmakingService.acceptMatch(userId, payloadData.matchId);
			// Feedback immédiat au client qui a accepté (optionnel, l'event global suivra)
			console.debug(
				`[MatchmakingGateway] [AcceptMatch] Ack | UserId: ${userId} | MatchId: ${payloadData.matchId}`,
			);
		} catch (error: any) {
			console.warn(
				`[MatchmakingGateway] [AcceptMatch] Error | UserId: ${userId} | Reason: ${error.message}`,
			);
			socket.emit('error', { message: error.message });
		}
	}

	/**
	 * Refus d'une proposition de match.
	 */
	@SubscribeMessage('decline_match')
	public async handleDeclineMatch(
		@ConnectedSocket() socket: AuthenticatedSocket,
		@MessageBody() payload: unknown,
	): Promise<void> {
		const userId = socket.data.userId;
		if (!userId) return;

		const payloadData = (payload || {}) as { matchId: string };
		if (!validateMatchDecision(payloadData)) {
			socket.emit('error', { message: 'Invalid payload for decline_match' });
			return;
		}

		try {
			await this.matchmakingService.declineMatch(userId, payloadData.matchId);
			console.info(
				`[MatchmakingGateway] [DeclineMatch] Processed | UserId: ${userId} | MatchId: ${payloadData.matchId}`,
			);
		} catch (error: any) {
			console.warn(
				`[MatchmakingGateway] [DeclineMatch] Error | UserId: ${userId} | Reason: ${error.message}`,
			);
			socket.emit('error', { message: error.message });
		}
	}
}
