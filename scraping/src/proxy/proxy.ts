import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import { Main } from '..';
import { Logger } from '../utils/logger';

export namespace Proxy {
    let SocksHTTPProxy: SocksProxyAgent | null = null;
    let logger: Logger;

    export function initProxy(url: string | undefined) {
        logger = Main.getLogger().child('Proxy');
        if (url) {
            SocksHTTPProxy = new SocksProxyAgent(url);
        }
    }
    export function get(url: string, cookie: string) {
        const agent = SocksHTTPProxy || undefined;
        if (agent) {
            logger.info('Using proxy', { url });
        } else {
            logger.info('Not using proxy', { url });
        }

        return axios.get(url, {
            proxy: false,
            httpsAgent: agent,
            headers: { 
                Cookie: cookie,
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
                'Accept': 'application/json,text/plain,*/*'
            },
            responseType: 'text'
        });
    }
    export function isProxyEnabled() {
        return SocksHTTPProxy !== null;
    }
}
