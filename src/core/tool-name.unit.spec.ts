import { buildToolName, normalizeSegment } from './tool-name.js';
import { ValidationError } from '../errors/ValidationError.js';

describe('tool-name', () => {
  describe('normalizeSegment', () => {
    it.each([
      ['my-gateway', 'MY_GATEWAY'],
      ['my gateway', 'MY_GATEWAY'],
      ['Gateway.Production', 'GATEWAY_PRODUCTION'],
      ['__query__', 'QUERY'],
      ['naïve', 'NAIVE'],
      ['a---b', 'A_B'],
      ['v2', 'V2'],
    ])('normalizes "%s" into "%s"', (input, expected) => {
      expect(normalizeSegment(input)).toBe(expected);
    });
  });

  describe('buildToolName', () => {
    it('builds the {GATEWAY}_{PROVIDER}_{TOOL} pattern', () => {
      expect(buildToolName('acme', 'POSTGRES', 'QUERY')).toBe('ACME_POSTGRES_QUERY');
    });

    it('ignores the provider segment for gateway-owned tools', () => {
      expect(buildToolName('acme', null, 'CHECK_PROVIDERS_STATUS')).toBe(
        'ACME_CHECK_PROVIDERS_STATUS',
      );
      expect(buildToolName('acme', undefined, 'CHECK_PROVIDERS_STATUS')).toBe(
        'ACME_CHECK_PROVIDERS_STATUS',
      );
    });

    it('normalizes each segment individually', () => {
      expect(buildToolName('my gateway', 'rabbit-mq', 'publish to queue')).toBe(
        'MY_GATEWAY_RABBIT_MQ_PUBLISH_TO_QUEUE',
      );
    });

    it('throws a validation error when nothing is left after normalization', () => {
      expect(() => buildToolName('---', '???')).toThrow(ValidationError);
      expect(() => buildToolName('---', '???')).toThrow(/empty segments/i);
    });
  });
});
