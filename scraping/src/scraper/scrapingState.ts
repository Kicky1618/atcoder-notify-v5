import { Database } from '../database';

type ScrapingStateStatus = 'running' | 'success' | 'error' | 'skipped';

type ScrapingStatePayload = {
    key: string;
    status: ScrapingStateStatus;
    startedAt?: string;
    finishedAt?: string;
    updatedAt: string;
    error?: string;
    details?: Record<string, unknown>;
};

const PREFIX = 'scraping_state:';

function serializeError(error: unknown) {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

export namespace ScrapingState {
    export async function set(
        key: string,
        status: ScrapingStateStatus,
        details?: Record<string, unknown>,
        error?: unknown,
    ) {
        const now = new Date().toISOString();
        const payload: ScrapingStatePayload = {
            key,
            status,
            updatedAt: now,
            details,
        };
        if (status === 'running') {
            payload.startedAt = now;
        } else {
            payload.finishedAt = now;
        }
        if (error !== undefined) {
            payload.error = serializeError(error);
        }

        try {
            await Database.getDatabase().config.upsert({
                where: { key: PREFIX + key },
                create: {
                    key: PREFIX + key,
                    value: JSON.stringify(payload),
                },
                update: {
                    value: JSON.stringify(payload),
                },
            });
        } catch (stateError) {
            console.error(`Failed to update scraping state ${key}`, stateError);
        }
    }

    export function run<T>(
        key: string,
        details: Record<string, unknown> | undefined,
        task: () => Promise<T>,
    ): Promise<T> {
        return (async () => {
            await set(key, 'running', details);
            try {
                const result = await task();
                await set(key, 'success', details);
                return result;
            } catch (error) {
                await set(key, 'error', details, error);
                throw error;
            }
        })();
    }
}
