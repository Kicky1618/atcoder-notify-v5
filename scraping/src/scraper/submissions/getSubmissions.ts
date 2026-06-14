import { Proxy } from '../../proxy/proxy';
import { AtCoderScraper } from '../atcoderScraper';
import * as cheerio from 'cheerio';
import { Element } from 'domhandler';
import { convertScraperSubmissionToPrismaSubmission } from './typeConverter';
import { Database } from '../../database';
import { AxiosError } from 'axios';
import { ScrapingState } from '../scrapingState';

let window = 1;
let timeout = 1000;
const submissionListeners = new Set<(sub: Submission) => void>();
export function addSubmissionListener(listener: (sub: Submission) => void) {
    submissionListeners.add(listener);
}
export async function CrawlAllSubmissions(contest: string): Promise<void> {
    return ScrapingState.run(`submissions:${contest}`, { contestId: contest }, () => new Promise<void>(async (resolve, reject) => {
        let page = 0;
        let isFinished = false;
        let isSettled = false;
        AtCoderScraper.logger.info(`Crawling submissions for contest ${contest}...`);

        try {
            const waitingJudges = new Set(
                (
                    await Database.getDatabase().submissions.findMany({
                        where: {
                            task: { contestid: contest },
                            status: {
                                in: ['WR', 'WJ'],
                            },
                            datetime: {
                                gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
                            },
                        },
                    })
                ).map((v) => v.submissionId),
            );
            AtCoderScraper.logger.info(`Get all waiting submissions...`);
            async function runWorker(workerId: number) {
                if (workerId >= window || isSettled) {
                    return;
                }
                const currentPage = ++page;
                try {
                    await ScrapingState.set(`submissions:${contest}`, 'running', {
                        contestId: contest,
                        page: currentPage,
                        waitingJudgeCount: waitingJudges.size,
                    });
                    const isFinishedFromWorker = await CrawlSubmissionWorker(contest, currentPage, waitingJudges);
                    if (isFinishedFromWorker && !isFinished) {
                        isFinished = true;
                        for (let submissionId of waitingJudges) {
                            const submissionData = await getSubmission(contest, submissionId.toString());
                            if (!submissionData) {
                                AtCoderScraper.logger.warn(`Submission ${submissionId} not found during final upsert`);
                                await Database.getDatabase().submissions.delete({
                                    where: {
                                        submissionId: submissionId,
                                    },
                                });
                                continue;
                            }
                            try {
                                await Database.getDatabase().user.upsert({
                                    where: { name: submissionData.username },
                                    create: { name: submissionData.username },
                                    update: {},
                                });

                                const prismaSubmission = await convertScraperSubmissionToPrismaSubmission(submissionData);

                                const beforeSubmission = await Database.getDatabase().submissions.findFirst({
                                    where: { submissionId: prismaSubmission.submissionId },
                                });

                                await Database.getDatabase().submissions.upsert({
                                    where: { submissionId: prismaSubmission.submissionId },
                                    create: prismaSubmission,
                                    update: prismaSubmission,
                                });

                                if (!beforeSubmission || beforeSubmission.status !== submissionData.status) {
                                    submissionListeners.forEach((listener) => listener(submissionData));
                                }
                                if (!beforeSubmission) {
                                    await Database.getDatabase().user.update({
                                        where: { name: submissionData.username },
                                        data: {
                                            userSubmissionCount: { increment: 1 }
                                        }
                                    })
                                }
                            } catch (e) {
                                AtCoderScraper.logger.error(`Failed to upsert submission ${submissionId} during finalization`, { error: e });
                            }
                        }
                        isSettled = true;
                        resolve();
                        return;
                    }
                    if (!isFinished) {
                        setTimeout(() => runWorker(workerId), timeout);
                    }
                } catch (error) {
                    isSettled = true;
                    reject(error);
                }
            }
            for (let i = 0; i < window; i++) {
                runWorker(i);
            }
        } catch (error) {
            reject(error);
        }
    }));
}
export function setWindow(newWindow: number) {
    if (newWindow < 1) {
        throw new Error('Window size must be at least 1');
    }
    window = newWindow;
    AtCoderScraper.logger.info(`Changed window size to ${window}`);
    void ScrapingState.set('submission_settings', 'success', { window, timeout });
}
export function setTimeoutValue(newTimeout: number) {
    if (newTimeout < 0) {
        throw new Error('Timeout must be at least 0');
    }
    timeout = newTimeout;
    AtCoderScraper.logger.info(`Changed timeout to ${timeout}`);
    void ScrapingState.set('submission_settings', 'success', { window, timeout });
}
async function CrawlSubmissionWorker(contest: string, page: number, waitingJudges: Set<bigint>): Promise<boolean> {
    const submissions = await getSubmissionPage(contest, page);
    if (submissions.length === 0) {
        return true;
    }
    const submissionIds = submissions.map((submission) => submission.submissionId);
    const existingSubmissions = await Database.getDatabase().submissions.findMany({
        where: {
            task: { contestid: contest },
            submissionId: { in: submissionIds },
        },
    });
    const existingSubmissionIds = new Set(existingSubmissions.map((submission) => submission.submissionId));
    const unknownSubmissions = submissions.filter((submission) => !existingSubmissionIds.has(submission.submissionId));
    for (const submission of submissions) {
        const prismaSubmission = await convertScraperSubmissionToPrismaSubmission(submission);
        try {
            await Database.getDatabase().user.upsert({
                where: { name: submission.username },
                create: { name: submission.username },
                update: {},
            });
            let beforeSubmission = await Database.getDatabase().submissions.findFirst({
                where: {
                    submissionId: submission.submissionId,
                },
            });
            await Database.getDatabase().submissions.upsert({
                where: {
                    submissionId: submission.submissionId,
                },
                create: prismaSubmission,
                update: prismaSubmission,
            });
            if (!beforeSubmission || beforeSubmission.status !== submission.status) {
                submissionListeners.forEach((listener) => listener(submission));
            }
        } catch (e) {
            AtCoderScraper.logger.error(`Failed to upsert submission ${submission.submissionId}`, {
                error: e,
            });
        }
        waitingJudges.delete(submission.submissionId);
    }
    if (unknownSubmissions.length == 0) {
        return true;
    }
    if (waitingJudges.size > 0) {
        return false;
    }
    return false;
}

export enum SubmissionStatus {
    AC = 'AC',
    WA = 'WA',
    TLE = 'TLE',
    MLE = 'MLE',
    RE = 'RE',
    CE = 'CE',
    QLE = 'QLE',
    OLE = 'OLE',
    IE = 'IE',
    WJ = 'WJ',
    WR = 'WR',
}
export type SubmissionWithTimeAndMemory = {
    status:
    | SubmissionStatus.AC
    | SubmissionStatus.WA
    | SubmissionStatus.TLE
    | SubmissionStatus.MLE
    | SubmissionStatus.RE
    | SubmissionStatus.QLE
    | SubmissionStatus.OLE;
    contestId: string;
    problemId: string;
    datetime: Date;
    username: string;
    language: string;
    score: number;
    codeLength: number;
    time: number;
    memory: number;
    submissionId: bigint;
};
export type SubmissionWithoutTimeAndMemory = {
    status: SubmissionStatus.CE | SubmissionStatus.WJ | SubmissionStatus.WR | SubmissionStatus.IE;
    contestId: string;
    problemId: string;
    datetime: Date;
    username: string;
    language: string;
    score: number;
    codeLength: number;
    submissionId: bigint;
};
export type Submission = SubmissionWithoutTimeAndMemory | SubmissionWithTimeAndMemory;

export async function getSubmissionPage(contest: string, page: number) {
    const url = `https://atcoder.jp/contests/${contest}/submissions?page=${page}`;
    const maxRetries = 50;
    let retryCount = 0;
    let response;
    while (retryCount < maxRetries) {
        try {
            response = await Proxy.get(url, AtCoderScraper.getCookie());
            if (response.status >= 500 && response.status < 600) {
                retryCount++;
                AtCoderScraper.logger.info(`Received ${response.status}, retrying attempt ${retryCount}/${maxRetries}`);
                continue;
            }
            break;
        } catch (e) {
            retryCount++;
            AtCoderScraper.logger.info(`Received Error, retrying attempt ${retryCount}/${maxRetries}`);
            if (e instanceof AxiosError) {
                if (e.response && e.response.status == 404) {
                    break;
                }
            }
            continue;
        }
    }
    if (!response || response.status !== 200) {
        AtCoderScraper.logger.error('Failed to fetch submission page', {
            status: response ? response.status : 'undefined',
        });
        return [];
    }
    const $ = cheerio.load(response.data);
    const rows = $('div.panel-submission table tbody tr').toArray();
    return rows.map((val) => analyzeSubmission(val));
}
/**
 * Helper to map status text to SubmissionStatus enum.
 */
export function parseSubmissionStatus(statusText: string): SubmissionStatus {
    const statusMapping: { [key: string]: SubmissionStatus } = {
        AC: SubmissionStatus.AC,
        WA: SubmissionStatus.WA,
        TLE: SubmissionStatus.TLE,
        MLE: SubmissionStatus.MLE,
        RE: SubmissionStatus.RE,
        QLE: SubmissionStatus.QLE,
        OLE: SubmissionStatus.OLE,
        CE: SubmissionStatus.CE,
        WJ: SubmissionStatus.WJ,
        WR: SubmissionStatus.WR,
    };
    const status = statusMapping[statusText];
    if (!status) {
        return SubmissionStatus.WJ;
    }
    return status;
}

/**
 * Parses submission details from a given table row element.
 */
export function analyzeSubmission(row: Element): Submission {
    // Load the row element into cheerio to allow DOM selection.
    const $ = cheerio.load(row);
    const cells = $('td').toArray();

    // Parse the common fields
    const datetime = new Date($(cells[0]).find('time').text().trim());

    const taskLink = $(cells[1]).find('a').attr('href') || '';
    const taskParts = taskLink.split('/');
    const contestId = taskParts[2];
    const problemId = taskParts[4];

    const userParts = $(cells[2]).find('a').first().attr('href') || '';
    const userId = userParts.split('/')[2];
    const language = $(cells[3]).find('a').text().trim();

    const score = Number($(cells[4]).text().trim());
    const submissionId = BigInt($(cells[4]).attr('data-id') || '0');

    const codeLengthText = $(cells[5]).text().trim();
    const codeLength = parseInt(codeLengthText.split(' ')[0], 10);

    const statusText = $(cells[6]).find('span').text().trim();
    const status = parseSubmissionStatus(statusText);

    // For submissions with CE, WJ or WR status
    if (status === SubmissionStatus.CE || status === SubmissionStatus.WJ || status === SubmissionStatus.WR || status === SubmissionStatus.IE) {
        return {
            status,
            contestId,
            problemId,
            datetime,
            username: userId,
            language,
            score,
            codeLength,
            submissionId,
        };
    } else {
        // For successful/failed submissions, parse additional fields.
        const timeText = $(cells[7]).text().match(/[\d]+/g)?.[0] || '-1';
        const time = parseInt(timeText, 10);
        const memoryText = $(cells[8]).text().match(/[\d]+/g)?.[0] || '-1';
        const memory = parseInt(memoryText, 10);
        return {
            status,
            contestId,
            problemId,
            datetime,
            username: userId,
            language,
            score,
            codeLength,
            time,
            memory,
            submissionId,
        };
    }
}
export async function getSubmission(contestId: string, submissionId: string) {
    const url = `https://atcoder.jp/contests/${contestId}/submissions/${submissionId}?lang=en`;

    let response;
    try {
        response = await Proxy.get(url, AtCoderScraper.getCookie());
    } catch (e) {
        AtCoderScraper.logger.error(`Network error while fetching submission ${submissionId}`, { error: e });
        if (e instanceof AxiosError && e.response?.status === 404) {
            return null;
        }
        return null;
    }

    if (!response || response.status !== 200) {
        AtCoderScraper.logger.error(`Failed to fetch submission ${submissionId}`, {
            status: response ? response.status : 'undefined',
        });
        return null;
    }

    const $ = cheerio.load(response.data);

    // Parse the submission info panel.
    const info: Partial<Submission> & { time?: number; memory?: number } = {};
    $('div.panel.panel-default table.table-bordered tr').each((_, row) => {
        const header = $(row).find('th').first().text().trim();
        const cell = $(row).find('td').first();
        switch (header) {
            case 'Submission Time': {
                // The time text is inside a <time> element.
                const timeText = cell.find('time').text().trim();
                if (timeText) {
                    const parsed = new Date(timeText);
                    if (!Number.isNaN(parsed.getTime())) {
                        info.datetime = parsed;
                    } else {
                        AtCoderScraper.logger.warn(`Unable to parse submission time for ${submissionId}`, { timeText });
                    }
                }
                break;
            }
            case 'Task': {
                // Example href: "/contests/dp/tasks/dp_i"
                const href = cell.find('a').attr('href') || '';
                const parts = href.split('/');
                info.contestId = parts[2] || contestId;
                info.problemId = parts[4] || '';
                break;
            }
            case 'User': {
                const href = cell.find('a').attr('href') || '';
                info.username = href.split('/')[2] || cell.text().trim();
                break;
            }
            case 'Language': {
                info.language = cell.text().trim();
                break;
            }
            case 'Score': {
                const n = Number(cell.text().trim());
                info.score = Number.isNaN(n) ? 0 : n;
                break;
            }
            case 'Code Size': {
                const parts = cell.text().trim().split(' ');
                const n = parseInt(parts[0], 10);
                info.codeLength = Number.isNaN(n) ? 0 : n;
                break;
            }
            case 'Status': {
                const statusText = cell.find('span').text().trim();
                info.status = parseSubmissionStatus(statusText);
                if (
                    !(
                        info.status === SubmissionStatus.CE ||
                        info.status === SubmissionStatus.WJ ||
                        info.status === SubmissionStatus.WR ||
                        info.status === SubmissionStatus.IE
                    )
                ) {
                    // For successful/failed submissions, try to parse additional fields defensively.
                    try {
                        const timeText = cell.next().find('td').text().match(/[\d]+/g)?.[0] || '0';
                        const timeParsed = parseInt(timeText, 10);
                        info.time = Number.isNaN(timeParsed) ? 0 : timeParsed;
                    } catch (err) {
                        AtCoderScraper.logger.warn(`Unable to parse time for submission ${submissionId}`, { error: err });
                        info.time = 0;
                    }
                    try {
                        const memoryText = cell.next().next().find('td').text().match(/[\d]+/g)?.[0] || '0';
                        const memParsed = parseInt(memoryText, 10);
                        info.memory = Number.isNaN(memParsed) ? 0 : memParsed;
                    } catch (err) {
                        AtCoderScraper.logger.warn(`Unable to parse memory for submission ${submissionId}`, { error: err });
                        info.memory = 0;
                    }
                }
                break;
            }
        }
    });

    // Ensure we have a valid status; default to WJ if missing.
    if (!info.status) {
        info.status = SubmissionStatus.WJ;
    }

    // Safely convert submissionId to BigInt
    let submissionIdBigInt: bigint;
    try {
        submissionIdBigInt = BigInt(submissionId);
    } catch (e) {
        AtCoderScraper.logger.error(`Invalid submissionId ${submissionId}`, { error: e });
        return null;
    }

    if (
        info.status === SubmissionStatus.CE ||
        info.status === SubmissionStatus.WJ ||
        info.status === SubmissionStatus.WR ||
        info.status === SubmissionStatus.IE
    ) {
        return {
            ...info,
            submissionId: submissionIdBigInt,
        } as SubmissionWithoutTimeAndMemory;
    } else {
        return {
            ...info,
            submissionId: submissionIdBigInt,
        } as SubmissionWithTimeAndMemory;
    }
}
