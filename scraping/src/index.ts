import { Logger } from './utils/logger';
import { FileTransport } from './utils/logger/transports/fileTransport';
import { LogLevel } from './utils/logger/types';
import { ConsoleTransport } from './utils/logger/transports/consoleTransport';
import { Database } from './database';
import { AtCoderScraper } from './scraper/atcoderScraper';
import { Proxy } from './proxy/proxy';
import http from 'http';
import { addSubmissionListener } from './scraper/submissions/getSubmissions';
import { config } from 'dotenv';
import path from 'path';
import { rebuildUsersTable } from './build_db/users';
import { rebuildTasksTable } from './build_db/tasks';
config({ path: path.join(__dirname, '../../.env') });

export namespace Main {
    let logger: Logger | null = null;
    let clients: Set<http.ServerResponse> = new Set();
    export async function init() {
        // Initialize the logger
        logger = new Logger();
        logger.addTransport(new FileTransport('./logs/[date].app.log', LogLevel.TRACE, {}));
        logger.addTransport(new ConsoleTransport(LogLevel.INFO));

        // Start Background tasks
        logger.info('Starting background tasks...');
        Proxy.initProxy(process.env.SOCK5_PROXY);
        await Database.initDatabase();

        await AtCoderScraper.initAtCoderScraper();
        addSubmissionListener((submission) => {
            clients.forEach((client) => {
                client.write('event: submission\n');
                client.write(
                    `data: ${JSON.stringify(submission, (key, value) => {
                        if (value instanceof Date) {
                            return value.toISOString();
                        }
                        if (typeof value === 'bigint') {
                            return value.toString();
                        }
                        return value;
                    })}\n\n`,
                );
            });
        });
        createProxyServer();
        logger.info('Background tasks started.');
    }
    export function sendEvent(event: string, data: any) {
        clients.forEach((client) => {
            client.write(`event: ${event}\n`);
            client.write(
                `data: ${JSON.stringify(data, (key, value) => {
                    if (value instanceof Date) {
                        return value.toISOString();
                    }
                    if (typeof value === 'bigint') {
                        return value.toString();
                    }
                    return value;
                })}\n\n`,
            );
        });
    }
    export function getLogger(): Logger {
        if (!logger) {
            throw new Error('Logger not initialized. Call init() first.');
        }
        return logger;
    }
    function createProxyServer() {
        const baseURL = 'https://atcoder.jp';
        const server = http.createServer((req, res) => {
            const url = new URL(req.url!, baseURL);
            if (req.method == 'GET') {
                if (url.pathname.startsWith('/api/')) {
                    const url = new URL(req.url!.slice(5), baseURL);
                    const get = Proxy.get(url.href, AtCoderScraper.getCookie());
                    get.then((response) => {
                        res.end(response.data);
                    }).catch((error) => {
                        logger?.error(`Error in GET request: ${error}`);
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Internal Server Error');
                    });
                } else if (url.pathname == '/sse/') {
                    res.setTimeout(Number.MAX_VALUE);
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                    });
                    res.flushHeaders();
                    res.write(': connected\n\n');
                    clients.add(res);
                    res.on('close', () => {
                        clients.delete(res);
                    });
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            } else {
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                res.end('Method Not Allowed');
            }
        });
        server.listen(process.env.PROXY_PORT);
    }
}

Main.init();
