import type { NormalizedVisit } from '../../src/domain';

const defaults: NormalizedVisit = {
  sourceKey: 'chrome:Default',
  browserId: 'chrome',
  browserName: 'Google Chrome',
  profileId: 'Default',
  profileName: 'Default',
  sourceVisitId: '1',
  visitedAt: new Date('2026-08-03T12:34:56.000Z'),
  title: 'Example page',
  url: 'https://example.com/',
};

export function visit(overrides: Partial<NormalizedVisit> = {}): NormalizedVisit {
  return { ...defaults, ...overrides };
}
