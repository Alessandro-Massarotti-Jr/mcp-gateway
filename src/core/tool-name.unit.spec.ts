import { buildToolName, normalizeSegment } from './tool-name.js';
import { ToolError } from './errors.js';

describe('tool-name', () => {
  describe('normalizeSegment', () => {
    it.each([
      ['meu-gateway', 'MEU_GATEWAY'],
      ['meu gateway', 'MEU_GATEWAY'],
      ['Gateway.Producao', 'GATEWAY_PRODUCAO'],
      ['__query__', 'QUERY'],
      ['produção', 'PRODUCAO'],
      ['a---b', 'A_B'],
      ['v2', 'V2'],
    ])('normaliza "%s" para "%s"', (input, expected) => {
      expect(normalizeSegment(input)).toBe(expected);
    });
  });

  describe('buildToolName', () => {
    it('monta o padrão {GATEWAY}_{PROVIDER}_{TOOL}', () => {
      expect(buildToolName('acme', 'POSTGRES', 'QUERY')).toBe('ACME_POSTGRES_QUERY');
    });

    it('ignora o segmento de provider nas tools do próprio gateway', () => {
      expect(buildToolName('acme', null, 'CHECK_PROVIDERS_STATUS')).toBe(
        'ACME_CHECK_PROVIDERS_STATUS',
      );
      expect(buildToolName('acme', undefined, 'CHECK_PROVIDERS_STATUS')).toBe(
        'ACME_CHECK_PROVIDERS_STATUS',
      );
    });

    it('normaliza cada segmento individualmente', () => {
      expect(buildToolName('meu gateway', 'rabbit-mq', 'publish to queue')).toBe(
        'MEU_GATEWAY_RABBIT_MQ_PUBLISH_TO_QUEUE',
      );
    });

    it('lança erro de validação quando nada sobra após a normalização', () => {
      expect(() => buildToolName('---', '???')).toThrow(ToolError);
      expect(() => buildToolName('---', '???')).toThrow(/empty segments/i);
    });
  });
});
