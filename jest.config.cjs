/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest/presets/default-esm',
	testEnvironment: 'node',
	extensionsToTreatAsEsm: ['.ts'],
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				useESM: true,
				tsconfig: '<rootDir>/tsconfig.jest.json',
			},
		],
	},
	moduleNameMapper: {
		'^(\\.{1,2}/.*)\\.js$': '$1',
		'^myFastify-decorators$': '<rootDir>/packages/myfastify-decorators/src/decorators/index.ts',
		'^myClass-validator$': '<rootDir>/packages/myclass-validator/src/index.ts',
	},
};
