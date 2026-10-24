import { describe, expect, it } from 'vitest';
import { scoreComparison, type ComparedQuestion } from './compare';

function question(over: Partial<ComparedQuestion> = {}): ComparedQuestion {
  return {
    decisionId: 'd1',
    subject: 'Subject',
    column: 'person',
    failed: false,
    right: true,
    allRight: true,
    sureness: 0.97,
    usd: 0.001,
    currentUsd: 0.01,
    ms: 100,
    answered: 'a',
    expected: 'a',
    ...over,
  };
}

function many(count: number, over: (i: number) => Partial<ComparedQuestion>) {
  return Array.from({ length: count }, (_, i) =>
    question({ decisionId: `d${i}`, subject: `S${i}`, ...over(i) }),
  );
}

describe('scoreComparison', () => {
  it('counts the two columns apart', () => {
    const { columns } = scoreComparison({
      accept: 0.95,
      questions: [
        question({ decisionId: 'a' }),
        question({ decisionId: 'b', right: false, allRight: false }),
        question({ decisionId: 'c', column: 'model' }),
        question({ decisionId: 'd', column: 'model', failed: true, right: false, allRight: false }),
        question({ decisionId: 'e', column: 'model' }),
      ],
    });
    expect(columns.person).toMatchObject({ questions: 2, failed: 0, right: 1 });
    expect(columns.model).toMatchObject({ questions: 3, failed: 1, right: 2 });
    expect(columns.person.usd).toBeCloseTo(0.002);
    expect(columns.model.usd).toBeCloseTo(0.003);
    expect(columns.person.currentUsd).toBeCloseTo(0.02);
  });

  it('counts accepted wrongly and sent to a person at the threshold', () => {
    const { columns } = scoreComparison({
      accept: 0.95,
      questions: [
        question({ sureness: 0.95 }), // accepted, right
        question({ sureness: 0.96, right: false, allRight: false }), // accepted wrongly
        question({ sureness: 0.94 }), // to a person
        question({ sureness: 0.5, right: false, allRight: false }), // to a person
        question({ failed: true, right: false, allRight: false, sureness: 0 }), // neither
      ],
    });
    expect(columns.person).toMatchObject({
      questions: 5,
      failed: 1,
      acceptedWrongly: 1,
      toPerson: 2,
    });
  });

  it('counts a part-wrong placement as accepted wrongly even when its shelf is right', () => {
    const { columns } = scoreComparison({
      accept: 0.9,
      placement: true,
      questions: [question({ sureness: 0.95, right: true, allRight: false })],
    });
    expect(columns.person).toMatchObject({ right: 1, allRight: 0, acceptedWrongly: 1 });
  });

  it('gives allRight only for a comparison of placements', () => {
    const q = [question(), question({ right: true, allRight: false })];
    expect(scoreComparison({ accept: 0.9, questions: q }).columns.person.allRight).toBeUndefined();
    expect(
      scoreComparison({ accept: 0.9, placement: true, questions: q }).columns.person.allRight,
    ).toBe(1);
    expect(
      scoreComparison({ accept: 0.9, placement: true, questions: [question()] }).columns.model
        .allRight,
    ).toBe(0);
  });

  it('suggests the lowest threshold with at most 1% accepted wrongly', () => {
    const questions = [
      ...many(15, () => ({ sureness: 0.9 })),
      ...many(15, () => ({ sureness: 0.89, right: false, allRight: false })),
    ];
    expect(scoreComparison({ accept: 0.95, questions }).suggestedAccept).toBe(0.9);
  });

  it('suggests nothing under 30 answers, or when every answer is wrong', () => {
    expect(
      scoreComparison({ accept: 0.95, questions: many(29, () => ({ sureness: 0.99 })) })
        .suggestedAccept,
    ).toBeNull();
    expect(
      scoreComparison({
        accept: 0.95,
        questions: many(40, () => ({ sureness: 0.99, right: false, allRight: false })),
      }).suggestedAccept,
    ).toBeNull();
  });

  it('ignores failed questions and the model column when suggesting', () => {
    const questions = [
      ...many(30, () => ({ sureness: 0.8 })),
      ...many(10, () => ({ failed: true, right: false, allRight: false, sureness: 0 })),
      ...many(50, () => ({
        column: 'model' as const,
        sureness: 0.6,
        right: false,
        allRight: false,
      })),
    ];
    expect(scoreComparison({ accept: 0.95, questions }).suggestedAccept).toBe(0.5);
  });

  it('lists disagreements with a person, at most 200', () => {
    const questions = [
      ...many(250, () => ({
        right: false,
        allRight: false,
        sureness: 0.7,
        answered: 'x',
        expected: 'y',
      })),
      question({ subject: 'ok' }),
      question({ subject: 'model', column: 'model', right: false, allRight: false }),
      question({ subject: 'failed', failed: true, right: false, allRight: false }),
    ];
    const { disagreements } = scoreComparison({ accept: 0.95, questions });
    expect(disagreements).toHaveLength(200);
    expect(disagreements[0]).toEqual({
      subject: 'S0',
      answered: 'x',
      sureness: 0.7,
      expected: 'y',
    });
    expect(disagreements.some((d) => d.subject === 'ok' || d.subject === 'model')).toBe(false);
  });

  it('takes the median time of the questions that did not fail', () => {
    const { columns } = scoreComparison({
      accept: 0.95,
      questions: [
        question({ ms: 300 }),
        question({ ms: 100 }),
        question({ ms: 200 }),
        question({ ms: 400 }),
        question({ ms: 99999, failed: true, right: false, allRight: false }),
      ],
    });
    expect(columns.person.medianMs).toBe(250);
    expect(columns.model.medianMs).toBeNull();
  });

  it('sums only the known current costs, and is null when none is known', () => {
    const known = scoreComparison({
      accept: 0.9,
      questions: [question({ currentUsd: 0.5 }), question({ currentUsd: null })],
    });
    expect(known.columns.person.currentUsd).toBe(0.5);
    const none = scoreComparison({ accept: 0.9, questions: [question({ currentUsd: null })] });
    expect(none.columns.person.currentUsd).toBeNull();
  });
});
