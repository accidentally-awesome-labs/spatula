import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ActionCard } from '../../../../src/components/review/ActionCard.js';

describe('ActionCard', () => {
  it('renders action type and confidence percentage', () => {
    const action = {
      type: 'add_field',
      confidence: 0.92,
      payload: { name: 'title', fieldType: 'string' },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={5} />);
    const frame = lastFrame()!;
    expect(frame).toContain('add_field');
    expect(frame).toContain('92%');
  });

  it('shows reasoning text', () => {
    const action = {
      type: 'add_field',
      confidence: 0.8,
      reasoning: 'Field found consistently across all pages',
      payload: { name: 'price', fieldType: 'number' },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Reasoning:');
    expect(frame).toContain('Field found consistently across all pages');
  });

  it('shows source label', () => {
    const action = {
      type: 'add_field',
      confidence: 0.75,
      source: 'schema-evolution-engine',
      payload: { name: 'description', fieldType: 'string' },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Source:');
    expect(frame).toContain('schema-evolution-engine');
  });

  it('shows payload summary for add_field', () => {
    const action = {
      type: 'add_field',
      confidence: 0.9,
      payload: {
        name: 'title',
        fieldType: 'string',
        required: true,
        description: 'The product title',
      },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    const frame = lastFrame()!;
    expect(frame).toContain('title');
    expect(frame).toContain('string');
    expect(frame).toContain('required');
    expect(frame).toContain('The product title');
  });

  it('shows payload summary for merge_fields', () => {
    const action = {
      type: 'merge_fields',
      confidence: 0.88,
      payload: {
        aliases: ['cost', 'price_usd'],
        canonical: 'price',
      },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    const frame = lastFrame()!;
    expect(frame).toContain('cost');
    expect(frame).toContain('price_usd');
    expect(frame).toContain('price');
  });

  it('color-codes confidence level', () => {
    // High confidence
    const highAction = {
      type: 'add_field',
      confidence: 0.95,
      payload: { name: 'a' },
    };
    const { lastFrame: highFrame } = render(
      <ActionCard action={highAction} index={0} total={1} />,
    );
    expect(highFrame()!).toContain('95%');

    // Medium confidence
    const medAction = {
      type: 'add_field',
      confidence: 0.7,
      payload: { name: 'b' },
    };
    const { lastFrame: medFrame } = render(
      <ActionCard action={medAction} index={0} total={1} />,
    );
    expect(medFrame()!).toContain('70%');

    // Low confidence
    const lowAction = {
      type: 'add_field',
      confidence: 0.4,
      payload: { name: 'c' },
    };
    const { lastFrame: lowFrame } = render(
      <ActionCard action={lowAction} index={0} total={1} />,
    );
    expect(lowFrame()!).toContain('40%');
  });

  it('shows risk level label (LOW/MEDIUM/HIGH)', () => {
    const lowRisk = {
      type: 'add_field',
      confidence: 0.9,
      payload: { name: 'a' },
    };
    const { lastFrame: lowFrame } = render(
      <ActionCard action={lowRisk} index={0} total={1} />,
    );
    expect(lowFrame()!).toContain('LOW');

    const medRisk = {
      type: 'add_field',
      confidence: 0.7,
      payload: { name: 'b' },
    };
    const { lastFrame: medFrame } = render(
      <ActionCard action={medRisk} index={0} total={1} />,
    );
    expect(medFrame()!).toContain('MEDIUM');

    const highRisk = {
      type: 'add_field',
      confidence: 0.4,
      payload: { name: 'c' },
    };
    const { lastFrame: highFrame } = render(
      <ActionCard action={highRisk} index={0} total={1} />,
    );
    expect(highFrame()!).toContain('HIGH');
  });
});
