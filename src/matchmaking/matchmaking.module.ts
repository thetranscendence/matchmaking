import { Module } from 'my-fastify-decorators';
import { MatchmakingController } from './matchmaking.controller.js';
import { MatchmakingService } from './matchmaking.service.js';
import { MatchmakingGateway } from './matchmaking.gateway.js';
import { UserService } from './user.service.js';
import { GameService } from './game.service.js';

@Module({
	controllers: [MatchmakingController],
	gateways: [MatchmakingGateway],
	providers: [MatchmakingService, UserService, GameService],
})
export class MatchmakingModule {}
