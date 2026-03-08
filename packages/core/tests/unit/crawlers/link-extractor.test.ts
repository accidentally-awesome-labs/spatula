import { describe, it, expect } from 'vitest';
import { extractLinks, resolveUrl } from '../../../src/crawlers/link-extractor.js';

describe('resolveUrl', () => {
  it('resolves relative URLs against base', () => {
    expect(resolveUrl('/products/123', 'https://example.com/page')).toBe(
      'https://example.com/products/123',
    );
  });

  it('returns absolute URLs unchanged', () => {
    expect(resolveUrl('https://other.com/page', 'https://example.com')).toBe(
      'https://other.com/page',
    );
  });

  it('resolves protocol-relative URLs', () => {
    expect(resolveUrl('//cdn.example.com/img.png', 'https://example.com')).toBe(
      'https://cdn.example.com/img.png',
    );
  });

  it('returns null for invalid URLs', () => {
    expect(resolveUrl('javascript:void(0)', 'https://example.com')).toBeNull();
  });

  it('returns null for mailto links', () => {
    expect(resolveUrl('mailto:test@test.com', 'https://example.com')).toBeNull();
  });

  it('returns null for tel links', () => {
    expect(resolveUrl('tel:+1234567890', 'https://example.com')).toBeNull();
  });

  it('strips hash fragments', () => {
    expect(resolveUrl('/page#section', 'https://example.com')).toBe(
      'https://example.com/page',
    );
  });
});

describe('extractLinks', () => {
  it('extracts links from anchor tags', () => {
    const html = `
      <html>
        <body>
          <a href="/products">Products</a>
          <a href="https://example.com/about">About Us</a>
          <a href="/contact" rel="nofollow">Contact</a>
        </body>
      </html>
    `;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(3);
    expect(links[0]).toEqual({
      url: 'https://example.com/products',
      text: 'Products',
      rel: undefined,
    });
    expect(links[1]).toEqual({
      url: 'https://example.com/about',
      text: 'About Us',
      rel: undefined,
    });
    expect(links[2]).toEqual({
      url: 'https://example.com/contact',
      text: 'Contact',
      rel: 'nofollow',
    });
  });

  it('deduplicates links by URL', () => {
    const html = `
      <a href="/page">Link 1</a>
      <a href="/page">Link 2</a>
    `;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('Link 1');
  });

  it('skips non-http links', () => {
    const html = `
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:x@y.com">Email</a>
      <a href="tel:123">Phone</a>
      <a href="/real-page">Real</a>
    `;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/real-page');
  });

  it('handles empty href gracefully', () => {
    const html = `<a href="">Empty</a><a>No href</a>`;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(0);
  });

  it('trims whitespace from link text', () => {
    const html = `<a href="/page">  Spaced Out  </a>`;
    const links = extractLinks(html, 'https://example.com');
    expect(links[0].text).toBe('Spaced Out');
  });
});
