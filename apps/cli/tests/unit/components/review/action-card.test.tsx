import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ActionCard } from '../../../../src/components/review/ActionCard.js';

describe('ActionCard', () => {
  it('renders action type and confidence percentage', () => {
    const action = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.92,
      reasoning: 'Detected in 45% of product pages',
      source: 'schema_evolution',
      payload: {
        field: { name: 'price_currency', type: 'string', description: 'Currency code' },
      },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={5} />);
    const frame = lastFrame()!;
    expect(frame).toContain('add_field');
    expect(frame).toContain('92%');
    expect(frame).toContain('1 of 5');
  });

  it('shows reasoning text', () => {
    const action = {
      id: 'a1',
      type: 'merge_fields',
      confidence: 0.85,
      reasoning: 'Fields "cost" and "price" appear to be synonyms',
      source: 'schema_evolution',
      payload: { canonicalName: 'price', aliasNames: ['cost'] },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    expect(lastFrame()!).toContain('synonyms');
  });

  it('shows source label', () => {
    const action = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.7,
      reasoning: 'Found during reconciliation',
      source: 'reconciliation',
      payload: { field: { name: 'brand', type: 'string', description: '' } },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    expect(lastFrame()!).toContain('reconciliation');
  });

  it('shows payload summary for add_field', () => {
    const action = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.9,
      reasoning: 'Common field',
      source: 'schema_evolution',
      payload: {
        field: { name: 'brand', type: 'string', description: 'Product brand name', required: false },
      },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    const frame = lastFrame()!;
    expect(frame).toContain('brand');
    expect(frame).toContain('string');
  });

  it('shows payload summary for merge_fields', () => {
    const action = {
      id: 'a1',
      type: 'merge_fields',
      confidence: 0.88,
      reasoning: 'Synonyms',
      source: 'schema_evolution',
      payload: { canonicalName: 'price', aliasNames: ['cost', 'retail_price'] },
    };
    const { lastFrame } = render(<ActionCard action={action} index={0} total={1} />);
    const frame = lastFrame()!;
    expect(frame).toContain('price');
    expect(frame).toContain('cost');
    expect(frame).toContain('retail_price');
  });

  it('color-codes confidence level', () => {
    // High confidence
    const highAction = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.95,
      reasoning: '',
      source: 'schema_evolution',
      payload: { field: { name: 'x', type: 'string', description: '' } },
    };
    const { lastFrame: highFrame } = render(
      <ActionCard action={highAction} index={0} total={1} />,
    );
    expect(highFrame()!).toContain('95%');

    // Medium confidence
    const medAction = {
      id: 'a2',
      type: 'add_field',
      confidence: 0.7,
      reasoning: '',
      source: 'schema_evolution',
      payload: { field: { name: 'y', type: 'string', description: '' } },
    };
    const { lastFrame: medFrame } = render(
      <ActionCard action={medAction} index={0} total={1} />,
    );
    expect(medFrame()!).toContain('70%');

    // Low confidence
    const lowAction = {
      id: 'a3',
      type: 'add_field',
      confidence: 0.4,
      reasoning: '',
      source: 'schema_evolution',
      payload: { field: { name: 'z', type: 'string', description: '' } },
    };
    const { lastFrame: lowFrame } = render(
      <ActionCard action={lowAction} index={0} total={1} />,
    );
    expect(lowFrame()!).toContain('40%');
  });

  it('shows risk level label (LOW/MEDIUM/HIGH)', () => {
    const lowRisk = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.9,
      reasoning: '',
      source: 'schema_evolution',
      payload: { field: { name: 'a', type: 'string', description: '' } },
    };
    const { lastFrame: lowFrame } = render(
      <ActionCard action={lowRisk} index={0} total={1} />,
    );
    expect(lowFrame()!).toContain('LOW');

    const medRisk = {
      id: 'a2',
      type: 'add_field',
      confidence: 0.7,
      reasoning: '',
      source: 'schema_evolution',
      payload: { field: { name: 'b', type: 'string', description: '' } },
    };
    const { lastFrame: medFrame } = render(
      <ActionCard action={medRisk} index={0} total={1} />,
    );
    expect(medFrame()!).toContain('MEDIUM');

    const highRisk = {
      id: 'a3',
      type: 'add_field',
      confidence: 0.4,
      reasoning: '',
      source: 'schema_evolution',
      payload: { field: { name: 'c', type: 'string', description: '' } },
    };
    const { lastFrame: highFrame } = render(
      <ActionCard action={highRisk} index={0} total={1} />,
    );
    expect(highFrame()!).toContain('HIGH');
  });
});
