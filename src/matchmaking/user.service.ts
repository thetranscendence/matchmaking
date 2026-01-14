import {
	AdditionalProperties,
	generateSchema,
	IsInt,
	IsRequired,
	Minimum,
} from 'my-class-validator';
import { Service } from 'my-fastify-decorators';
import { Resilient } from './decorators/resilient.decorator.js';
import { ValidateResult } from './decorators/validate.decorator.js';

/**
 * DTO du contrat d'interface avec le User Service.
 */
@AdditionalProperties(true)
class UserEloDto {
	@IsRequired()
	@IsInt()
	@Minimum(0)
	elo!: number;
}

// Génération du schéma JSON Schema pour AJV
const UserEloResponseSchema = generateSchema(UserEloDto);

@Service()
export class UserService {
	private readonly userServiceUrl = process.env.USER_SERVICE_URL || 'http://localhost:3001';

	/**
	 * Point d'entrée public pour récupérer l'Elo.
	 * Fait appel à la méthode interne sécurisée et extrait la donnée utile.
	 */
	public async getUserElo(userId: string): Promise<number> {
		const dto = await this.fetchUserEloDto(userId);
		return dto.elo;
	}

	/**
	 * Méthode interne effectuant l'appel réseau.
	 *
	 * ORDRE DES DÉCORATEURS IMPORTANT :
	 * 1. @Resilient (Extérieur) : Attrape les erreurs de réseau OU de validation.
	 * 2. @ValidateResult (Intérieur) : Vérifie les données reçues. Si invalide -> Throw Error.
	 */
	@Resilient<UserEloDto>({
		context: 'UserService',
		timeoutMs: 1000,
		fallback: { elo: 1000 }, // Le fallback doit respecter le format DTO !
		logAsError: false,
	})
	@ValidateResult(UserEloResponseSchema)
	protected async fetchUserEloDto(userId: string): Promise<UserEloDto> {
		const targetUrl = `${this.userServiceUrl}/users/${userId}/elo`;

		console.debug(`[UserService] [fetchUserEloDto] GET ${targetUrl}`);

		const response = await fetch(targetUrl, {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' },
		});

		if (!response.ok) {
			throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
		}

		// On retourne le JSON brut.
		// C'est @ValidateResult qui se chargera de vérifier s'il correspond au schéma.
		return (await response.json()) as UserEloDto;
	}
}
