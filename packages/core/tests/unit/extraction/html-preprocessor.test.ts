import { describe, it, expect } from 'vitest';
import { preprocessHTML } from '../../../src/extraction/html-preprocessor.js';

describe('preprocessHTML', () => {
  it('extracts title from <title> tag', () => {
    const html = '<html><head><title>My Page</title></head><body><p>Hello</p></body></html>';
    const result = preprocessHTML(html);
    expect(result.title).toBe('My Page');
  });

  it('falls back to first h1 for title', () => {
    const html = '<html><body><h1>Main Heading</h1><p>Content</p></body></html>';
    const result = preprocessHTML(html);
    expect(result.title).toBe('Main Heading');
  });

  it('removes script tags', () => {
    const html = '<body><p>Keep</p><script>alert("remove")</script><p>Also keep</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('Keep');
    expect(result.content).toContain('Also keep');
    expect(result.content).not.toContain('alert');
  });

  it('removes style tags', () => {
    const html = '<body><style>.foo { color: red; }</style><p>Visible</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('Visible');
    expect(result.content).not.toContain('color');
  });

  it('removes noscript, svg, iframe, canvas tags', () => {
    const html = `<body>
      <noscript>No JS</noscript>
      <svg><rect/></svg>
      <iframe src="ad.html"></iframe>
      <canvas></canvas>
      <p>Real content</p>
    </body>`;
    const result = preprocessHTML(html);
    expect(result.content).toContain('Real content');
    expect(result.content).not.toContain('No JS');
    expect(result.content).not.toContain('rect');
  });

  it('preserves heading structure as markdown', () => {
    const html = '<body><h1>Title</h1><h2>Section</h2><h3>Sub</h3></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('## Section');
    expect(result.content).toContain('### Sub');
  });

  it('preserves list items', () => {
    const html = '<body><ul><li>Item A</li><li>Item B</li></ul></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('- Item A');
    expect(result.content).toContain('- Item B');
  });

  it('preserves table content as pipe-separated rows', () => {
    const html = `<body><table>
      <tr><th>Name</th><th>Price</th></tr>
      <tr><td>Widget</td><td>$10</td></tr>
    </table></body>`;
    const result = preprocessHTML(html);
    expect(result.content).toContain('Name');
    expect(result.content).toContain('Price');
    expect(result.content).toContain('Widget');
    expect(result.content).toContain('$10');
  });

  it('collapses excessive whitespace', () => {
    const html = '<body><p>Hello</p>\n\n\n\n\n<p>World</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).not.toMatch(/\n{3,}/);
  });

  it('estimates token count approximately', () => {
    const html = '<body><p>' + 'word '.repeat(100) + '</p></body>';
    const result = preprocessHTML(html);
    expect(result.estimatedTokens).toBeGreaterThan(50);
    expect(result.estimatedTokens).toBeLessThan(300);
  });

  it('truncates when exceeding maxTokens', () => {
    const longText = 'a'.repeat(10000);
    const html = `<body><p>${longText}</p></body>`;
    const result = preprocessHTML(html, { maxTokens: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[...truncated]');
    expect(result.content.length).toBeLessThan(3000);
  });

  it('does not truncate short content', () => {
    const html = '<body><p>Short content</p></body>';
    const result = preprocessHTML(html);
    expect(result.truncated).toBe(false);
    expect(result.content).not.toContain('[...truncated]');
  });

  it('handles empty body gracefully', () => {
    const html = '<html><head><title>Empty</title></head><body></body></html>';
    const result = preprocessHTML(html);
    expect(result.title).toBe('Empty');
    expect(result.content).toBe('');
    expect(result.estimatedTokens).toBe(0);
  });

  it('removes hidden elements', () => {
    const html = '<body><div hidden>Secret</div><p>Visible</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('Visible');
    expect(result.content).not.toContain('Secret');
  });
});
