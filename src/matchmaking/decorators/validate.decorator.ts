import Ajv from 'ajv';
import ajvErrors from 'ajv-errors';

// Instance AJV partagée pour la validation des résultats
const ajv = new Ajv.default({ allErrors: true, $data: true, messages: true, coerceTypes: false });
ajvErrors.default(ajv);

// Cache pour les schémas compilés (évite la recompilation à chaque appel)
const compiledSchemas = new WeakMap<object, Ajv.ValidateFunction>();

/**
 * Décorateur pour valider automatiquement le résultat d'une méthode asynchrone
 * par rapport à un schéma JSON Schema (généré via my-class-validator).
 *
 * Si la validation échoue, une erreur explicite est levée.
 * Cette erreur peut être capturée par un décorateur de résilience parent (ex: @Resilient).
 *
 * @param schema - Le schéma JSON Schema à appliquer sur la valeur de retour.
 */
export function ValidateResult(schema: object) {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: any[]) {
			const methodName = propertyKey;
			const context = target.constructor.name; // Ex: 'UserService'

			// 1. Exécution de la méthode originale (récupération des données brutes)
			const result = await originalMethod.apply(this, args);

			// 2. Compilation du schéma (avec cache)
			let validate = compiledSchemas.get(schema);
			if (!validate) {
				validate = ajv.compile(schema);
				compiledSchemas.set(schema, validate);
			}

			// 3. Validation des données
			const isValid = validate(result);

			if (!isValid) {
				console.warn(
					`[ValidateResult] [${context}] [${methodName}] Validation Failed | Issues: ${JSON.stringify(validate.errors)}`,
				);
				// On lève une erreur pour signaler que le contrat d'interface n'est pas respecté.
				// Cela permet aux mécanismes de fallback (ex: @Resilient) de prendre le relais.
				throw new Error(`Data validation failed for ${methodName}`);
			}

			console.debug(`[ValidateResult] [${context}] [${methodName}] Validation Success.`);

			// 3. Retourne les données validées
			return result;
		};

		return descriptor;
	};
}
