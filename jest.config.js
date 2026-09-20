/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Testes unitários moram ao lado do arquivo que exercitam.
  testMatch: ['**/*.unit.spec.ts'],
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/*.d.ts',
    '!src/**/*.unit.spec.ts',
    '!src/testing/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  transform: {
    '^.+[.]tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // O código-fonte usa especificadores ESM ("./x.js") por causa de module:Node16.
  // Aqui eles voltam a apontar para os .ts. As classes [.] evitam barras
  // invertidas, que já se perderam uma vez e deixaram o padrão amplo demais
  // (chegou a capturar ".cjs" de dentro do node_modules).
  moduleNameMapper: {
    '^([.][.]?/.*)[.]js$': '$1',
  },
};
