import { describe, expect, test } from 'bun:test';
import { HEDGE_TABLE, impliedProbability, matchHedge, roundProbability , claimProbability } from '../src/hedge.ts';

describe('impliedProbability', () => {
  test.each(HEDGE_TABLE.flatMap(({ p, phrases }) => phrases.map((phrase) => [phrase, p] as const)))(
    'table phrase %p -> %p',
    (phrase, p) => {
      expect(impliedProbability(phrase)).toBeCloseTo(p, 10);
    },
  );

  test.each([
    ['', 0.85],
    ['   ', 0.85],
    ['FOR SURE', 0.95],
    ['Definitely', 0.95],
    ['next year for sure', 0.95],
    ["I'm very confident", 0.9],
    ['I’m confident', 0.9],
    ['I am confident', 0.85],
    ['I Think', 0.65],
    ['I think it will definitely happen', 0.95],
    ['Very Likely', 0.75],
    ['extremely likely', 0.9],
    ['unlikely', 0.25],
    ['it is unlikely', 0.25],
    ['I doubt it', 0.25],
    ['no doubt', 0.95],
    ['There is no chance', 0.1],
    ['it is never going to happen', 0.1],
    ['it is going to happen', 0.85],
    ['I would be willing to bet', 0.85],
    ["shouldn't", 0.85],
    ['we expected', 0.75],
    ['I guarantee you', 0.95],
    ['guaranteed', 0.95],
    ['100% sure', 0.95],
    ['honestly, 50/50', 0.5],
    ['it is a coin flip', 0.5],
    ['we are on track', 0.75],
    ['our goal is', 0.55],
    ['The basic game plan is', 0.75],
  ] as const)('%p -> %p', (hedge, p) => {
    expect(impliedProbability(hedge)).toBeCloseTo(p, 10);
  });

  test('falls back to the claim text only when the hedge has no table phrase', () => {
    expect(impliedProbability('', 'Starship could land on Mars in 2024')).toBeCloseTo(0.4, 10);
    expect(impliedProbability('the plan was', 'we might land in 2024')).toBeCloseTo(0.4, 10);
    expect(impliedProbability('for sure', 'we might land in 2024')).toBeCloseTo(0.95, 10);
    expect(impliedProbability('', 'Robotaxis next year')).toBeCloseTo(0.85, 10);
  });

  test('matchHedge reports the phrase that won', () => {
    expect(matchHedge('very likely')).toEqual({ phrase: 'very likely', p: 0.75 });
    expect(matchHedge('nothing here')).toBeNull();
  });
});

describe('roundProbability', () => {
  test('rounds to 0.05 steps and clamps to [0.05, 0.95]', () => {
    expect(roundProbability(0.72)).toBeCloseTo(0.7, 10);
    expect(roundProbability(0.73)).toBeCloseTo(0.75, 10);
    expect(roundProbability(1)).toBe(0.95);
    expect(roundProbability(0)).toBe(0.05);
    expect(roundProbability(-3)).toBe(0.05);
  });
});

describe('HEDGE_TABLE', () => {
  test('is ordered most to least confident with probabilities on the 0.05 grid', () => {
    const ps = HEDGE_TABLE.map((r) => r.p);
    expect([...ps].sort((a, b) => b - a)).toEqual(ps);
    for (const p of ps) expect(roundProbability(p)).toBeCloseTo(p, 10);
  });
});

describe('spoken forms of table phrases', () => {
  test.each([
    ['100 percent', 0.95],
    ['a hundred percent', 0.95],
    ['one hundred per cent', 0.95],
    ['fifty-fifty', 0.5],
    ['fifty fifty', 0.5],
    ['50-50', 0.5],
    ['without a doubt', 0.95],
    ['no doubt about it', 0.95],
    ['I doubt it', 0.25],
  ])('%p -> %p', (hedge, p) => {
    expect(impliedProbability(hedge)).toBe(p);
  });
});

describe('claimProbability: bets against an event', () => {
  test('a below-even hedge on a negated claim scores the complement', () => {
    expect(claimProbability('no chance', "The iPhone will not get any significant market share.")).toBeCloseTo(0.9, 5);
    expect(claimProbability('unlikely', "Apple won't ship a car by 2025.")).toBeCloseTo(0.75, 5);
    expect(claimProbability('I doubt', 'Robotaxis will never be profitable.')).toBeCloseTo(0.75, 5);
  });
  test('a below-even hedge on a positive claim keeps the table value', () => {
    expect(claimProbability('might', 'Acme will ship the robot in 2027.')).toBeCloseTo(0.4, 5);
    expect(claimProbability('unlikely', 'Acme will ship the robot in 2027.')).toBeCloseTo(0.25, 5);
  });
  test('confident hedges are never flipped, even on negated claims', () => {
    expect(claimProbability('for sure', 'Tesla will not build a cheap car.')).toBeCloseTo(0.95, 5);
    expect(claimProbability('', 'Tesla will not build a cheap car.')).toBeCloseTo(0.85, 5);
  });
  test('new table phrases from real seed quotes', () => {
    expect(impliedProbability("It's just completely obvious")).toBeCloseTo(0.95, 5);
    expect(impliedProbability('We feel confident')).toBeCloseTo(0.9, 5);
    expect(impliedProbability('I feel fairly confident')).toBeCloseTo(0.75, 5);
    expect(impliedProbability("I'm guessing")).toBeCloseTo(0.65, 5);
    expect(impliedProbability('Our hope is that')).toBeCloseTo(0.55, 5);
    expect(impliedProbability('we may')).toBeCloseTo(0.4, 5);
    expect(impliedProbability('potentially')).toBeCloseTo(0.4, 5);
    expect(impliedProbability('launch in May')).toBeCloseTo(0.85, 5);
  });
});
