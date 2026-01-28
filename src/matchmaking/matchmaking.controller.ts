import { Controller, Get, Inject } from 'my-fastify-decorators';
import { MatchmakingService } from './matchmaking.service.js';

@Controller('/matchmaking')
export class MatchmakingController {
	@Inject(MatchmakingService)
	private matchmakingService!: MatchmakingService;

	/**
	 * Endpoint de Debug / Monitoring.
	 * URL: GET /matchmaking/queue
	 * Retourne l'état actuel de la file d'attente (taille et temps d'attente).
	 * Utile pour valider visuellement que les sockets ajoutent bien les joueurs en mémoire.
	 */
	@Get('/queue')
	public async getQueueStatsHandler() {
		console.debug('[MatchmakingController] [getQueueStatsHandler] Queue stats requested.');

		const stats = this.matchmakingService.getQueueStats();

		console.debug(
      `[MatchmakingController] [getQueueStatsHandler] Returning stats | Size: ${stats.size} | Pending: ${stats.pending}`
    );

		return stats;
	}
}