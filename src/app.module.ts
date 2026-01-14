import { Module } from 'my-fastify-decorators';
import { MatchmakingModule } from './matchmaking/matchmaking.module.js';

@Module({
	imports: [
	MatchmakingModule,
],
})
export class AppModule {}
