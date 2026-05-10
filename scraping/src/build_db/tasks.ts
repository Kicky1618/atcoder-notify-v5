import * as cheerio from 'cheerio';
import { Database } from '../database';
import { Proxy } from '../proxy/proxy';
import { AtCoderScraper } from '../scraper/atcoderScraper';

type RebuildTasksTableOptions = {
    contestIds?: string[];
};

let rebuildingTasksTable = false;

export async function rebuildTasksTable(options: RebuildTasksTableOptions = {}) {
    if (rebuildingTasksTable) {
        AtCoderScraper.logger?.info('Skipping tasks table rebuild because another rebuild is already running.');
        return;
    }

    rebuildingTasksTable = true;
    try {
        const db = Database.getDatabase();
        const now = new Date();
        const recentThreshold = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7);

        const contests = await db.contest.findMany({
            where: options.contestIds
                ? {
                    id: { in: options.contestIds },
                }
                : {
                    OR: [
                        { Tasks: { none: {} } },
                        {
                            startTime: { lte: now },
                            endTime: { gte: now },
                        },
                        { endTime: { gte: recentThreshold } },
                    ],
                },
            orderBy: { startTime: 'asc' },
            select: { id: true },
        });

        for (const contest of contests) {
            await rebuildContestTasks(contest.id);
        }
    } finally {
        rebuildingTasksTable = false;
    }
}

async function rebuildContestTasks(contestId: string) {
    const db = Database.getDatabase();
    const url = `https://atcoder.jp/contests/${contestId}/tasks?lang=en`;

    let response;
    try {
        response = await Proxy.get(url, AtCoderScraper.getCookie());
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 403 || status === 404) {
            AtCoderScraper.logger?.info(`Tasks page is not available yet for contest ${contestId}.`, { status });
            return;
        }
        AtCoderScraper.logger?.error(`Failed to fetch tasks page for contest ${contestId}.`, { error });
        return;
    }

    if (response.status !== 200) {
        AtCoderScraper.logger?.warn(`Unexpected status while fetching tasks page for contest ${contestId}.`, {
            status: response.status,
        });
        return;
    }

    const $ = cheerio.load(response.data);
    const taskIds = new Set<string>();
    $(`a[href^="/contests/${contestId}/tasks/"]`).each((_, element) => {
        const href = $(element).attr('href');
        const taskId = href?.split('/')[4];
        if (taskId) {
            taskIds.add(taskId);
        }
    });

    if (taskIds.size === 0) {
        AtCoderScraper.logger?.info(`No tasks found for contest ${contestId}.`);
        return;
    }

    const existingTasks = await db.tasks.findMany({
        where: {
            contestid: contestId,
            taskid: { in: [...taskIds] },
        },
        select: { taskid: true },
    });
    const existingTaskIds = new Set(existingTasks.map((task) => task.taskid));
    const missingTaskIds = [...taskIds].filter((taskId) => !existingTaskIds.has(taskId));

    if (missingTaskIds.length === 0) {
        return;
    }

    await db.tasks.createMany({
        data: missingTaskIds.map((taskId) => ({
            contestid: contestId,
            taskid: taskId,
        })),
    });
    AtCoderScraper.logger?.info(`Added ${missingTaskIds.length} tasks for contest ${contestId}.`);
}
