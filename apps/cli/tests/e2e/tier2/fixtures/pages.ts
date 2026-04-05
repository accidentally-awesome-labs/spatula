/**
 * HTML fixture pages for Tier 2 LLM pipeline integration tests.
 *
 * Each page uses a shared boilerplate (nav, footer, scripts) so that
 * HTML preprocessing (stripping nav/footer/scripts) is exercised.
 */

// ---------------------------------------------------------------------------
// Helper — wraps page-specific content in the shared boilerplate
// ---------------------------------------------------------------------------
function wrap(title: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title><script>var analytics = true;</script></head>
<body>
<nav><a href="/">Home</a> | <a href="/about">About</a> | <a href="/products/comparison">Compare</a></nav>
<main>
  ${content}
</main>
<footer>Copyright 2026 Acme Corp. <a href="https://twitter.com/spatula">Twitter</a></footer>
<script src="/analytics.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 1. Listing / home page
// ---------------------------------------------------------------------------
export const LISTING_HTML = wrap(
  'Acme Widgets',
  `<p>Welcome to Acme Widgets — browse our products and recipes.</p>
  <ul>
    <li><a href="/products/widget-pro">Widget Pro</a></li>
    <li><a href="/products/comparison">Product Comparison</a></li>
    <li><a href="/recipes/pasta-carbonara">Pasta Carbonara</a></li>
    <li><a href="/about">About Us</a></li>
    <li><a href="/blog/review">Widget Pro Review</a></li>
    <li><a href="/page/2">Next Page</a></li>
    <li><a href="https://twitter.com/spatula">Follow us on Twitter</a></li>
    <li><a href="/admin">Admin</a></li>
  </ul>`,
);

// ---------------------------------------------------------------------------
// 2. Widget Pro — product detail
// ---------------------------------------------------------------------------
export const WIDGET_PRO_HTML = wrap(
  'Widget Pro',
  `<h1>Widget Pro</h1>
  <img src="https://example.com/widget.jpg" alt="Widget Pro">
  <span class="price">$29.99</span>
  <p class="description">The finest widget money can buy.</p>
  <span class="brand">Acme</span>
  <a href="/products/widget-pro-deluxe">See the Deluxe version</a>`,
);

// ---------------------------------------------------------------------------
// 3. Widget Pro Deluxe — duplicate title for duplicate-detection tests
// ---------------------------------------------------------------------------
export const WIDGET_PRO_DELUXE_HTML = wrap(
  'Widget Pro',
  `<h1>Widget Pro</h1>
  <img src="https://example.com/widget-deluxe.jpg">
  <span class="price">$34.99</span>
  <p class="description">The premium deluxe widget.</p>
  <span class="brand">Acme</span>`,
);

// ---------------------------------------------------------------------------
// 4. Product comparison table
// ---------------------------------------------------------------------------
export const COMPARISON_HTML = wrap(
  'Product Comparison',
  `<h1>Product Comparison</h1>
  <table class="comparison">
    <thead><tr><th>Product</th><th>Price</th></tr></thead>
    <tbody>
      <tr><td>Widget A</td><td>$19.99</td></tr>
      <tr><td>Widget B</td><td>$24.99</td></tr>
      <tr><td>Widget C</td><td>$29.99</td></tr>
    </tbody>
  </table>`,
);

// ---------------------------------------------------------------------------
// 5. Recipe — Pasta Carbonara
// ---------------------------------------------------------------------------
export const PASTA_CARBONARA_HTML = wrap(
  'Pasta Carbonara',
  `<h1>Pasta Carbonara</h1>
  <span class="cook-time">25 min</span>
  <span class="servings">4</span>
  <span class="cuisine">Italian</span>
  <ul class="ingredients"><li>pasta</li><li>eggs</li><li>pecorino</li><li>guanciale</li></ul>`,
);

// ---------------------------------------------------------------------------
// 6. About page — no structured data
// ---------------------------------------------------------------------------
export const ABOUT_HTML = wrap(
  'About Acme Corp',
  `<h1>About Acme Corp</h1>
  <p>Acme Corp was founded in 1997 with a simple mission: build the best widgets
  in the world. Over the decades we have grown from a small garage operation into
  a global leader in widget innovation.</p>
  <p>Our team of 120 engineers, designers, and widget enthusiasts work tirelessly
  to push the boundaries of what a widget can be. We believe in quality,
  craftsmanship, and a relentless focus on the customer.</p>`,
);

// ---------------------------------------------------------------------------
// 7. Blog review — mixed content (data + opinion)
// ---------------------------------------------------------------------------
export const BLOG_REVIEW_HTML = wrap(
  'Widget Pro Review',
  `<h1>Widget Pro Review</h1>
  <p>After three weeks with the Widget Pro, I can confidently say it is one of the
  best widgets I have ever used. Priced at $29.99, the Widget Pro from Acme
  delivers outstanding value for money.</p>
  <p>The build quality is impeccable — you can feel the precision the moment you
  pick it up. I particularly love the matte finish and the satisfying click of
  the action button.</p>
  <p>That said, I wish it came in more colors. The all-black design is sleek but
  not for everyone. Overall, I would give the Widget Pro a solid 9 out of 10.</p>`,
);

// ---------------------------------------------------------------------------
// 8. Page 2 — second listing page
// ---------------------------------------------------------------------------
export const PAGE_2_HTML = wrap(
  'Products - Page 2',
  `<h1>Products - Page 2</h1>
  <p>More products coming soon.</p>
  <ul>
    <li><a href="/slow">Slow Widget</a></li>
  </ul>`,
);

// ---------------------------------------------------------------------------
// 9. Slow page — simple product
// ---------------------------------------------------------------------------
export const SLOW_PAGE_HTML = wrap(
  'Slow Widget',
  `<h1>Slow Widget</h1>
  <span class="price">$39.99</span>`,
);

// ---------------------------------------------------------------------------
// 10. Admin page — should never be served (disallowed by robots.txt)
// ---------------------------------------------------------------------------
export const ADMIN_HTML = wrap(
  'Admin Panel',
  `<h1>Admin Panel</h1>
  <p>Restricted area.</p>`,
);

// ---------------------------------------------------------------------------
// 11. robots.txt
// ---------------------------------------------------------------------------
export const ROBOTS_TXT = `User-agent: *\nDisallow: /admin\n`;
