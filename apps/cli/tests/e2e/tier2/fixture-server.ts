import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  LISTING_HTML, WIDGET_PRO_HTML, WIDGET_PRO_DELUXE_HTML, COMPARISON_HTML,
  PASTA_CARBONARA_HTML, ABOUT_HTML, BLOG_REVIEW_HTML, PAGE_2_HTML,
  SLOW_PAGE_HTML, ADMIN_HTML, ROBOTS_TXT,
} from './fixtures/pages.js';

export interface FixtureRequest {
  timestamp: number;
  method: string;
  path: string;
}

export interface FixtureServer {
  port: number;
  requestLog: FixtureRequest[];
  close(): Promise<void>;
  resetLog(): void;
}

const ROUTES: Record<string, { html?: string; status?: number; delay?: number; redirect?: string }> = {
  '/': { html: LISTING_HTML },
  '/products/widget-pro': { html: WIDGET_PRO_HTML },
  '/products/widget-pro-deluxe': { html: WIDGET_PRO_DELUXE_HTML },
  '/products/widget-pro/': { redirect: '/products/widget-pro', status: 301 },
  '/products/comparison': { html: COMPARISON_HTML },
  '/recipes/pasta-carbonara': { html: PASTA_CARBONARA_HTML },
  '/about': { html: ABOUT_HTML },
  '/blog/review': { html: BLOG_REVIEW_HTML },
  '/page/2': { html: PAGE_2_HTML },
  '/slow': { html: SLOW_PAGE_HTML, delay: 3000 },
  '/robots.txt': { html: ROBOTS_TXT },
  '/admin': { html: ADMIN_HTML },
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const requestLog: FixtureRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';
    requestLog.push({ timestamp: Date.now(), method: req.method ?? 'GET', path });

    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Not Found</h1></body></html>');
      return;
    }

    if (route.redirect) {
      res.writeHead(route.status ?? 301, { Location: route.redirect });
      res.end();
      return;
    }

    const sendResponse = () => {
      const contentType = path === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8';
      res.writeHead(route.status ?? 200, { 'Content-Type': contentType });
      res.end(route.html);
    };

    if (route.delay) {
      setTimeout(sendResponse, route.delay);
    } else {
      sendResponse();
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    port,
    requestLog,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    resetLog: () => { requestLog.length = 0; },
  };
}
